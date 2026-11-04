import { z } from 'zod';
import { canAccessVault } from '@tephra/auth';
import { isCanonicalVaultPath } from '@tephra/protocol';
import type { ApiTokenScope, CurrentVaultFile, Vault } from '@tephra/vault-model';
import { authenticate, bearer, findVaultByIdOrName } from '../http/auth.js';
import { ApiFailure } from '../http/errors.js';
import { mcpChallenge } from '../oauth/server.js';
import { searchVault } from '../http/search.js';
import type { ApiApp, ApiDependencies } from '../http/types.js';
import { commitNote } from './commit.js';
import { applyUnifiedDiff, PatchError } from './patch.js';

const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'tephra', version: '0.1.0' };
const INSTRUCTIONS =
  'Tephra stores Obsidian Markdown vaults. Use search_notes to find notes, read_note to fetch one, create_note to add one, ' +
  'and update_note (unified diff patch or full content) to edit. Always pass the blobHash from read_note as baseHash when editing.';

class ToolError extends Error {}

const vaultField = z
  .string()
  .optional()
  .describe('Vault id or name. Optional when the API token is bound to a single vault.');
const pathField = z.string().min(1).describe('Vault-relative note path, e.g. "Projects/Plan.md".');

const tools = {
  list_vaults: {
    description: 'List the vaults this credential can access.',
    scope: 'vault:read-metadata' as ApiTokenScope,
    input: z.object({}),
  },
  search_notes: {
    description:
      'Search notes in a vault by path or title (case-insensitive substring). Returns path, fileId, blobHash and title.',
    scope: 'vault:read-metadata' as ApiTokenScope,
    input: z.object({
      vault: vaultField,
      query: z.string().trim().min(1).max(200).describe('Text to look for in note paths/titles.'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 20).'),
    }),
  },
  read_note: {
    description:
      'Fetch a Markdown note. Returns its content, blobHash (pass it as baseHash when editing) and the vault revision.',
    scope: 'vault:read-metadata' as ApiTokenScope,
    input: z.object({ vault: vaultField, path: pathField }),
  },
  create_note: {
    description:
      'Create a new Markdown note (path must end in .md and must not already exist; parent folders are implicit). Creates one vault revision.',
    scope: 'vault:write' as ApiTokenScope,
    input: z.object({
      vault: vaultField,
      path: pathField,
      content: z.string().describe('Full Markdown content of the new note.'),
    }),
  },
  update_note: {
    description:
      'Edit an existing Markdown note. Provide exactly one of `patch` (unified diff with "@@ -a,b +c,d @@" hunks; context and removed lines must match the current note exactly) ' +
      'or `content` (full replacement). `baseHash` (from read_note) is required with `content` and optional with `patch`. On conflict, re-read the note and retry.',
    scope: 'vault:write' as ApiTokenScope,
    input: z.object({
      vault: vaultField,
      path: pathField,
      patch: z.string().min(1).optional().describe('Unified diff to apply to the current note.'),
      content: z.string().optional().describe('Complete new content for the note.'),
      baseHash: z
        .string()
        .optional()
        .describe('blobHash of the version the edit is based on (from read_note).'),
    }),
  },
};
type ToolName = keyof typeof tools;

type Principal = Awaited<ReturnType<typeof authenticate>>;
interface Rpc {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: unknown;
}

async function resolveVault(
  dependencies: ApiDependencies,
  principal: Principal,
  requested: string | undefined,
  scope: ApiTokenScope,
): Promise<Vault> {
  let vault: Vault | null = null;
  if (requested !== undefined) {
    vault = await findVaultByIdOrName(dependencies.database.vaults, requested);
  } else if (principal.kind === 'token') {
    const tokenVaultId = principal.token.vaultId;
    vault = tokenVaultId === null ? null : await dependencies.database.vaults.findById(tokenVaultId);
  } else {
    const owned = await dependencies.database.vaults.listByOwner(principal.user.id);
    if (owned.length === 1) vault = owned[0]!;
    else throw new ToolError('Several vaults exist; pass the `vault` argument (see list_vaults).');
  }
  if (vault === null || !canAccessVault(principal, vault, scope))
    // Same message for missing and forbidden so vault existence is not leaked.
    throw new ToolError('Vault not found or access denied (check token vault and scopes).');
  return vault;
}

