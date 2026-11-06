import { copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashManifest, sha256Hex } from '@tephra/protocol';
import type { Vault } from '@tephra/vault-model';
import {
  clientEnvironment,
  clientStateRoot,
  HeadlessClient,
  nativeFailure,
  OBSIDIAN_HEADLESS_VERSION,
  RuntimeInstaller,
  runProcess,
  vaultPaths,
  type OfficialClient,
  type ProcessInput,
  type ProcessRunner,
  type VaultPaths,
} from '../src/obsidian/cli.js';
import { atomicNoteWrite, importCheckout, scanCheckout } from '../src/obsidian/checkout.js';
import { NativeSyncService } from '../src/obsidian/service.js';
import { initialObsidianSettings, type ObsidianSetup } from '../src/obsidian/types.js';
import { commitNote } from '../src/mcp/commit.js';
import { setup } from './helpers.js';

const directories: string[] = [];
const services: NativeSyncService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
  vi.unstubAllEnvs();
});
async function temporary() {
  const path = await mkdtemp(join(tmpdir(), 'tephra-native-test-'));
  directories.push(path);
  return path;
}

class FakeClient implements OfficialClient {
  hasAuth = async (paths: VaultPaths) => { try { return (await stat(join(clientStateRoot(paths), 'auth_token'))).isFile(); } catch { return false; } };
  copyAuth = async (source: VaultPaths, destination: VaultPaths) => {
    await mkdir(clientStateRoot(destination), { recursive: true, mode: 0o700 });
    await copyFile(join(clientStateRoot(source), 'auth_token'), join(clientStateRoot(destination), 'auth_token'));
  };
  ensure = vi.fn(async () => undefined);
  remotes = vi.fn(async () => [{ id: 'remote-1', name: 'Remote vault', region: 'eu' }]);
  active = 0;
  events: string[] = [];
  pendingDownload = true;
  failure: Error | undefined;
  login = vi.fn(async (paths: VaultPaths, input: { email: string }) => {
    await mkdir(clientStateRoot(paths), { recursive: true, mode: 0o700 });
    await writeFile(join(clientStateRoot(paths), 'auth_token'), `saved-token:${input.email}`, { mode: 0o600 });
  });
  setup = vi.fn(async (paths: VaultPaths, _input: ObsidianSetup) => {
    void _input;
    this.events.push('setup');
    const config = join(clientStateRoot(paths), 'sync/remote-1');
    await mkdir(config, { recursive: true, mode: 0o700 });
    await writeFile(join(config, 'config.json'), '{}', { mode: 0o600 });
    this.pendingDownload = true;
  });
  configure = vi.fn(async () => undefined);
  sync = vi.fn(async (paths: VaultPaths, continuous: boolean, signal: AbortSignal) => {
    if (this.failure) throw this.failure;
    this.events.push(continuous ? 'continuous' : 'sync');
    if (!continuous) {
      if (this.pendingDownload) {
        await writeFile(join(paths.vault, 'Note.md'), '# Original\r\n日本語\r\n');
        this.pendingDownload = false;
      }
      return;
    }
    this.active++;
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', () => resolve(), { once: true });
    });
    this.active--;
    this.events.push('stopped');
  });
  unlink = vi.fn(async () => {
    expect(this.active).toBe(0);
    this.events.push('unlink');
  });
  logout = vi.fn(async () => {
    expect(this.active).toBe(0);
    this.events.push('logout');
  });
}

async function nativeFixture(options: { maxVaults?: number } = {}) {
  const context = await setup();
  const root = await temporary();
  const client = new FakeClient();
  const service = new NativeSyncService(context.dependencies, {
    root,
    client,
    scanIntervalMs: 20,
    retryIntervalMs: 50,
    ...options,
  });
  services.push(service);
  context.dependencies.obsidianSync = service;
  const vault: Vault = { ...context.vault, syncMode: 'obsidian' };
  await context.database.vaults.update(vault);
  await context.database.obsidianSync.upsert(initialObsidianSettings(vault.id));
  return { ...context, root, client, service, vault, paths: vaultPaths(root, vault.id) };
}
async function connect(
  context: Awaited<ReturnType<typeof nativeFixture>>,
  mode: ObsidianSetup['mode'] = 'bidirectional',
) {
  await context.service.login(context.vault, {
    email: 'obsidian@example.com',
    password: 'never-retained',
    mfa: '123456',
  });
  await context.service.setup(context.vault, { remoteVaultId: 'remote-1', mode });
  await expect.poll(() => context.client.active).toBe(1);
  await expect
    .poll(async () => (await context.service.status(context.vault)).phase)
    .toBe('running');
}

