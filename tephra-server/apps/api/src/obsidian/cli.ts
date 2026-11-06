import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiFailure } from '../http/errors.js';
import type { ObsidianLogin, ObsidianRemote, ObsidianSetup } from './types.js';

export const OBSIDIAN_HEADLESS_VERSION = '0.0.14';
const OUTPUT_LIMIT = 256 * 1024;
// Launch the unmodified official client in its own process. Secret flags are
// constructed in child memory, never in the OS command line or environment.
// This also preserves whitespace that the official stdin prompt trims.
const SECRET_LAUNCHER = `
const fs = require('node:fs');
const { createRequire } = require('node:module');
const cli = process.argv[1];
const secrets = JSON.parse(fs.readFileSync(0, 'utf8'));
process.argv = [process.execPath, cli, ...process.argv.slice(2),
  ...Object.entries(secrets).flatMap(([key, value]) => ['--' + key, value])];
// Match normal script invocation for Commander's automatic argument parsing.
// Leaving --eval here makes it treat the CLI path in argv[1] as a command.
process.execArgv = [];
// obsidian-headless 0.0.14 sign-in can receive HTTP 504 with fetch's default
// Accept-Language: *. Keep the official request and supply a real language.
// https://github.com/obsidianmd/obsidian-headless/issues/58
if (process.argv[2] === 'login') {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => {
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has('Accept-Language')) headers.set('Accept-Language', 'en-US');
    return originalFetch(input, { ...init, headers });
  };
}
createRequire(cli)(cli);
`;

/** Never exposes raw subprocess errors, paths, account data or command arguments. */
export function nativeFailure(
  code:
    | 'OBSIDIAN_UNAVAILABLE'
    | 'OBSIDIAN_LOGIN_FAILED'
    | 'OBSIDIAN_MFA_REQUIRED'
    | 'OBSIDIAN_AUTH_EXPIRED'
    | 'OBSIDIAN_SETUP_FAILED'
    | 'OBSIDIAN_CHECKOUT_MISSING'
    | 'OBSIDIAN_SYNC_FAILED',
): ApiFailure {
  const messages = {
    OBSIDIAN_UNAVAILABLE:
      'The official Obsidian client could not be installed or started. Check server network access and retry.',
    OBSIDIAN_LOGIN_FAILED: 'Obsidian sign-in failed. Check your credentials and try again.',
    OBSIDIAN_MFA_REQUIRED:
      'Enter a current Obsidian two-factor authentication code and sign in again.',
    OBSIDIAN_AUTH_EXPIRED: 'Obsidian authentication has expired. Sign in again.',
    OBSIDIAN_SETUP_FAILED:
      'Vault setup failed. Check your Sync subscription, remote vault and encryption password.',
    OBSIDIAN_CHECKOUT_MISSING:
      'The local vault or Sync state is missing. Sign in if needed, then set up this remote vault again to download a fresh copy.',
    OBSIDIAN_SYNC_FAILED:
      'Obsidian Sync failed. Check connectivity and available disk space, then retry.',
  };
  return new ApiFailure(
    code === 'OBSIDIAN_MFA_REQUIRED' ||
      code === 'OBSIDIAN_LOGIN_FAILED' ||
      code === 'OBSIDIAN_AUTH_EXPIRED'
      ? 401
      : code === 'OBSIDIAN_UNAVAILABLE'
        ? 503
        : 409,
    code,
    messages[code],
  );
}

/** Deliberately excludes application secrets, npm credentials, NODE_OPTIONS and auth-token overrides. */
export function clientEnvironment(configRoot: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: configRoot,
    XDG_CONFIG_HOME: configRoot,
    NODE_ENV: 'production',
    LANG: 'C.UTF-8',
  };
}

export interface ProcessInput {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Continuous output is discarded except a bounded stderr tail. */
  continuous?: boolean;
}
export interface ProcessOutput {
  code: number;
  stdout: string;
  stderr: string;
}
export type ProcessRunner = (input: ProcessInput) => Promise<ProcessOutput>;

export const runProcess: ProcessRunner = (input) =>
  new Promise((accept, reject) => {
    if (input.signal?.aborted) {
      reject(nativeFailure('OBSIDIAN_SYNC_FAILED'));
      return;
    }
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let exceeded = false;
    let stopped = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
      killTimer.unref();
    };
    const timer = input.timeoutMs === undefined ? undefined : setTimeout(stop, input.timeoutMs);
    timer?.unref();
    input.signal?.addEventListener('abort', stop, { once: true });
    const clean = () => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      input.signal?.removeEventListener('abort', stop);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      if (input.continuous) return;
      stdout += chunk.toString('utf8');
      if (stdout.length > OUTPUT_LIMIT) {
        exceeded = true;
        stdout = '';
        stop();
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-OUTPUT_LIMIT);
    });
    // EPIPE after an early CLI exit must not crash the API process.
    child.stdin.on('error', () => undefined);
    child.stdin.end(input.stdin ?? '');
    child.once('error', () => {
      clean();
      reject(nativeFailure('OBSIDIAN_UNAVAILABLE'));
    });
    child.once('close', (code) => {
      clean();
      if (stopped || exceeded) reject(nativeFailure('OBSIDIAN_SYNC_FAILED'));
      else accept({ code: code ?? 1, stdout, stderr });
    });
  });

