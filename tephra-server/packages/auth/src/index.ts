import { createHash, randomBytes, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto';
import type { PasswordHasher } from '@tephra/core';
import type { ApiToken, ApiTokenScope, Session, User, Vault } from '@tephra/vault-model';

const TOKEN_BYTES = 32;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

function safeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    timingSafeEqual(Buffer.alloc(right.byteLength), Buffer.from(right));
    return false;
  }
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function deriveScrypt(password: string, salt: Uint8Array, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(
      password,
      salt,
      length,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 },
      (error, derived) => error ? reject(error) : resolve(derived),
    );
  });
}

export class ScryptPasswordHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const derived = await deriveScrypt(password, salt, SCRYPT_KEY_LENGTH);
    return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
  }

  async verify(password: string, encoded: string): Promise<boolean> {
    const parts = encoded.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, nText, rText, pText, saltText, digestText] = parts;
    const N = Number(nText);
    const r = Number(rText);
    const p = Number(pText);
    if (N !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P || !saltText || !digestText) return false;
    try {
      const expected = Buffer.from(digestText, 'base64url');
      if (expected.byteLength !== SCRYPT_KEY_LENGTH) return false;
      const actual = await deriveScrypt(password, Buffer.from(saltText, 'base64url'), expected.byteLength);
      return safeEqual(actual, expected);
    } catch {
      return false;
    }
  }
}

export function createOpaqueToken(prefix = 'tph'): string {
  return `${prefix}_${randomBytes(TOKEN_BYTES).toString('base64url')}`;
}

export async function hashOpaqueToken(token: string): Promise<string> {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function constantTimeSecretEqual(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left, 'utf8').digest();
  const rightHash = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(leftHash, rightHash);
}

export interface SessionCookieOptions {
  secure?: boolean;
  name?: string;
  maxAgeSeconds?: number;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const item of (header ?? '').split(';')) {
    const separator = item.indexOf('=');
    if (separator < 1) continue;
    const name = item.slice(0, separator).trim();
    try {
      result[name] = decodeURIComponent(item.slice(separator + 1).trim());
    } catch {
      // Ignore malformed cookie values.
    }
  }
  return result;
}

export function sessionCookie(token: string, options: SessionCookieOptions = {}): string {
  const name = options.name ?? 'tephra_session';
  const secure = options.secure === false ? '' : '; Secure';
  const maxAge = options.maxAgeSeconds === undefined ? '' : `; Max-Age=${options.maxAgeSeconds}`;
  return `${name}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${secure}${maxAge}`;
}

export function clearSessionCookie(options: SessionCookieOptions = {}): string {
  return sessionCookie('', { ...options, maxAgeSeconds: 0 });
}

export type AuthPrincipal =
  | { kind: 'session'; user: User; session: Session }
  | { kind: 'token'; user: User; token: ApiToken };

export function tokenIsActive(token: ApiToken, now: number): boolean {
  return token.revokedAt === null && (token.expiresAt === null || token.expiresAt > now);
}

export function canAccessVault(
  principal: AuthPrincipal,
  vault: Vault,
  requiredScope: ApiTokenScope = 'vault:read-metadata',
): boolean {
  if (principal.kind === 'session') return principal.user.id === vault.ownerUserId;
  return (
    principal.user.id === vault.ownerUserId &&
    principal.token.vaultId === vault.id &&
    principal.token.scopes.includes(requiredScope)
  );
}
