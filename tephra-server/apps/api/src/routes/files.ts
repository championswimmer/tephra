import { z } from 'zod';
import { isCanonicalVaultPath } from '@tephra/protocol';
import type { CurrentVaultFile } from '@tephra/vault-model';
import { fail } from '../http/errors.js';
import { ownedVault } from '../http/auth.js';
import { fileDto } from '../http/dto.js';
import type { ApiApp, ApiDependencies, AppContext } from '../http/types.js';

export function registerFileRoutes(app: ApiApp, dependencies: ApiDependencies): void {
  const listFiles = async (c: AppContext) => {
    const vault = await ownedVault(c, dependencies, 'vault:read-metadata');
    const files = await dependencies.database.vaultFiles.listByVault(vault.id);
    return c.json({ revision: vault.latestRevision, files: files.map(fileDto) });
  };
  app.get('/api/v1/vaults/:vaultId/files', listFiles);
  app.get('/api/v1/vaults/:vaultId/tree', listFiles);
  app.get('/api/v1/vaults/:vaultId/search', async (c) => {
    const vault = await ownedVault(c, dependencies, 'vault:read-metadata');
    const query = z.string().trim().min(1).max(200).parse(c.req.query('q'));
    const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 100);
    const results = dependencies.indexService?.search
      ? await dependencies.indexService.search({ vaultId: vault.id, query, limit })
      : (await dependencies.database.vaultFiles.listByVault(vault.id))
          .filter((file) => file.path.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
          .slice(0, limit)
          .map(fileDto);
    return c.json({ revision: vault.latestRevision, results });
  });

  const findFile = async (c: AppContext): Promise<CurrentVaultFile> => {
    const vault = await ownedVault(c, dependencies, 'vault:read-metadata');
    const fileId = z.string().min(1).parse(c.req.param('fileId'));
    const file = await dependencies.database.vaultFiles.findById(vault.id, fileId);
    if (!file) fail(404, 'VAULT_NOT_FOUND', 'File was not found.');
    return file;
  };
  app.get('/api/v1/vaults/:vaultId/resolve', async (c) => {
    const vault = await ownedVault(c, dependencies, 'vault:read-metadata');
    const raw = c.req.query('path');
    if (raw === undefined || raw.length === 0) fail(400, 'INVALID_PATH', 'A path query parameter is required.');
    const requestedPath = raw;
    const normalized = requestedPath.normalize('NFC');
    if (!isCanonicalVaultPath(normalized)) fail(400, 'INVALID_PATH', 'Path must be a canonical vault-relative path.');
    const respond = (match: string, file: CurrentVaultFile, extra: Record<string, unknown> = {}) => {
      Object.assign(c.get('logContext'), { path_resolved: true, resolve_match: match });
      return c.json({ match, requestedPath, canonicalPath: file.path, file: fileDto(file), ...extra });
    };
    if (requestedPath !== normalized) {
      const exact = await dependencies.database.vaultFiles.findByPath(vault.id, requestedPath);
      if (exact) return respond('exact', exact);
    }
    const current = await dependencies.database.vaultFiles.findByPath(vault.id, normalized);
    if (current) return respond(requestedPath === normalized ? 'exact' : 'normalized', current);
    const folded = await dependencies.database.vaultFiles.findByPathFold(vault.id, normalized.toLowerCase());
    if (folded.length === 1) return respond('case', folded[0]!);
    if (folded.length > 1) {
      Object.assign(c.get('logContext'), { path_resolved: true, resolve_match: 'ambiguous' });
      return c.json(
        { error: { code: 'AMBIGUOUS_PATH', message: 'Multiple files match this path.' }, candidates: folded.map(fileDto) },
        409,
      );
    }
    const historic = await dependencies.database.fileVersions.findLatestByPath(vault.id, normalized);
    if (historic) {
      const file = await dependencies.database.vaultFiles.findById(vault.id, historic.fileId);
      if (file) {
        if (file.path === normalized) return respond('exact', file);
        return respond('historic', file, { movedFromPath: historic.path, movedAtRevision: historic.revision });
      }
      Object.assign(c.get('logContext'), { path_resolved: true, resolve_match: 'deleted' });
      return c.json({ error: { code: 'FILE_DELETED', message: 'File was deleted.' } }, 410);
    }
    fail(404, 'VAULT_NOT_FOUND', 'File was not found.');
  });
  app.get('/api/v1/vaults/:vaultId/files/:fileId', async (c) =>
    c.json({ file: fileDto(await findFile(c)) }),
  );
  const rawContent = async (c: AppContext): Promise<Response> => {
    const file = await findFile(c);
    const blob = await dependencies.blobStore.get(file.blobHash);
    if (!blob) fail(404, 'BLOB_MISSING', 'File content is missing.');
    const contentType =
      file.mimeType ??
      (file.kind === 'markdown' ? 'text/markdown; charset=utf-8' : 'application/octet-stream');
    const forceDownload = /^(?:text\/html|application\/xhtml\+xml|image\/svg\+xml)(?:;|$)/i.test(
      contentType,
    );
    return new Response(blob.bytes, {
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(blob.size),
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': 'sandbox',
        ...(forceDownload
          ? {
              'Content-Disposition': `attachment; filename="${encodeURIComponent(file.path.split('/').at(-1) ?? 'attachment')}"`,
            }
          : {}),
      },
    });
  };
  app.get('/api/v1/vaults/:vaultId/files/:fileId/content', rawContent);
  app.get('/api/v1/vaults/:vaultId/files/:fileId/raw', rawContent);
  app.get('/api/v1/vaults/:vaultId/attachments/:fileId', rawContent);
  app.get('/api/v1/vaults/:vaultId/files/:fileId/rendered', async (c) => {
    const file = await findFile(c);
    if (file.kind !== 'markdown')
      fail(400, 'INVALID_MANIFEST', 'Only Markdown files can be rendered.');
    if (!dependencies.indexService?.renderMarkdown)
      fail(503, 'INDEX_PENDING', 'Markdown rendering is not available.');
    const blob = await dependencies.blobStore.get(file.blobHash);
    if (!blob) fail(404, 'BLOB_MISSING', 'File content is missing.');
    const markdown = await new Response(blob.bytes).text();
    return c.json(
      await dependencies.indexService.renderMarkdown({
        vaultId: file.vaultId,
        fileId: file.fileId,
        markdown,
      }),
    );
  });
  app.get('/api/v1/vaults/:vaultId/files/:fileId/links', async (c) =>
    c.json({
      links: await dependencies.database.noteIndex.listLinksBySource(
        (await ownedVault(c, dependencies, 'vault:read-metadata')).id,
        (await findFile(c)).fileId,
      ),
    }),
  );
  app.get('/api/v1/vaults/:vaultId/files/:fileId/backlinks', async (c) =>
    c.json({
      links: await dependencies.database.noteIndex.listLinksByTarget(
        (await ownedVault(c, dependencies, 'vault:read-metadata')).id,
        (await findFile(c)).fileId,
      ),
    }),
  );
  app.get('/api/v1/vaults/:vaultId/links', async (c) =>
    c.json({
      links: await dependencies.database.noteIndex.listLinks(
        (await ownedVault(c, dependencies, 'vault:read-metadata')).id,
      ),
    }),
  );
}