async function findNote(
  dependencies: ApiDependencies,
  vault: Vault,
  rawPath: string,
): Promise<CurrentVaultFile> {
  const path = rawPath.normalize('NFC');
  const files = dependencies.database.vaultFiles;
  const exact = await files.findByPath(vault.id, path);
  const found =
    exact ??
    (await (async () => {
      const folded = await files.findByPathFold(vault.id, path.toLowerCase());
      if (folded.length > 1) throw new ToolError(`Path "${rawPath}" is ambiguous (case variants exist).`);
      return folded[0] ?? null;
    })());
  if (found === null) throw new ToolError(`Note "${rawPath}" was not found.`);
  if (found.kind !== 'markdown') throw new ToolError(`"${found.path}" is not a Markdown note.`);
  return found;
}

async function readText(dependencies: ApiDependencies, file: CurrentVaultFile): Promise<string> {
  const blob = await dependencies.blobStore.get(file.blobHash);
  if (!blob) throw new ToolError('Note content is missing from the blob store.');
  return new Response(blob.bytes).text();
}

const meta = (file: CurrentVaultFile) => ({
  path: file.path,
  fileId: file.fileId,
  blobHash: file.blobHash,
  size: file.size,
  mtime: file.mtime,
});

async function callTool(
  dependencies: ApiDependencies,
  principal: Principal,
  name: ToolName,
  rawArgs: unknown,
): Promise<unknown> {
  const spec = tools[name];
  const parsed = spec.input.safeParse(rawArgs ?? {});
  if (!parsed.success)
    throw new ToolError(`Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ')}`);
  const args = parsed.data as Record<string, any>;

  if (name === 'list_vaults') {
    const vaults =
      principal.kind === 'token'
        ? [principal.token.vaultId === null ? null : await dependencies.database.vaults.findById(principal.token.vaultId)]
        : await dependencies.database.vaults.listByOwner(principal.user.id);
    return {
      vaults: vaults
        .filter((v): v is Vault => v !== null && canAccessVault(principal, v, spec.scope))
        .map((v) => ({ id: v.id, name: v.name, latestRevision: v.latestRevision })),
    };
  }
  const vault = await resolveVault(dependencies, principal, args.vault, spec.scope);

  switch (name) {
    case 'search_notes': {
      const results = await searchVault(dependencies, vault.id, args.query, args.limit ?? 20);
      return { revision: vault.latestRevision, results };
    }
    case 'read_note': {
      const file = await findNote(dependencies, vault, args.path);
      return { ...meta(file), revision: vault.latestRevision, content: await readText(dependencies, file) };
    }
    case 'create_note': {
      const path = (args.path as string).normalize('NFC');
      if (!isCanonicalVaultPath(path) || !/\.md$/i.test(path))
        throw new ToolError('path must be a canonical vault-relative path ending in ".md".');
      const result = await commitNote(dependencies, {
        vault,
        userId: principal.user.id,
        plan: { kind: 'create', path },
        text: args.content,
      });
      if (result.status === 'exists')
        throw new ToolError(`A file already exists at "${result.current.path}". Use update_note to edit it.`);
      if (result.status === 'conflict') throw new ToolError('Unexpected conflict.');
      return { status: result.status, revision: result.revision, ...meta(result.file) };
    }
    case 'update_note': {
      if ((args.patch === undefined) === (args.content === undefined))
        throw new ToolError('Provide exactly one of `patch` or `content`.');
      if (args.content !== undefined && args.baseHash === undefined)
        throw new ToolError('`baseHash` (from read_note) is required when replacing full `content`.');
      const file = await findNote(dependencies, vault, args.path);
      if (args.baseHash !== undefined && args.baseHash !== file.blobHash)
        throw new ToolError(
          `Edit conflict: the note changed since it was read (current blobHash ${file.blobHash}). Re-read it and retry.`,
        );
      let text: string = args.content ?? '';
      if (args.patch !== undefined) {
        try {
          text = applyUnifiedDiff(await readText(dependencies, file), args.patch);
        } catch (error) {
          if (error instanceof PatchError) throw new ToolError(error.message);
          throw error;
        }
      }
      const result = await commitNote(dependencies, {
        vault,
        userId: principal.user.id,
        plan: { kind: 'update', fileId: file.fileId, baseHash: file.blobHash },
        text,
      });
      if (result.status === 'conflict')
        throw new ToolError('Edit conflict: the note changed while saving. Re-read it and retry.');
      if (result.status === 'exists') throw new ToolError('Unexpected path clash.');
      return { status: result.status, revision: result.revision, ...meta(result.file) };
    }
  }
}

