import type { BlobStore } from '@tephra/blob-store-core';
import type { Clock, IdGenerator } from '@tephra/core';
import type { Database } from '@tephra/database-core';
import { buildGraphPayload, buildIndexRows } from '@tephra/indexer';
import { createVaultPathIndex, resolveLink } from '@tephra/link-resolver';
import { parseNote, renderMarkdown } from '@tephra/markdown';

import type { IndexService } from './app';

export function createRuntimeIndexService(dependencies: {
  database: Database;
  blobStore: BlobStore;
  clock: Clock;
  ids: IdGenerator;
}): IndexService {
  // The graph payload is pure derived state of the index inputs: rebuild the
  // materialized cache row for the revision that just committed. Failures
  // here must never fail the index itself — the next graph request rebuilds
  // on a cache miss — so refresh errors delete the row and stay silent.
  const refreshGraphCache = async (vaultId: string, indexedRevision: number): Promise<void> => {
    try {
      const vault = await dependencies.database.vaults.findById(vaultId);
      if (!vault) return;
      const [files, metadataRows, links] = await Promise.all([
        dependencies.database.vaultFiles.listByVault(vaultId),
        dependencies.database.noteIndex.listMetadata(vaultId),
        dependencies.database.noteIndex.listLinks(vaultId),
      ]);
      const etag = `W/"${vault.latestRevision}-${indexedRevision}-graph-v2"`;
      await dependencies.database.graphCache.upsert({
        vaultId,
        revision: vault.latestRevision,
        indexedRevision,
        etag,
        payloadJson: JSON.stringify(
          buildGraphPayload({ files, metadataRows, links, latestRevision: vault.latestRevision, indexedRevision }),
        ),
        updatedAt: dependencies.clock.now(),
      });
    } catch {
      await dependencies.database.graphCache.deleteByVault(vaultId).catch(() => undefined);
    }
  };

  const indexVault = async (vaultId: string, revision: number): Promise<void> => {
    try {
      const files = await dependencies.database.vaultFiles.listByVault(vaultId);
      const notes = [];
      for (const file of files) {
        if (file.kind !== 'markdown') continue;
        const blob = await dependencies.blobStore.get(file.blobHash);
        if (!blob) throw new Error(`Missing Markdown blob ${file.blobHash}`);
        notes.push({ fileId: file.fileId, parsed: parseNote(await new Response(blob.bytes).text()) });
      }
      const rows = buildIndexRows({
        vaultId,
        files,
        notes,
        indexedAt: dependencies.clock.now(),
        generateId: () => dependencies.ids.generate(),
      });
      await dependencies.database.transaction(async (repositories) => {
        const currentMarkdownIds = new Set(files.filter((file) => file.kind === 'markdown').map((file) => file.fileId));
        for (const metadata of await repositories.noteIndex.listMetadata(vaultId)) {
          if (!currentMarkdownIds.has(metadata.fileId)) await repositories.noteIndex.deleteMetadata(metadata.fileId);
        }
        for (const metadata of rows.metadata) {
          await repositories.noteIndex.upsertMetadata(metadata);
          await repositories.noteIndex.replaceLinksForSource(
            vaultId,
            metadata.fileId,
            rows.links.filter((link) => link.sourceFileId === metadata.fileId),
          );
        }
        await repositories.noteIndex.setState({ vaultId, indexedRevision: revision, lastError: null });
      });
      await refreshGraphCache(vaultId, revision);
    } catch (error) {
      // Never serve a graph built from a superseded or failed index
      // revision: drop the row so the next request rebuilds from scratch.
      await dependencies.database.graphCache.deleteByVault(vaultId).catch(() => undefined);
      await dependencies.database.noteIndex.setState({
        vaultId,
        indexedRevision: Math.max(0, revision - 1),
        lastError: error instanceof Error ? error.message.slice(0, 1_000) : 'Indexing failed',
      });
      throw error;
    }
  };

  return {
    indexVault,
    async renderMarkdown({ vaultId, fileId, markdown }) {
      const files = await dependencies.database.vaultFiles.listByVault(vaultId);
      const source = files.find((file) => file.fileId === fileId);
      if (!source) throw new Error('Markdown source file is not current');
      const vaultIndex = createVaultPathIndex(files);
      return renderMarkdown({
        markdown,
        sourcePath: source.path,
        vaultIndex,
        resolveLink: (sourcePath, linkPath) => resolveLink(sourcePath, linkPath, vaultIndex),
        attachmentUrl: (targetFileId) => `/api/v1/vaults/${encodeURIComponent(vaultId)}/attachments/${encodeURIComponent(targetFileId)}`,
      });
    },
    async search({ vaultId, query, limit }) {
      const normalized = query.trim().toLocaleLowerCase();
      if (!normalized) return [];
      const files = await dependencies.database.vaultFiles.listByVault(vaultId);
      const metadata = new Map((await dependencies.database.noteIndex.listMetadata(vaultId)).map((row) => [row.fileId, row]));
      return files
        .filter((file) => file.path.toLocaleLowerCase().includes(normalized) || metadata.get(file.fileId)?.title?.toLocaleLowerCase().includes(normalized))
        .slice(0, limit)
        .map((file) => ({ ...file, title: metadata.get(file.fileId)?.title ?? null }));
    },
  };
}
