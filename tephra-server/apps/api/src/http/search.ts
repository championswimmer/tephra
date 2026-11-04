import { fileDto } from './dto.js';
import type { ApiDependencies } from './types.js';

/** Shared note search used by the REST search route and the MCP `search_notes` tool. */
export async function searchVault(
  dependencies: ApiDependencies,
  vaultId: string,
  query: string,
  limit: number,
): Promise<unknown[]> {
  if (dependencies.indexService?.search)
    return dependencies.indexService.search({ vaultId, query, limit });
  const needle = query.toLocaleLowerCase();
  return (await dependencies.database.vaultFiles.listByVault(vaultId))
    .filter((file) => file.path.toLocaleLowerCase().includes(needle))
    .slice(0, limit)
    .map(fileDto);
}
