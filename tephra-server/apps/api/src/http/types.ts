import type { Context, Hono } from 'hono';
import type { Database } from '@tephra/database-core';
import type { BlobStore } from '@tephra/blob-store-core';
import type { Clock, IdGenerator, PasswordHasher } from '@tephra/core';
import type { AuthPrincipal } from '@tephra/auth';

export interface IndexService {
  indexVault?(vaultId: string, revision: number): Promise<void>;
  renderMarkdown?(input: { vaultId: string; fileId: string; markdown: string }): Promise<unknown>;
  search?(input: { vaultId: string; query: string; limit: number }): Promise<unknown[]>;
}

export interface ApiDependencies {
  database: Database;
  blobStore: BlobStore;
  clock: Clock;
  ids: IdGenerator;
  passwordHasher: PasswordHasher;
  bootstrapToken?: string;
  indexService?: IndexService;
  secureCookies?: boolean;
  sessionCookieName?: string;
  maxBlobBytes?: number;
}

export type Variables = {
  principal: AuthPrincipal;
  requestId: string;
  logContext: Record<string, unknown>;
};
export type AppContext = Context<{ Variables: Variables }>;
export type ApiApp = Hono<{ Variables: Variables }>;
