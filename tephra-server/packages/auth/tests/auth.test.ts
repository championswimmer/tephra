import { describe, expect, it } from 'vitest';
import {
  ScryptPasswordHasher,
  clearSessionCookie,
  constantTimeSecretEqual,
  createOpaqueToken,
  hashOpaqueToken,
  sessionCookie,
} from '../src/index.js';

describe('@tephra/auth', () => {
  it('hashes passwords with a random salt and verifies them', async () => {
    const hasher = new ScryptPasswordHasher();
    const first = await hasher.hash('correct horse battery staple');
    const second = await hasher.hash('correct horse battery staple');
    expect(first).not.toBe(second);
    expect(first).not.toContain('correct horse battery staple');
    await expect(hasher.verify('correct horse battery staple', first)).resolves.toBe(true);
    await expect(hasher.verify('wrong password', first)).resolves.toBe(false);
    await expect(hasher.verify('anything', 'malformed')).resolves.toBe(false);
  });

  it('creates opaque tokens and hashes them deterministically', async () => {
    const token = createOpaqueToken('test');
    expect(token).toMatch(/^test_[A-Za-z0-9_-]+$/);
    expect(await hashOpaqueToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(await hashOpaqueToken(token)).toBe(await hashOpaqueToken(token));
    expect(constantTimeSecretEqual('same', 'same')).toBe(true);
    expect(constantTimeSecretEqual('same', 'different')).toBe(false);
  });

  it('emits secure session cookies by default', () => {
    expect(sessionCookie('secret')).toContain('HttpOnly');
    expect(sessionCookie('secret')).toContain('SameSite=Lax');
    expect(sessionCookie('secret')).toContain('Secure');
    expect(clearSessionCookie()).toContain('Max-Age=0');
  });
});