describe('official client adapter and runtime installer', () => {
  it('copies only private authentication state and rejects symlinked sources and destinations', async () => {
    const root = await temporary();
    const outside = await temporary();
    const source = vaultPaths(root, 'source');
    const destination = vaultPaths(root, 'destination');
    await mkdir(clientStateRoot(source), { recursive: true });
    await writeFile(join(clientStateRoot(source), 'auth_token'), 'source-token');
    await mkdir(join(clientStateRoot(source), 'sync', 'remote'), { recursive: true });
    await writeFile(join(clientStateRoot(source), 'sync', 'remote', 'config.json'), 'source-key');
    await mkdir(join(clientStateRoot(destination), 'sync', 'remote'), { recursive: true });
    await writeFile(join(clientStateRoot(destination), 'sync', 'remote', 'config.json'), 'destination-key');
    const client = new HeadlessClient(new RuntimeInstaller(root));
    await client.copyAuth(source, destination);
    expect(await readFile(join(clientStateRoot(destination), 'auth_token'), 'utf8')).toBe('source-token');
    expect(await readFile(join(clientStateRoot(destination), 'sync', 'remote', 'config.json'), 'utf8')).toBe('destination-key');
    expect((await stat(join(clientStateRoot(destination), 'auth_token'))).mode & 0o777).toBe(0o600);
    for (const path of [destination.root, destination.config, clientStateRoot(destination)])
      expect((await stat(path)).mode & 0o777).toBe(0o700);
    await rm(join(clientStateRoot(source), 'auth_token'));
    await symlink(join(clientStateRoot(destination), 'auth_token'), join(clientStateRoot(source), 'auth_token'));
    await expect(client.copyAuth(source, destination)).rejects.toMatchObject({ code: 'OBSIDIAN_AUTH_EXPIRED' });
    await rm(join(clientStateRoot(source), 'auth_token'));
    await writeFile(join(clientStateRoot(source), 'auth_token'), 'new-token');
    const malicious = vaultPaths(root, 'malicious');
    await symlink(outside, malicious.root);
    await expect(client.copyAuth(source, malicious)).rejects.toMatchObject({ code: 'OBSIDIAN_SETUP_FAILED' });
    expect(await stat(join(outside, 'config')).catch(() => null)).toBeNull();
  });
  it('coalesces installs, pins the official package, and reinstalls a lost executable', async () => {
    const cache = await temporary();
    const run = vi.fn<ProcessRunner>(async (input) => {
      expect(input.args).toContain(`obsidian-headless@${OBSIDIAN_HEADLESS_VERSION}`);
      expect(input.args).toContain('--registry=https://registry.npmjs.org');
      const prefix = input.args[input.args.indexOf('--prefix') + 1]!;
      await mkdir(join(prefix, 'node_modules/obsidian-headless'), { recursive: true });
      await writeFile(
        join(prefix, 'node_modules/obsidian-headless/package.json'),
        JSON.stringify({ name: 'obsidian-headless', version: OBSIDIAN_HEADLESS_VERSION }),
      );
      await writeFile(join(prefix, 'node_modules/obsidian-headless/cli.js'), '');
      return { code: 0, stdout: '', stderr: '' };
    });
    const installer = new RuntimeInstaller(cache, run);
    const first = installer.ensure();
    const second = installer.ensure();
    expect(first).toBe(second);
    const cli = await first;
    expect(run).toHaveBeenCalledTimes(1);
    expect(await installer.ensure()).toBe(cli);
    expect(run).toHaveBeenCalledTimes(1);
    await rm(cli);
    await installer.ensure();
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('refuses a symlinked shared-temp cache instead of executing a planted client', async () => {
    const root = await temporary();
    const target = join(root, 'target');
    await mkdir(target);
    await symlink(target, join(root, 'cache'));
    const run = vi.fn<ProcessRunner>();
    await expect(new RuntimeInstaller(join(root, 'cache'), run).ensure()).rejects.toMatchObject({
      code: 'OBSIDIAN_UNAVAILABLE',
    });
    expect(run).not.toHaveBeenCalled();
  });
  it('never retains failed install state or exposes installer output', async () => {
    const cache = await temporary();
    const run = vi
      .fn<ProcessRunner>()
      .mockResolvedValue({ code: 1, stdout: 'private-data', stderr: 'secret-password' });
    const installer = new RuntimeInstaller(cache, run);
    await expect(installer.ensure()).rejects.toMatchObject({ code: 'OBSIDIAN_UNAVAILABLE' });
    expect(await stat(installer.prefix).catch(() => null)).toBeNull();
    await expect(installer.ensure()).rejects.not.toThrow('secret-password');
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('sends passwords on stdin, isolates the environment, parses owned/shared JSON and classifies MFA', async () => {
    const root = await temporary();
    const paths = vaultPaths(root, 'vault-1');
    const installer = new RuntimeInstaller(root);
    vi.spyOn(installer, 'ensure').mockResolvedValue('/tmp/official/cli.js');
    const calls: ProcessInput[] = [];
    let output = { code: 0, stdout: '', stderr: '' };
    const run: ProcessRunner = async (input) => {
      calls.push(input);
      return output;
    };
    const client = new HeadlessClient(installer, run);
    vi.stubEnv('TEPHRA_SESSION_SECRET', 'server-secret');
    vi.stubEnv('OBSIDIAN_AUTH_TOKEN', 'other-user-token');
    vi.stubEnv('NODE_OPTIONS', '--inspect');
    await client.login(paths, { email: 'user@example.com', password: 'private-password' });
    expect(JSON.parse(calls[0]!.stdin!)).toEqual({
      email: 'user@example.com',
      password: 'private-password',
      mfa: '000000',
    });
    expect(calls[0]!.args).not.toContain('private-password');
    expect(calls[0]!.args).not.toContain('000000');
    expect(calls[0]!.args).not.toContain('user@example.com');
    expect(calls[0]!.env).toEqual(clientEnvironment(paths.config));
    expect(calls[0]!.env).not.toHaveProperty('TEPHRA_SESSION_SECRET');
    expect(calls[0]!.env).not.toHaveProperty('OBSIDIAN_AUTH_TOKEN');
    expect(calls[0]!.env).not.toHaveProperty('NODE_OPTIONS');
    output = {
      code: 0,
      stdout: JSON.stringify({
        vaults: [{ id: 'a', name: 'A' }],
        shared: [{ id: 'b', name: 'B', region: 'eu' }],
      }),
      stderr: '',
    };
    expect((await client.remotes(paths)).map((value) => value.id)).toEqual(['a', 'b']);
    output = { code: 2, stdout: '', stderr: '2FA code is incorrect: private-password' };
    await expect(
      client.login(paths, { email: 'user@example.com', password: 'private-password' }),
    ).rejects.toMatchObject({ code: 'OBSIDIAN_MFA_REQUIRED' });
    output = { code: 0, stdout: '', stderr: '' };
    await client.setup(paths, {
      remoteVaultId: 'a',
      encryptionPassword: 'vault-password',
      mode: 'pull-only',
    });
    const setupCall = calls.find((input) => input.args.includes('sync-setup'))!;
    expect(JSON.parse(setupCall.stdin!)).toEqual({ password: 'vault-password' });
    expect(setupCall.args).not.toContain('vault-password');
    const configureCall = calls.find((input) => input.args.includes('sync-config'))!;
    expect(configureCall.args).toContain('pull-only');
    expect(configureCall.args[configureCall.args.indexOf('--configs') + 1]).toBe('');
    expect(configureCall.args.join(' ')).not.toContain('community-plugin');
  });
  it.runIf(process.platform === 'linux')(
    'launches the official command with secret flags only in child memory and preserves password whitespace',
    async () => {
      const root = await temporary();
      const cli = join(root, 'fake-official.cjs');
      const capture = join(root, 'capture.json');
      await writeFile(
        cli,
        `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ argv: process.argv, execArgv: process.execArgv, osCommand: fs.readFileSync('/proc/self/cmdline', 'utf8') }));`,
      );
      const installer = new RuntimeInstaller(root);
      vi.spyOn(installer, 'ensure').mockResolvedValue(cli);
      const client = new HeadlessClient(installer);
      await client.login(vaultPaths(root, 'vault-1'), {
        email: 'user@example.com',
        password: ' password with spaces  ',
        mfa: '123456',
      });
      const result = JSON.parse(await readFile(capture, 'utf8')) as {
        argv: string[];
        execArgv: string[];
        osCommand: string;
      };
      // The official CLI's Commander parser auto-detects eval mode from
      // execArgv and would interpret argv[1] (the CLI path) as the command.
      expect(result.execArgv).not.toContain('--eval');
      expect(result.execArgv).not.toContain('-e');
      expect(result.argv.slice(0, 3)).toEqual([process.execPath, cli, 'login']);
      expect(result.argv).toContain(' password with spaces  ');
      expect(result.argv).toContain('123456');
      expect(result.osCommand).not.toMatch(/password with spaces|user@example.com|123456/);
    },
  );
  it('reaps cancelled subprocesses and bounds their output without leaking child errors', async () => {
    const root = await temporary();
    const controller = new AbortController();
    const child = runProcess({
      command: process.execPath,
      args: ['-e', 'setInterval(()=>{}, 1000)'],
      cwd: root,
      env: clientEnvironment(root),
      signal: controller.signal,
    });
    controller.abort();
    await expect(child).rejects.toMatchObject({ code: 'OBSIDIAN_SYNC_FAILED' });
    await expect(
      runProcess({
        command: process.execPath,
        args: ['-e', 'process.stdout.write("x".repeat(300000))'],
        cwd: root,
        env: clientEnvironment(root),
      }),
    ).rejects.toMatchObject({ code: 'OBSIDIAN_SYNC_FAILED' });
  });
  it('sets an explicit login language while preserving the official request and explicit language', async () => {
    const root = await temporary();
    const cli = join(root, 'fake-official.cjs');
    const preload = join(root, 'fetch-stub.cjs');
    const capture = join(root, 'requests.json');
    await writeFile(
      preload,
      `
      const fs = require('node:fs');
      const requests = [];
      globalThis.fetch = async (input, init) => {
        const headers = Object.fromEntries(new Headers(init.headers));
        requests.push({ input, ...init, headers });
        fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify(requests));
        return new Response(null, { status: headers['accept-language'] ? 200 : 504 });
      };
    `,
    );
    await writeFile(
      cli,
      `
      async function main() {
        for (const language of [undefined, 'fr-FR']) {
          const response = await fetch('https://api.obsidian.md/user/signin', {
            method: 'POST',
            headers: {
              Origin: 'https://obsidian.md',
              'Content-Type': 'application/json',
              ...(language ? { 'Accept-Language': language } : {}),
            },
            body: 'original-request-body',
          });
          if (!response.ok) process.exitCode = 2;
        }
      }
      main().catch(() => { process.exitCode = 2; });
    `,
    );
    const installer = new RuntimeInstaller(root);
    vi.spyOn(installer, 'ensure').mockResolvedValue(cli);
    const client = new HeadlessClient(installer, (input) =>
      runProcess({
        ...input,
        args: ['--require', preload, ...input.args],
      }),
    );
    await client.login(vaultPaths(root, 'vault-1'), {
      email: 'user@example.com',
      password: 'test-password',
    });
    expect(JSON.parse(await readFile(capture, 'utf8'))).toEqual(
      ['en-US', 'fr-FR'].map((language) => ({
        input: 'https://api.obsidian.md/user/signin',
        method: 'POST',
        headers: {
          origin: 'https://obsidian.md',
          'content-type': 'application/json',
          'accept-language': language,
        },
        body: 'original-request-body',
      })),
    );
  });
});

describe('native Sync lifecycle and revisioned content', () => {
  it('imports exact bytes as verified hashes and revisions; applies remote updates/deletes without a duplicate revision', async () => {
    const context = await nativeFixture();
    await connect(context);
    await context.service.enable(context.vault, false);
    const first = (await context.database.vaultFiles.listByVault(context.vault.id))[0]!;
    const bytes = await readFile(join(context.paths.vault, 'Note.md'));
    expect(first.blobHash).toBe(await sha256Hex(bytes));
    expect(context.blobStore.values.get(first.blobHash)).toEqual(new Uint8Array(bytes));
    expect(await context.database.vaultRevisions.list(context.vault.id)).toHaveLength(1);
    await importCheckout(context.dependencies, context.vault, context.paths);
    expect(await context.database.vaultRevisions.list(context.vault.id)).toHaveLength(1);
    await writeFile(join(context.paths.vault, 'Note.md'), '# Changed\n');
    await importCheckout(context.dependencies, context.vault, context.paths);
    expect(await context.database.vaultFiles.findByPath(context.vault.id, 'Note.md')).toMatchObject(
      { fileId: first.fileId, updatedRevision: 2 },
    );
    await rm(join(context.paths.vault, 'Note.md'));
    await importCheckout(context.dependencies, context.vault, context.paths);
    expect(await context.database.vaultFiles.listByVault(context.vault.id)).toEqual([]);
    expect(
      (await context.database.fileVersions.listByFile(context.vault.id, first.fileId)).map(
        (value) => value.changeType,
      ),
    ).toEqual(['create', 'modify', 'delete']);
  });
  it('resumes enabled state on boot, reinstalls through the client, and leaves paused vaults alone', async () => {
    const context = await nativeFixture();
    await connect(context);
    await context.service.close();
    const recovered = new NativeSyncService(context.dependencies, {
      root: context.root,
      client: context.client,
      scanIntervalMs: 20,
    });
    services.push(recovered);
    await recovered.boot();
    await expect.poll(() => context.client.active).toBe(1);
    expect(context.client.ensure).toHaveBeenCalledTimes(2);
    expect(context.client.login).toHaveBeenCalledTimes(1);
    await recovered.enable(context.vault, false);
    await recovered.close();
    const paused = new NativeSyncService(context.dependencies, {
      root: context.root,
      client: context.client,
    });
    services.push(paused);
    await paused.boot();
    expect(context.client.active).toBe(0);
    expect(context.client.ensure).toHaveBeenCalledTimes(2);
    expect(await readFile(join(clientStateRoot(context.paths), 'auth_token'), 'utf8')).toBe(
      'saved-token:obsidian@example.com',
    );
  });
  it.each(['absent', 'empty', 'nested-empty', 'state-absent'] as const)(
    'never starts sync with a %s retained checkout/state; explicit setup recovers',
    async (kind) => {
      const context = await nativeFixture();
      await connect(context);
      await context.service.enable(context.vault, false);
      const calls = context.client.sync.mock.calls.length;
      if (kind === 'nested-empty') {
        await rm(join(context.paths.vault, 'Note.md'));
        await mkdir(join(context.paths.vault, 'Empty folder'));
      } else if (kind === 'empty') await rm(join(context.paths.vault, 'Note.md'));
      else if (kind === 'absent') await rm(context.paths.vault, { recursive: true });
      else await rm(join(clientStateRoot(context.paths), 'sync'), { recursive: true });
      await context.service.enable(context.vault, true);
      await expect
        .poll(async () => (await context.service.status(context.vault)).lastErrorCode)
        .toBe('OBSIDIAN_CHECKOUT_MISSING');
      expect(context.client.sync).toHaveBeenCalledTimes(calls);
      expect(await context.database.vaultFiles.listByVault(context.vault.id)).toHaveLength(1);
      await context.service.setup(context.vault, {
        remoteVaultId: 'remote-1',
        mode: 'bidirectional',
      });
      await expect.poll(() => context.client.active).toBe(1);
    },
  );
  it('stops before web/agent writes, preserves optimistic concurrency, and imports each save into the ledger', async () => {
    const context = await nativeFixture();
    await connect(context);
    const file = (await context.database.vaultFiles.listByVault(context.vault.id))[0]!;
    const before = context.client.events.length;
    const result = await context.service.writeNote(
      context.vault,
      { kind: 'update', fileId: file.fileId, baseHash: file.blobHash },
      '# Web edit\n',
    );
    expect(result.status).toBe('committed');
    expect(context.client.events[before]).toBe('stopped');
    expect(await readFile(join(context.paths.vault, file.path), 'utf8')).toBe('# Web edit\n');
    await expect.poll(() => context.client.active).toBe(1);
    const conflict = await commitNote(context.dependencies, {
      vault: context.vault,
      userId: context.vault.ownerUserId,
      plan: { kind: 'update', fileId: file.fileId, baseHash: file.blobHash },
      text: 'stale edit',
    });
    expect(conflict.status).toBe('conflict');
    expect(await readFile(join(context.paths.vault, file.path), 'utf8')).toBe('# Web edit\n');
    await expect.poll(() => context.client.active).toBe(1);
    const created = await commitNote(context.dependencies, {
      vault: context.vault,
      userId: context.vault.ownerUserId,
      plan: { kind: 'create', path: 'Folder/Agent.md' },
      text: '# Agent note\n',
    });
    expect(created.status).toBe('committed');
    expect(await readFile(join(context.paths.vault, 'Folder/Agent.md'), 'utf8')).toBe(
      '# Agent note\n',
    );
    expect(await context.database.vaultRevisions.list(context.vault.id)).toHaveLength(3);
  });
  it('disables web/agent edits in pull-only mode and never logs or stores raw secrets', async () => {
    const context = await nativeFixture();
    await connect(context, 'pull-only');
    const file = (await context.database.vaultFiles.listByVault(context.vault.id))[0]!;
    await expect(
      context.service.writeNote(
        context.vault,
        { kind: 'update', fileId: file.fileId, baseHash: file.blobHash },
        'edit',
      ),
    ).rejects.toMatchObject({ code: 'OBSIDIAN_READ_ONLY' });
    expect(JSON.stringify(await context.database.obsidianSync.list())).not.toMatch(
      /never-retained|123456|saved-token/,
    );
  });
  it('keeps Pause persistent while a background reconciliation is finishing', async () => {
    const context = await nativeFixture();
    await connect(context);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = context.database.noteIndex.getState;
    let scanning = false;
    context.database.noteIndex.getState = async () => {
      scanning = true;
      await gate;
      return null;
    };
    await writeFile(join(context.paths.vault, 'Note.md'), '# Remote change');
    await expect.poll(() => scanning).toBe(true);
    const paused = context.service.enable(context.vault, false);
    await expect
      .poll(async () => (await context.service.status(context.vault)).enabled)
      .toBe(false);
    release();
    await paused;
    context.database.noteIndex.getState = original;
    expect(await context.service.status(context.vault)).toMatchObject({
      enabled: false,
      phase: 'stopped',
    });
    expect(context.client.active).toBe(0);
  });
  it('retries an unavailable runtime on enabled boot without asking for the account password', async () => {
    const context = await nativeFixture();
    await connect(context);
    await context.service.close();
    context.client.ensure.mockRejectedValueOnce(nativeFailure('OBSIDIAN_UNAVAILABLE'));
    const recovered = new NativeSyncService(context.dependencies, {
      root: context.root,
      client: context.client,
      retryIntervalMs: 10,
      scanIntervalMs: 20,
    });
    services.push(recovered);
    await recovered.boot();
    await expect.poll(() => context.client.active).toBe(1);
    expect(context.client.ensure).toHaveBeenCalledTimes(3);
    expect(context.client.login).toHaveBeenCalledTimes(1);
  });
  it('stops and reaps the worker before unlink and local removal; rejects queued resurrection', async () => {
    const context = await nativeFixture();
    await connect(context);
    await context.service.remove(context.vault);
    expect(context.client.events.slice(-2)).toEqual(['stopped', 'unlink']);
    expect(context.client.logout).not.toHaveBeenCalled();
    expect(await stat(context.paths.root).catch(() => null)).toBeNull();
    expect((await context.service.status(context.vault)).enabled).toBe(false);
    await expect(context.service.enable(context.vault, true)).rejects.toMatchObject({
      code: 'OBSIDIAN_UNAVAILABLE',
    });
  });
  it('halts on expired authentication and resumes after re-login without saving a password', async () => {
    const context = await nativeFixture();
    await connect(context);
    await context.service.enable(context.vault, false);
    context.client.failure = nativeFailure('OBSIDIAN_AUTH_EXPIRED');
    await context.service.enable(context.vault, true);
    await expect
      .poll(async () => (await context.service.status(context.vault)).lastErrorCode)
      .toBe('OBSIDIAN_AUTH_EXPIRED');
    context.client.failure = undefined;
    await context.service.login(context.vault, {
      email: 'obsidian@example.com',
      password: 'new-password',
    });
    await expect.poll(() => context.client.active).toBe(1);
  });
  it('enforces a reduced server vault limit on reboot before starting excess children', async () => {
    const context = await nativeFixture();
    await connect(context);
    await context.service.close();
    const other = { ...context.vault, id: 'other-vault', name: 'Other' };
    await context.database.vaults.insert(other);
    await context.database.obsidianSync.upsert({
      ...initialObsidianSettings(other.id),
      enabled: true,
      remoteVaultId: 'remote-1',
    });
    const recovered = new NativeSyncService(context.dependencies, {
      root: context.root,
      client: context.client,
      maxVaults: 1,
    });
    services.push(recovered);
    await recovered.boot();
    await expect.poll(() => context.client.active).toBe(1);
    expect(await recovered.status(other)).toMatchObject({
      enabled: false,
      phase: 'error',
      lastErrorCode: 'OBSIDIAN_SYNC_LIMIT',
    });
  });
  it('throttles login attempts and bounds the number of enabled vaults', async () => {
    const context = await nativeFixture({ maxVaults: 1 });
    await connect(context);
    const other = { ...context.vault, id: 'other-vault', name: 'Other' };
    await context.database.vaults.insert(other);
    await expect(
      context.service.setup(other, { remoteVaultId: 'remote-1', mode: 'bidirectional' }),
    ).rejects.toMatchObject({ code: 'OBSIDIAN_SYNC_LIMIT' });
    for (let i = 0; i < 4; i++)
      await context.service.login(context.vault, { email: 'test@example.com', password: 'secret' });
    await expect(
      context.service.login(context.vault, { email: 'test@example.com', password: 'secret' }),
    ).rejects.toMatchObject({ code: 'OBSIDIAN_RATE_LIMIT' });
  });
});

describe('checkout confinement', () => {
  it('ignores config/plugin files, refuses symlinks and traversal, and never imports deletions after a failed scan', async () => {
    const context = await nativeFixture();
    await connect(context);
    await context.service.enable(context.vault, false);
    await mkdir(join(context.paths.vault, '.obsidian/plugins/evil'), { recursive: true });
    await writeFile(
      join(context.paths.vault, '.obsidian/plugins/evil/main.js'),
      'throw Error("plugin must never run")',
    );
    expect((await scanCheckout(context.paths.vault, 100_000)).map((file) => file.path)).toEqual([
      'Note.md',
    ]);
    await symlink('/etc/passwd', join(context.paths.vault, 'linked.md'));
    await expect(
      importCheckout(context.dependencies, context.vault, context.paths),
    ).rejects.toMatchObject({ code: 'OBSIDIAN_SYNC_FAILED' });
    expect(await context.database.vaultFiles.listByVault(context.vault.id)).toHaveLength(1);
    await expect(
      atomicNoteWrite(context.paths, '../escape.md', new Uint8Array()),
    ).rejects.toMatchObject({ code: 'INVALID_PATH' });
    await expect(
      atomicNoteWrite(context.paths, '/escape.md', new Uint8Array()),
    ).rejects.toMatchObject({ code: 'INVALID_PATH' });
    await symlink(context.root, join(context.paths.vault, 'linked-dir'));
    await expect(
      atomicNoteWrite(context.paths, 'linked-dir/escape.md', new Uint8Array()),
    ).rejects.toMatchObject({ code: 'OBSIDIAN_SYNC_FAILED' });
    await expect(scanCheckout(context.paths.vault, 1)).rejects.toMatchObject({
      code: 'OBSIDIAN_SYNC_FAILED',
    });
  });
});

describe('owner setup API and protocol separation', () => {
  it('keeps account sign-in user-scoped, copies only auth to owned vaults, and preserves legacy state', async () => {
    const context = await nativeFixture();
    const vault = context.vault;
    const legacyDir = clientStateRoot(context.paths);
    await mkdir(join(legacyDir, 'sync', 'legacy'), { recursive: true });
    await writeFile(join(legacyDir, 'auth_token'), 'legacy-token');
    await writeFile(join(legacyDir, 'sync', 'legacy', 'config.json'), 'legacy-ledger');
    const other = { ...vault, id: 'other-native', ownerUserId: 'other-user', name: 'Other native' };
    await context.database.vaults.insert(other);
    await context.database.obsidianSync.upsert(initialObsidianSettings(other.id));
    const otherPaths = vaultPaths(context.root, other.id);
    await mkdir(clientStateRoot(otherPaths), { recursive: true });
    await writeFile(join(clientStateRoot(otherPaths), 'auth_token'), 'other-token');
    const url = '/api/v1/obsidian-sync/account';
    expect((await context.app.request(url)).status).toBe(401);
    expect((await context.app.request(url, { headers: { authorization: `Bearer ${context.token}` } })).status).toBe(403);
    expect((await (await context.app.request(url, { headers: context.browserHeaders })).json()).account).toEqual({ authenticated: false, email: null, lastErrorCode: null });
    expect(await readFile(join(legacyDir, 'auth_token'), 'utf8')).toBe('legacy-token');
    const noCsrf = await context.app.request(`${url}/login`, { method: 'POST', headers: { cookie: context.browserHeaders.cookie, 'content-type': 'application/json' }, body: '{}' });
    expect(noCsrf.status).toBe(403);
    const login = await context.app.request(`${url}/login`, {
      method: 'POST', headers: context.browserHeaders,
      body: JSON.stringify({ email: 'account@example.com', password: 'unique-password', mfa: '123456' }),
    });
    expect(login.status).toBe(200);
    const body = await login.text();
    expect(JSON.parse(body).account).toEqual({ authenticated: true, email: 'account@example.com', lastErrorCode: null });
    expect(body).not.toMatch(/unique-password|123456|saved-token/);
    expect(await readFile(join(legacyDir, 'auth_token'), 'utf8')).toBe('saved-token:account@example.com');
    expect(await readFile(join(legacyDir, 'sync', 'legacy', 'config.json'), 'utf8')).toBe('legacy-ledger');
    expect(await readFile(join(clientStateRoot(otherPaths), 'auth_token'), 'utf8')).toBe('other-token');
    expect((await context.service.accountStatus('other-user')).authenticated).toBe(false);
    const create = await context.app.request('/api/v1/vaults', {
      method: 'POST', headers: context.browserHeaders, body: JSON.stringify({ name: 'New headless account vault', syncMode: 'obsidian' }),
    });
    const created = (await create.json()).vault as Vault & { obsidianSync: { phase: string } };
    expect(created.obsidianSync.phase).toBe('pending-remote');
    expect((await context.app.request(`/api/v1/vaults/${created.id}/obsidian-sync/remotes`, { headers: context.browserHeaders })).status).toBe(200);
    expect(await readFile(join(clientStateRoot(vaultPaths(context.root, created.id)), 'auth_token'), 'utf8')).toBe('saved-token:account@example.com');
    const restarted = new NativeSyncService(context.dependencies, { root: context.root, client: context.client });
    services.push(restarted);
    expect(await restarted.accountStatus(vault.ownerUserId)).toEqual({ authenticated: true, email: null, lastErrorCode: null });
    await context.service.remove(vault);
    expect(context.client.logout).not.toHaveBeenCalled();
    expect((await context.service.accountStatus(vault.ownerUserId)).authenticated).toBe(true);
  });

  it('reports a known expired account and resumes an enabled vault on reauthentication', async () => {
    const context = await nativeFixture();
    await connect(context);
    await context.service.enable(context.vault, false);
    context.client.failure = nativeFailure('OBSIDIAN_AUTH_EXPIRED');
    await context.service.enable(context.vault, true);
    await expect.poll(async () => (await context.service.status(context.vault)).lastErrorCode).toBe('OBSIDIAN_AUTH_EXPIRED');
    expect(await context.service.accountStatus(context.vault.ownerUserId)).toMatchObject({ authenticated: false, lastErrorCode: 'OBSIDIAN_AUTH_EXPIRED' });
    context.client.failure = undefined;
    await context.service.accountLogin(context.vault.ownerUserId, { email: 'new@example.com', password: 'secret' });
    await expect.poll(async () => (await context.service.status(context.vault)).phase).toBe('running');
    expect(await context.service.accountStatus(context.vault.ownerUserId)).toMatchObject({ authenticated: true, lastErrorCode: null });
  });

  it('refuses an account storage symlink and does not write through it', async () => {
    const context = await nativeFixture();
    const outside = await temporary();
    await symlink(outside, join(context.root, '.accounts'));
    await expect(context.service.accountLogin(context.vault.ownerUserId, { email: 'x@example.com', password: 'secret' })).rejects.toMatchObject({ code: 'OBSIDIAN_SYNC_FAILED' });
    expect(await stat(join(outside, context.vault.ownerUserId)).catch(() => null)).toBeNull();
  });

  it('returns only public status fields for headless vaults on list, detail, and creation', async () => {
    const context = await nativeFixture();
    const initial = { enabled: false, phase: 'pending-login', lastErrorCode: null, lastSyncedAt: null };
    const create = async (name: string, syncMode: 'tephra' | 'obsidian') => context.app.request('/api/v1/vaults', {
      method: 'POST', headers: context.browserHeaders, body: JSON.stringify({ name, syncMode }),
    });
    const created = await create('New headless', 'obsidian');
    expect(created.status).toBe(201);
    expect((await created.json()).vault.obsidianSync).toEqual(initial);
    const direct = await create('Direct', 'tephra');
    expect((await direct.json()).vault).not.toHaveProperty('obsidianSync');

    await context.database.obsidianSync.upsert({
      ...initialObsidianSettings(context.vault.id),
      enabled: true, phase: 'error', lastErrorCode: 'OBSIDIAN_SYNC_FAILED', lastSyncedAt: 123,
      remoteVaultId: 'private-remote-id',
    });
    await context.database.vaults.insert({ ...context.vault, id: 'other-vault', ownerUserId: 'other-user', name: 'Private vault' });
    const expected = { enabled: true, phase: 'error', lastErrorCode: 'OBSIDIAN_SYNC_FAILED', lastSyncedAt: 123 };
    const list = await context.app.request('/api/v1/vaults', { headers: context.browserHeaders });
    const listBody = await list.json();
    expect(listBody.vaults.find((vault: Vault) => vault.id === context.vault.id).obsidianSync).toEqual(expected);
    expect(JSON.stringify(listBody)).not.toMatch(/private-remote-id|Private vault|saved-token/);
    const detail = await context.app.request(`/api/v1/vaults/${context.vault.id}`, { headers: context.browserHeaders });
    expect((await detail.json()).vault.obsidianSync).toEqual(expected);
    expect((await context.app.request('/api/v1/vaults/other-vault', { headers: context.browserHeaders })).status).toBe(403);

    delete context.dependencies.obsidianSync;
    const unavailableStored = await context.app.request(`/api/v1/vaults/${context.vault.id}`, { headers: context.browserHeaders });
    expect((await unavailableStored.json()).vault.obsidianSync).toEqual({ ...expected, phase: 'unavailable' });

    context.database.state.nativeSettings.delete(context.vault.id);
    context.dependencies.obsidianSync = context.service;
    const fallback = await context.app.request(`/api/v1/vaults/${context.vault.id}`, { headers: context.browserHeaders });
    expect((await fallback.json()).vault.obsidianSync).toEqual(initial);
    delete context.dependencies.obsidianSync;
    const unavailable = await context.app.request(`/api/v1/vaults/${context.vault.id}`, { headers: context.browserHeaders });
    expect((await unavailable.json()).vault.obsidianSync).toEqual({ ...initial, phase: 'unavailable' });
  });

  it('does not allow switching vault sync methods or configuring headless sync on direct vaults', async () => {
    const context = await nativeFixture();
    const created = await context.app.request('/api/v1/vaults', {
      method: 'POST', headers: context.browserHeaders, body: JSON.stringify({ name: 'Direct', syncMode: 'tephra' }),
    });
    const direct = (await created.json()).vault as Vault;
    for (const vault of [direct, context.vault]) {
      for (const method of ['PUT', 'PATCH']) {
        const response = await context.app.request(`/api/v1/vaults/${vault.id}`, {
          method, headers: context.browserHeaders,
          body: JSON.stringify({ syncMode: vault.syncMode === 'tephra' ? 'obsidian' : 'tephra' }),
        });
        expect(response.status).toBe(404);
      }
      expect((await context.database.vaults.findById(vault.id))?.syncMode).toBe(vault.syncMode);
    }
    const response = await context.app.request(`/api/v1/vaults/${direct.id}/obsidian-sync/setup`, {
      method: 'POST', headers: context.browserHeaders,
      body: JSON.stringify({ remoteVaultId: 'remote-1', mode: 'bidirectional' }),
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('VAULT_SYNC_MODE_MISMATCH');
    expect(await context.database.obsidianSync.find(direct.id)).toBeNull();
  });

  it('supports creation/setup/status only for owner sessions, enforces CSRF and never echoes secrets', async () => {
    const context = await nativeFixture();
    const prefix = `/api/v1/vaults/${context.vault.id}/obsidian-sync`;
    expect((await context.app.request(prefix)).status).toBe(401);
    expect(
      (await context.app.request(prefix, { headers: { authorization: `Bearer ${context.token}` } }))
        .status,
    ).toBe(403);
    const noCsrf = { cookie: context.browserHeaders.cookie, 'content-type': 'application/json' };
    expect(
      (
        await context.app.request(`${prefix}/login`, {
          method: 'POST',
          headers: noCsrf,
          body: JSON.stringify({ email: 'x@example.com', password: 'secret' }),
        })
      ).status,
    ).toBe(403);
    const spy = vi.spyOn(process.stdout, 'write');
    const login = await context.app.request(`${prefix}/login`, {
      method: 'POST',
      headers: context.browserHeaders,
      body: JSON.stringify({
        email: 'x@example.com',
        password: 'distinct-account-password',
        mfa: '987654',
      }),
    });
    expect(login.status).toBe(200);
    const text = await login.text();
    expect(text).not.toMatch(/distinct-account-password|987654|saved-token/);
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(
      /distinct-account-password|987654|saved-token/,
    );
    spy.mockRestore();
    expect(
      (await context.app.request(`${prefix}/remotes`, { headers: context.browserHeaders })).status,
    ).toBe(200);
    const connected = await context.app.request(`${prefix}/setup`, {
      method: 'POST',
      headers: context.browserHeaders,
      body: JSON.stringify({
        remoteVaultId: 'remote-1',
        encryptionPassword: 'distinct-encryption-password',
        mode: 'pull-only',
      }),
    });
    expect(connected.status).toBe(202);
    expect(await connected.text()).not.toContain('distinct-encryption-password');
    await expect.poll(() => context.client.active).toBe(1);
    const status = await context.app.request(`/api/v1/vaults/${context.vault.id}`, {
      headers: context.browserHeaders,
    });
    expect((await status.json()).vault).toMatchObject({ syncMode: 'obsidian', readOnly: true });
    const created = await context.app.request('/api/v1/vaults', {
      method: 'POST',
      headers: context.browserHeaders,
      body: JSON.stringify({ name: 'Native 2', syncMode: 'obsidian' }),
    });
    expect(created.status).toBe(201);
    expect((await created.json()).vault.syncMode).toBe('obsidian');
  });
  it.each(['not-connected', 'bidirectional', 'pull-only', 'paused', 'error'] as const)(
    'rejects direct sync with the reason in state %s, including old credentials',
    async (state) => {
      const context = await nativeFixture();
      if (state !== 'not-connected') {
        await connect(context, state === 'pull-only' ? 'pull-only' : 'bidirectional');
        if (state === 'paused' || state === 'error')
          await context.service.enable(context.vault, false);
        if (state === 'error')
          await context.database.obsidianSync.upsert({
            ...(await context.service.status(context.vault)),
            phase: 'error',
            lastErrorCode: 'OBSIDIAN_SYNC_FAILED',
          });
      }
      const headers = {
        authorization: `Bearer ${context.token}`,
        'content-type': 'application/json',
      };
      const beforeFiles = await context.database.vaultFiles.listByVault(context.vault.id);
      const beforeRevisions = await context.database.vaultRevisions.list(context.vault.id);
      const beforeBlobs = context.blobStore.values.size;
      const beforeTokens = await context.database.apiTokens.listByVault(context.vault.id);
      const files: never[] = [];
      const manifestHash = await hashManifest(files);
      const bytes = new TextEncoder().encode('Direct device upload');
      const hash = await sha256Hex(bytes);
      const expectSyncReason = async (response: Response) => {
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({
          error: {
            code: 'VAULT_SYNC_MODE_MISMATCH',
            message: expect.stringMatching(
              /Official Obsidian Sync is enabled.*Direct device sync.*disabled/,
            ),
          },
        });
      };
      for (const vaultRef of [context.vault.id, context.vault.name]) {
        const prefix = `/api/v1/vaults/${encodeURIComponent(vaultRef)}`;
        for (const endpoint of ['plan', 'commit']) {
          for (const body of [JSON.stringify({ deviceId: 'plugin', manifestHash, files }), '{}'])
            await expectSyncReason(
              await context.app.request(`${prefix}/sync/${endpoint}`, {
                method: 'POST',
                headers,
                body,
              }),
            );
        }
        await expectSyncReason(
          await context.app.request(`${prefix}/blobs/${hash}`, {
            method: 'PUT',
            headers: { ...headers, 'x-tephra-blob-size': String(bytes.byteLength) },
            body: bytes,
          }),
        );
        await expectSyncReason(
          await context.app.request(`${prefix}/tokens`, {
            method: 'POST',
            headers: context.browserHeaders,
            body: JSON.stringify({ name: 'bad plugin' }),
          }),
        );
      }
      expect(await context.database.vaultFiles.listByVault(context.vault.id)).toEqual(beforeFiles);
      expect(await context.database.vaultRevisions.list(context.vault.id)).toEqual(beforeRevisions);
      expect(context.blobStore.values.size).toBe(beforeBlobs);
      expect(await context.database.apiTokens.listByVault(context.vault.id)).toEqual(beforeTokens);
    },
  );

  it.each(['sync', 'blobs'])(
    'keeps plugin read APIs available for vault names and file IDs named %s',
    async (name) => {
      const context = await nativeFixture();
      await context.database.vaults.update({ ...context.vault, name });
      const bytes = new TextEncoder().encode('# Readable\n');
      const hash = await sha256Hex(bytes);
      await context.blobStore.put({ hash, bytes });
      await context.database.vaultFiles.upsert({
        vaultId: context.vault.id,
        fileId: name,
        path: 'Readable.md',
        blobHash: hash,
        size: bytes.byteLength,
        mtime: 1,
        kind: 'markdown',
        updatedRevision: 0,
      });
      const prefix = `/api/v1/vaults/${name}`;
      const issued = await context.app.request(`${prefix}/tokens`, {
        method: 'POST',
        headers: context.browserHeaders,
        body: JSON.stringify({ name: 'reader', scopes: ['vault:read-metadata'] }),
      });
      expect(issued.status).toBe(201);
      const { value: readToken, token } = await issued.json();
      for (const credential of [context.token, readToken]) {
        const headers = { authorization: `Bearer ${credential}` };
        for (const suffix of [
          '',
          '/files',
          '/tree',
          '/resolve?path=Readable.md',
          '/search?q=Readable',
          '/changes?sinceRevision=0',
          '/links',
          `/files/${name}`,
          `/files/${name}/links`,
          `/files/${name}/backlinks`,
        ]) {
          const response = await context.app.request(`${prefix}${suffix}`, { headers });
          expect(response.status, suffix).toBe(200);
        }
        for (const suffix of [
          `/files/${name}/content`,
          `/files/${name}/raw`,
          `/attachments/${name}`,
        ]) {
          const response = await context.app.request(`${prefix}${suffix}`, { headers });
          expect(response.status, suffix).toBe(200);
          expect(await response.text()).toBe('# Readable\n');
        }
      }
      expect(
        (await context.app.request(`${prefix}/tokens`, { headers: context.browserHeaders })).status,
      ).toBe(200);
      expect(
        (
          await context.app.request(`${prefix}/tokens/${token.id}`, {
            method: 'DELETE',
            headers: context.browserHeaders,
          })
        ).status,
      ).toBe(204);
    },
  );

  it('keeps MCP tools and scoped content edits working through official Sync', async () => {
    const context = await nativeFixture();
    context.vault = { ...context.vault, name: 'sync' };
    await context.database.vaults.update(context.vault);
    await connect(context);
    const prefix = '/api/v1/vaults/sync';
    const issued = await context.app.request(`${prefix}/tokens`, {
      method: 'POST',
      headers: context.browserHeaders,
      body: JSON.stringify({ name: 'agent', scopes: ['vault:read-metadata', 'vault:write'] }),
    });
    expect(issued.status).toBe(201);
    const { value: token } = await issued.json();
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const response = await context.app.request('/mcp', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.error).toBeUndefined();
      expect(body.result.isError).toBeUndefined();
      return body.result.structuredContent;
    };
    expect((await call('list_vaults')).vaults).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: context.vault.id })]),
    );
    expect((await call('read_note', { path: 'Note.md' })).content).toContain('# Original');
    expect(await call('create_note', { path: 'Agent.md', content: '# Agent\n' })).toMatchObject({
      status: 'committed',
    });
    const read = await call('read_note', { path: 'Agent.md' });
    expect(
      await call('update_note', {
        path: 'Agent.md',
        baseHash: read.blobHash,
        content: '# Updated by MCP\n',
      }),
    ).toMatchObject({ status: 'committed' });
    expect((await call('search_notes', { query: 'Agent' })).results).toHaveLength(1);
    expect(await readFile(join(context.paths.vault, 'Agent.md'), 'utf8')).toBe(
      '# Updated by MCP\n',
    );
    await expect
      .poll(async () => (await context.service.status(context.vault)).phase)
      .toBe('running');
    const file = (await context.database.vaultFiles.findByPath(context.vault.id, 'Agent.md'))!;
    const content = '# Updated by API\n';
    const saved = await context.app.request(`${prefix}/files/${file.fileId}/content`, {
      method: 'PUT',
      headers: {
        ...headers,
        'if-match': file.blobHash,
        'x-tephra-content-size': String(new TextEncoder().encode(content).byteLength),
      },
      body: content,
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ status: 'committed', revision: 4 });
    expect(await readFile(join(context.paths.vault, 'Agent.md'), 'utf8')).toBe(content);
    await expect.poll(() => context.client.active).toBe(1);
  });
});