export class RuntimeInstaller {
  private pending: Promise<string> | undefined;
  private readonly controller = new AbortController();
  readonly prefix: string;
  constructor(
    cacheRoot: string,
    private readonly run: ProcessRunner = runProcess,
  ) {
    this.prefix = resolve(cacheRoot, `obsidian-headless-${OBSIDIAN_HEADLESS_VERSION}`);
  }
  close(): void {
    this.controller.abort();
  }
  async available(): Promise<boolean> {
    try {
      await this.secureCacheRoot();
      return this.valid(this.prefix);
    } catch {
      return false;
    }
  }
  private async secureCacheRoot(): Promise<void> {
    const root = dirname(this.prefix);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw nativeFailure('OBSIDIAN_UNAVAILABLE');
    await chmod(root, 0o700);
  }
  ensure(): Promise<string> {
    if (this.controller.signal.aborted)
      return Promise.reject(nativeFailure('OBSIDIAN_UNAVAILABLE'));
    if (!this.pending)
      this.pending = this.install().finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
  private async valid(prefix: string): Promise<boolean> {
    try {
      const info = await lstat(prefix);
      if (!info.isDirectory() || info.isSymbolicLink()) return false;
      const manifest = JSON.parse(
        await readFile(join(prefix, 'node_modules/obsidian-headless/package.json'), 'utf8'),
      ) as { name?: string; version?: string };
      return (
        manifest.name === 'obsidian-headless' &&
        manifest.version === OBSIDIAN_HEADLESS_VERSION &&
        (await lstat(join(prefix, 'node_modules/obsidian-headless/cli.js'))).isFile()
      );
    } catch {
      return false;
    }
  }
  private async install(): Promise<string> {
    const cli = join(this.prefix, 'node_modules/obsidian-headless/cli.js');
    await this.secureCacheRoot();
    if (await this.valid(this.prefix)) return cli;
    const staging = `${this.prefix}-${randomUUID()}.install`;
    try {
      await mkdir(staging, { recursive: true, mode: 0o700 });
      const config = join(staging, 'home');
      await mkdir(config, { mode: 0o700 });
      const output = await this.run({
        command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
        args: [
          'install',
          '--prefix',
          staging,
          '--no-save',
          '--no-package-lock',
          '--omit=dev',
          '--no-audit',
          '--no-fund',
          '--registry=https://registry.npmjs.org',
          `obsidian-headless@${OBSIDIAN_HEADLESS_VERSION}`,
        ],
        cwd: staging,
        env: {
          ...clientEnvironment(config),
          npm_config_cache: join(staging, 'npm-cache'),
          npm_config_userconfig: join(staging, 'empty-npmrc'),
          npm_config_globalconfig: join(staging, 'empty-global-npmrc'),
        },
        timeoutMs: 300_000,
        signal: this.controller.signal,
      });
      if (output.code !== 0 || !(await this.valid(staging)))
        throw nativeFailure('OBSIDIAN_UNAVAILABLE');
      await rm(this.prefix, { recursive: true, force: true });
      await rename(staging, this.prefix);
      return cli;
    } catch {
      throw nativeFailure('OBSIDIAN_UNAVAILABLE');
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export interface VaultPaths {
  root: string;
  config: string;
  vault: string;
  tmp: string;
}
export function vaultPaths(root: string, vaultId: string): VaultPaths {
  // IDs are server generated, but enforce confinement even for adapter callers.
  if (!/^[a-zA-Z0-9_-]+$/.test(vaultId)) throw nativeFailure('OBSIDIAN_SETUP_FAILED');
  const path = resolve(root, vaultId);
  return {
    root: path,
    config: join(path, 'config'),
    vault: join(path, 'vault'),
    tmp: join(path, 'tmp'),
  };
}
export function clientStateRoot(paths: VaultPaths): string {
  return join(
    paths.config,
    process.platform === 'linux' ? 'obsidian-headless' : '.obsidian-headless',
  );
}
export async function preparePaths(paths: VaultPaths): Promise<void> {
  // Do not recreate an absent checkout here: startup must detect lost files.
  for (const path of [dirname(paths.root), paths.root, paths.config, paths.tmp]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    if (path !== dirname(paths.root)) await chmod(path, 0o700);
  }
}

export interface OfficialClient {
  ensure(): Promise<void>;
  close?(): void;
  login(paths: VaultPaths, input: ObsidianLogin): Promise<void>;
  remotes(paths: VaultPaths): Promise<ObsidianRemote[]>;
  setup(paths: VaultPaths, input: ObsidianSetup): Promise<void>;
  configure(paths: VaultPaths, mode: ObsidianSetup['mode']): Promise<void>;
  sync(paths: VaultPaths, continuous: boolean, signal: AbortSignal): Promise<void>;
  unlink(paths: VaultPaths): Promise<void>;
  logout(paths: VaultPaths): Promise<void>;
}
const remoteSchema = z.object({
  id: z.string().min(1).max(256),
  name: z.string().max(500),
  region: z.string().max(100).optional(),
});
const remotesSchema = z.object({ vaults: z.array(remoteSchema), shared: z.array(remoteSchema) });

export class HeadlessClient implements OfficialClient {
  private readonly controller = new AbortController();
  close(): void {
    this.controller.abort();
    this.installer.close();
  }
  constructor(
    private readonly installer: RuntimeInstaller,
    private readonly run: ProcessRunner = runProcess,
  ) {}
  async ensure(): Promise<void> {
    await this.installer.ensure();
  }
  private async invoke(
    paths: VaultPaths,
    args: string[],
    options: {
      stdin?: string;
      secrets?: Record<string, string>;
      signal?: AbortSignal;
      continuous?: boolean;
      timeoutMs?: number;
    } = {},
  ): Promise<ProcessOutput> {
    const cli = await this.installer.ensure();
    await preparePaths(paths);
    const { secrets, ...processOptions } = options;
    return this.run({
      command: process.execPath,
      args: secrets ? ['--eval', SECRET_LAUNCHER, cli, ...args] : [cli, ...args],
      cwd: paths.root,
      env: clientEnvironment(paths.config),
      timeoutMs: 60_000,
      ...processOptions,
      ...(secrets ? { stdin: JSON.stringify(secrets) } : {}),
      signal: options.signal
        ? AbortSignal.any([this.controller.signal, options.signal])
        : this.controller.signal,
    });
  }
  async login(paths: VaultPaths, input: ObsidianLogin): Promise<void> {
    const output = await this.invoke(paths, ['login'], {
      secrets: { email: input.email, password: input.password, mfa: input.mfa ?? '000000' },
    });
    if (output.code !== 0)
      throw nativeFailure(
        /2FA|MFA|two.factor/i.test(output.stderr)
          ? 'OBSIDIAN_MFA_REQUIRED'
          : 'OBSIDIAN_LOGIN_FAILED',
      );
  }
  async remotes(paths: VaultPaths): Promise<ObsidianRemote[]> {
    const output = await this.invoke(paths, ['sync-list-remote', '--json']);
    if (output.code !== 0)
      throw nativeFailure(
        /logged in|auth|token/i.test(output.stderr)
          ? 'OBSIDIAN_AUTH_EXPIRED'
          : 'OBSIDIAN_SYNC_FAILED',
      );
    try {
      const value = remotesSchema.parse(JSON.parse(output.stdout));
      return [...new Map([...value.vaults, ...value.shared].map((v) => [v.id, v])).values()];
    } catch {
      throw nativeFailure('OBSIDIAN_SYNC_FAILED');
    }
  }
  async setup(paths: VaultPaths, input: ObsidianSetup): Promise<void> {
    const output = await this.invoke(
      paths,
      [
        'sync-setup',
        '--vault',
        input.remoteVaultId,
        '--path',
        paths.vault,
        '--device-name',
        'Tephra',
        '--json',
      ],
      { secrets: { password: input.encryptionPassword ?? '' } },
    );
    if (output.code !== 0) throw nativeFailure('OBSIDIAN_SETUP_FAILED');
    await this.configure(paths, input.mode);
  }
  async configure(paths: VaultPaths, mode: ObsidianSetup['mode']): Promise<void> {
    const output = await this.invoke(paths, [
      'sync-config',
      '--path',
      paths.vault,
      '--mode',
      mode,
      '--conflict-strategy',
      'merge',
      '--configs',
      '',
      '--file-types',
      'image,audio,video,pdf,unsupported',
      '--json',
    ]);
    if (output.code !== 0) throw nativeFailure('OBSIDIAN_SETUP_FAILED');
  }
  async sync(paths: VaultPaths, continuous: boolean, signal: AbortSignal): Promise<void> {
    const output = await this.invoke(
      paths,
      ['sync', '--path', paths.vault, ...(continuous ? ['--continuous'] : [])],
      { signal, continuous: true, timeoutMs: continuous ? 0x7fffffff : 900_000 },
    );
    if (output.code !== 0)
      throw nativeFailure(
        /logged in|auth|token/i.test(output.stderr)
          ? 'OBSIDIAN_AUTH_EXPIRED'
          : 'OBSIDIAN_SYNC_FAILED',
      );
  }
  async unlink(paths: VaultPaths): Promise<void> {
    if (!(await this.installer.available())) return;
    const output = await this.invoke(paths, ['sync-unlink', '--path', paths.vault]);
    if (output.code !== 0) throw nativeFailure('OBSIDIAN_SYNC_FAILED');
  }
  async logout(paths: VaultPaths): Promise<void> {
    if (!(await this.installer.available())) return;
    const output = await this.invoke(paths, ['logout']);
    if (output.code !== 0) throw nativeFailure('OBSIDIAN_SYNC_FAILED');
  }
}
