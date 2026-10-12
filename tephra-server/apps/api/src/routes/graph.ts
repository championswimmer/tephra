import { buildGraphPayload } from '@tephra/indexer';
import { ownedVault } from '../http/auth.js';
import type { ApiApp, ApiDependencies } from '../http/types.js';

export function registerGraphRoutes(app: ApiApp, dependencies: ApiDependencies): void {
  // Graph payload v2 (plan 011): markdown notes plus synthesized attachment,
  // tag, and unresolved-link nodes; edges reference nodes by array index to
  // keep the payload small at ~30k edges. Pure derived state, so the response
  // carries an ETag keyed by vault + index revision.
  app.get('/api/v1/vaults/:vaultId/graph', async (c) => {
    const vault = await ownedVault(c, dependencies, 'vault:read-metadata');
    const indexState = await dependencies.database.noteIndex.getState(vault.id);
    const indexedRevision = indexState?.indexedRevision ?? 0;
    const etag = `W/"${vault.latestRevision}-${indexedRevision}-graph-v2"`;
    c.header('ETag', etag);
    if (c.req.header('if-none-match') === etag) return c.body(null, 304);

    const cached = await dependencies.database.graphCache.find(vault.id);
    if (
      cached !== null &&
      cached.revision === vault.latestRevision &&
      cached.indexedRevision === indexedRevision
    )
      return c.json(JSON.parse(cached.payloadJson) as Record<string, unknown>);

    const [files, metadataRows, links] = await Promise.all([
      dependencies.database.vaultFiles.listByVault(vault.id),
      dependencies.database.noteIndex.listMetadata(vault.id),
      dependencies.database.noteIndex.listLinks(vault.id),
    ]);
    const payload = buildGraphPayload({
      files,
      metadataRows,
      links,
      latestRevision: vault.latestRevision,
      indexedRevision,
    });
    await dependencies.database.graphCache.upsert({
      vaultId: vault.id,
      revision: vault.latestRevision,
      indexedRevision,
      etag,
      payloadJson: JSON.stringify(payload),
      updatedAt: dependencies.clock.now(),
    });
    return c.json(payload);
  });

}
