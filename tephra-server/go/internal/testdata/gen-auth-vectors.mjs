// Generates auth-vectors.json from the Node implementation. Run from tephra-server after building packages/auth,
// or via tsx: node --import tsx internal/testdata/gen-auth-vectors.mjs (from tephra-server/go).
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScryptPasswordHasher, createOpaqueToken, hashOpaqueToken, sessionCookie } from '../../../packages/auth/src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const hasher = new ScryptPasswordHasher();
const passwords = ['correct horse battery staple', '', 'pässwörd 🔐 ünïcode', 'a'.repeat(200)];
const scrypt = [];
for (const password of passwords) scrypt.push({ password, encoded: await hasher.hash(password) });
const tokens = [];
for (const prefix of ['tph', 'test']) {
  const token = createOpaqueToken(prefix);
  tokens.push({ token, hash: await hashOpaqueToken(token) });
}
tokens.push({ token: 'héllo', hash: await hashOpaqueToken('héllo') });
const cookies = ['secret', 'a b;c=d/é', ''].map((token) => ({ token, cookie: sessionCookie(token) }));
writeFileSync(join(here, 'auth-vectors.json'), JSON.stringify({ scrypt, tokens, cookies }, null, 2) + '\n');