function rpcError(id: Rpc['id'], code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

async function handle(
  dependencies: ApiDependencies,
  principal: Principal,
  message: Rpc,
): Promise<unknown | null> {
  if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string')
    return rpcError(message?.id, -32600, 'Invalid JSON-RPC request.');
  const isNotification = !('id' in message);
  const params = (message.params ?? {}) as Record<string, unknown>;
  const ok = (result: unknown) => (isNotification ? null : { jsonrpc: '2.0', id: message.id, result });
  switch (message.method) {
    case 'initialize': {
      const wanted = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return ok({
        protocolVersion: SUPPORTED_VERSIONS.includes(wanted) ? wanted : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({
        tools: Object.entries(tools).map(([name, spec]) => ({
          name,
          description: spec.description,
          inputSchema: z.toJSONSchema(spec.input),
        })),
      });
    case 'tools/call': {
      const name = params.name;
      if (typeof name !== 'string' || !(name in tools))
        return rpcError(message.id, -32602, `Unknown tool: ${String(name)}`);
      try {
        const result = await callTool(dependencies, principal, name as ToolName, params.arguments);
        return ok({
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
        });
      } catch (error) {
        if (error instanceof ToolError || error instanceof ApiFailure)
          return ok({ content: [{ type: 'text', text: error.message }], isError: true });
        console.error('Unhandled MCP tool error:', error);
        return ok({ content: [{ type: 'text', text: 'Internal error.' }], isError: true });
      }
    }
    default:
      if (message.method.startsWith('notifications/')) return null;
      return isNotification ? null : rpcError(message.id, -32601, `Method not found: ${message.method}`);
  }
}

/** Stateless Streamable-HTTP MCP endpoint (JSON responses only). */
export function registerMcpRoutes(app: ApiApp, dependencies: ApiDependencies): void {
  app.get('/mcp', (c) => c.json({ error: 'Use POST with a JSON-RPC body.' }, 405, { Allow: 'POST' }));
  app.delete('/mcp', (c) => c.body(null, 405, { Allow: 'POST' }));
  app.post('/mcp', async (c) => {
    // Bearer API tokens only: cookie sessions are refused so the endpoint has no CSRF surface.
    // The challenge points OAuth-capable agents at the authorization flow (plan 022).
    const challenge = { 'WWW-Authenticate': mcpChallenge(c, dependencies) };
    if (bearer(c) === null) return c.json({ error: 'A Bearer API token is required.' }, 401, challenge);
    let principal: Principal;
    try {
      principal = await authenticate(c, dependencies);
    } catch (error) {
      if (error instanceof ApiFailure && error.status === 401)
        return c.json({ error: error.message }, 401, challenge);
      throw error;
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(rpcError(null, -32700, 'Parse error.'), 400);
    }
    if (Array.isArray(body)) {
      if (body.length === 0) return c.json(rpcError(null, -32600, 'Empty batch.'), 400);
      const replies = (await Promise.all(body.map((m) => handle(dependencies, principal, m)))).filter(
        (r) => r !== null,
      );
      return replies.length === 0 ? c.body(null, 202) : c.json(replies);
    }
    const reply = await handle(dependencies, principal, body as Rpc);
    return reply === null ? c.body(null, 202) : c.json(reply);
  });
}
