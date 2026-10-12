import { changesResponseSchema, type ChangeEntry } from '@tephra/protocol';
import type { FileVersion } from '@tephra/vault-model';
import { fail } from '../http/errors.js';
import { ownedVault } from '../http/auth.js';
import type { ApiApp, ApiDependencies } from '../http/types.js';

/**
 * a file with an `.md` extension is markdown, everything else is an
 * attachment. This mirrors the plugin scanner's
 * `file.extension.toLowerCase() === 'md'` rule (there is no separate
 * blob-upload kind rule in this handler file); `file_versions` rows carry
 * no kind column, so the path is the only signal available.
 */
function changesKindForPath(path: string): 'markdown' | 'attachment' {
  const base = path.split('/').at(-1) ?? path;
  const dot = base.lastIndexOf('.');
  return dot >= 0 && base.slice(dot + 1).toLowerCase() === 'md'
    ? 'markdown'
    : 'attachment';
}

export function registerChangesRoutes(app: ApiApp, dependencies: ApiDependencies): void {
  // Pull feed (plan 017, Phase 4): projects the append-only file_versions
  // ledger forward from an exclusive revision cursor. Tombstone (delete)
  // rows are emitted like any other row — the query deliberately does not
  // join vault_files, so deleted files still appear. Metadata-only: no
  // vault:write here by intent, and only ids/revision counts enter the logs.
  app.get('/api/v1/vaults/:vaultId/changes', async (c) => {
    const vault = await ownedVault(c, dependencies, 'vault:read-metadata');
    const latestRevision = vault.latestRevision;
    const rawSince = c.req.query('sinceRevision');
    const rawLimit = c.req.query('limit');
    if (rawSince === undefined || rawSince.length === 0)
      fail(400, 'INVALID_MANIFEST', 'A sinceRevision query parameter is required.');
    const sinceRevision = Number(rawSince);
    if (!Number.isSafeInteger(sinceRevision) || sinceRevision < 0)
      fail(400, 'INVALID_MANIFEST', 'sinceRevision must be a non-negative integer.');
    let limit = 200;
    if (rawLimit !== undefined && rawLimit.length > 0) {
      const parsed = Number(rawLimit);
      if (!Number.isSafeInteger(parsed) || parsed <= 0)
        fail(400, 'INVALID_MANIFEST', 'limit must be a positive integer.');
      limit = Math.min(parsed, 500);
    }
    Object.assign(c.get('logContext'), { vault_id: vault.id, from_revision: sinceRevision });
    // Client ahead of the server: impossible in a correct walk, but the
    // only safe answer is a full resync rather than an empty page.
    if (sinceRevision > latestRevision)
      return c.json({ status: 'full-resync-required', latestRevision });
    // One emitted entry covers at most two rows (rename + modify at the
    // same revision), so 2*limit+1 rows prove whether more entries remain.
    const rows = await dependencies.database.fileVersions.listSince(
      vault.id,
      sinceRevision,
      2 * limit + 1,
    );
    // Group rows by (fileId, revision), preserving revision-ASC order.
    const groups: Array<{ fileId: string; revision: number; rows: FileVersion[] }> = [];
    for (const row of rows) {
      const last = groups.at(-1);
      if (last !== undefined && last.fileId === row.fileId && last.revision === row.revision)
        last.rows.push(row);
      else groups.push({ fileId: row.fileId, revision: row.revision, rows: [row] });
    }
    const truncated = groups.length > limit;
    const page = truncated ? groups.slice(0, limit) : groups;
    // Rename entries need the path the file had before this revision. The
    // row itself only carries the new path, so resolve the latest earlier
    // row for the file (bounded: at most one lookup per renamed file).
    const previousPaths = new Map<string, string>();
    for (const group of page) {
      if (!group.rows.some((row) => row.changeType === 'rename')) continue;
      const history = await dependencies.database.fileVersions.listByFile(vault.id, group.fileId);
      const previous = history
        .filter((row) => row.revision < group.revision)
        .sort((left, right) => right.revision - left.revision)[0];
      if (previous !== undefined && previous.path !== group.rows.at(-1)?.path)
        previousPaths.set(group.fileId, previous.path);
    }
    const changes: ChangeEntry[] = page.map((group) => {
      const lastRow = group.rows.at(-1)!;
      const types = new Set(group.rows.map((row) => row.changeType));
      const changeType: ChangeEntry['changeType'] = types.has('delete')
        ? 'delete'
        : types.has('create')
          ? 'create'
          : types.has('rename')
            ? 'rename'
            : 'modify';
      const previousPath = previousPaths.get(group.fileId);
      return {
        fileId: group.fileId,
        changeType,
        path: lastRow.path,
        ...(previousPath === undefined ? {} : { previousPath }),
        // Tombstones carry no blob: blobHash/size/mtime stay absent.
        ...(changeType === 'delete' || lastRow.blobHash === null
          ? {}
          : {
              blobHash: lastRow.blobHash,
              ...(lastRow.size === null ? {} : { size: lastRow.size }),
              ...(lastRow.mtime === null ? {} : { mtime: lastRow.mtime }),
            }),
        kind: changesKindForPath(lastRow.path),
        revision: group.revision,
      };
    });
    const toRevision = page.length > 0 ? page.at(-1)!.revision : latestRevision;
    Object.assign(c.get('logContext'), {
      to_revision: toRevision,
      change_count: changes.length,
      truncated,
    });
    return c.json(
      changesResponseSchema.parse({
        status: 'ok',
        fromRevision: sinceRevision,
        toRevision,
        latestRevision,
        truncated,
        changes,
      }),
    );
  });
}
