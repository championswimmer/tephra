#!/usr/bin/env node
// One-command Railway deploy driven by the Infrastructure-as-Code file
// `.railway/railway.ts`: applies the project (service + /data volume), then
// generates TEPHRA_SESSION_SECRET and TEPHRA_BOOTSTRAP_TOKEN once.
// Secrets are piped over stdin (never argv) and never printed or committed.
// Usage: npm run deploy:railway [-- --yes]
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const service = 'tephra';
const secretNames = ['TEPHRA_SESSION_SECRET', 'TEPHRA_BOOTSTRAP_TOKEN'];
const yes = process.argv.includes('--yes');

function railway(args, { input, capture = false } = {}) {
  const result = spawnSync('railway', args, {
    cwd: root,
    input,
    encoding: 'utf8',
    stdio: [input === undefined ? 'inherit' : 'pipe', capture ? 'pipe' : 'inherit', 'inherit'],
  });
  if (result.error?.code === 'ENOENT') {
    fail('Railway CLI not found. Install it: https://docs.railway.com/cli#installing-the-cli');
  }
  return result;
}

function fail(message) {
  console.error(`deploy:railway: ${message}`);
  process.exit(1);
}

if (railway(['whoami'], { capture: true }).status !== 0) {
  fail('not logged in. Run `railway login`, then `railway init` (or `railway link` for an existing project), then retry.');
}

console.log('Applying .railway/railway.ts (service + volume + settings)...');
const apply = railway(['config', 'apply', ...(yes ? ['--yes'] : [])]);
if (apply.status !== 0)
  fail('`railway config apply` failed or was declined; nothing else was changed.');

const listed = railway(['variable', 'list', '--service', service, '--json'], { capture: true });
if (listed.status !== 0) fail(`could not list variables for service "${service}".`);
let existing;
try {
  existing = new Set(Object.keys(JSON.parse(listed.stdout)));
} catch {
  fail('unexpected output from `railway variable list --json`.');
}

const missing = secretNames.filter((name) => !existing.has(name));
missing.forEach((name, index) => {
  const last = index === missing.length - 1;
  // Only the last set triggers the redeploy that picks up all secrets.
  const args = [
    'variable',
    'set',
    name,
    '--stdin',
    '--service',
    service,
    ...(last ? [] : ['--skip-deploys']),
  ];
  const set = railway(args, { input: randomBytes(32).toString('hex'), capture: true });
  if (set.status !== 0) fail(`failed to set ${name}.`);
  console.log(`Generated ${name}.`);
});
if (missing.length === 0) console.log('Secrets already present; left untouched.');

console.log(`
Next:
  1. Wait for /healthz to go green, then open the service's public domain.
  2. Read the one-time setup token: railway variable list --service ${service} --kv | grep TEPHRA_BOOTSTRAP_TOKEN
  3. Create the first account, then delete TEPHRA_BOOTSTRAP_TOKEN from the service.
  See tephra-server/deploy/railway/README.md`);
