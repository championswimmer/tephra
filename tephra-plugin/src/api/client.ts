import { requestUrl, type RequestUrlParam } from 'obsidian';
import {
  blobUploadResponseSchema,
  filesResponseSchema,
  PLUGIN_VERSION_HEADER,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_HEADER,
  resolveResponseSchema,
  syncCommitResponseSchema,
  syncPlanResponseSchema,
  type FilesResponse,
  type ResolveResponse,
  type SyncCommitBody,
  type SyncCommitResponse,
  type SyncPlanBody,
  type SyncPlanResponse,
} from '@tephra/protocol';

/** Mirrors the `version` field in the plugin `package.json`. */
export const PLUGIN_VERSION = '0.1.0';

export class TephraHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'TephraHttpError';
  }
}

export interface RemoteVault {
  id: string;
  name: string;
  latestRevision: number;
  createdAt: number;
  updatedAt: number;
}

export interface UserSummary {
  id: string;
  email: string;
}

export interface LoginResult {
  user: UserSummary;
  sessionToken: string;
}

export interface ProvisionTokenResult {
  token: {
    id: string;
    userId: string;
    vaultId: string;
    deviceId: string | null;
    name: string;
    scopes: string[];
    createdAt: number;
  };
  value: string;
}

export interface TephraClientLike {
  plan(body: SyncPlanBody): Promise<SyncPlanResponse>;
  uploadBlob(hash: string, bytes: Uint8Array): Promise<void>;
  commit(body: SyncCommitBody): Promise<SyncCommitResponse>;
  /** Server identity authority for repair (plan 010, §9.2): one GET, no protocol change. */
  listFiles(): Promise<FilesResponse>;
  resolve(path: string): Promise<ResolveResponse>;
}

export class TephraClient implements TephraClientLike {
  constructor(
    private readonly serverUrl: string,
    private readonly vaultId: string = '',
    private readonly token: string = '',
  ) {}

  async testConnection(serverUrlOverride?: string): Promise<{ ok: boolean; status: number }> {
    const url = `${this.baseUrl(serverUrlOverride)}/healthz`;
    try {
      const response = await this.request({
        url,
        method: 'GET',
        throw: false,
      });
      return { ok: response.status >= 200 && response.status < 300, status: response.status };
    } catch {
      return { ok: false, status: 0 };
    }
  }

  login(email: string, password: string, serverUrlOverride?: string): Promise<LoginResult> {
    return this.jsonRequest(
      `${this.baseUrl(serverUrlOverride)}/api/v1/auth/login`,
      'POST',
      { email, password },
      (value) => {
        const data = value as { user: UserSummary; sessionToken: string };
        if (!data?.sessionToken || !data?.user?.email) {
          throw new TephraHttpError(500, 'Invalid login response from server.');
        }
        return { user: data.user, sessionToken: data.sessionToken };
      },
    );
  }

  listVaults(sessionToken?: string): Promise<RemoteVault[]> {
    return this.jsonRequest(
      `${this.baseUrl()}/api/v1/vaults`,
      'GET',
      undefined,
      (value) => (value as { vaults: RemoteVault[] }).vaults ?? [],
      sessionToken,
    );
  }

  createVault(name: string, sessionToken?: string): Promise<RemoteVault> {
    return this.jsonRequest(
      `${this.baseUrl()}/api/v1/vaults`,
      'POST',
      { name },
      (value) => (value as { vault: RemoteVault }).vault,
      sessionToken,
    );
  }

  provisionVaultToken(
    vaultId: string,
    input: { name: string; deviceId?: string; deviceName?: string; platform?: string },
    sessionToken?: string,
  ): Promise<ProvisionTokenResult> {
    return this.jsonRequest(
      `${this.baseUrl()}/api/v1/vaults/${encodeURIComponent(vaultId)}/tokens`,
      'POST',
      {
        name: input.name,
        ...(input.deviceId ? { deviceId: input.deviceId } : {}),
        ...(input.deviceName ? { deviceName: input.deviceName } : {}),
        platform: input.platform ?? 'obsidian-plugin',
      },
      (value) => value as ProvisionTokenResult,
      sessionToken,
    );
  }

  getVault(vaultId?: string, tokenOverride?: string): Promise<RemoteVault> {
    const targetId = vaultId ?? this.vaultId;
    return this.jsonRequest(
      `${this.baseUrl()}/api/v1/vaults/${encodeURIComponent(targetId)}`,
      'GET',
      undefined,
      (value) => (value as { vault: RemoteVault }).vault,
      tokenOverride,
    );
  }

  async logout(sessionToken?: string): Promise<void> {
    await this.jsonRequest(
      `${this.baseUrl()}/api/v1/auth/logout`,
      'POST',
      {},
      () => undefined,
      sessionToken,
    );
  }

  plan(body: SyncPlanBody): Promise<SyncPlanResponse> {
    return this.jsonRequest(this.vaultUrl('/sync/plan'), 'POST', body, syncPlanResponseSchema.parse);
  }

  async uploadBlob(hash: string, bytes: Uint8Array): Promise<void> {
    const response = await this.request({
      url: this.vaultUrl(`/blobs/${encodeURIComponent(hash)}`),
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/octet-stream',
        'X-Tephra-Blob-Size': String(bytes.byteLength),
        ...this.versionHeaders(),
      },
      body: Uint8Array.from(bytes).buffer,
      throw: false,
    });
    this.assertSuccess(response.status, response.text);
    blobUploadResponseSchema.parse(response.json);
  }

  commit(body: SyncCommitBody): Promise<SyncCommitResponse> {
    return this.jsonRequest(this.vaultUrl('/sync/commit'), 'POST', body, syncCommitResponseSchema.parse);
  }

  listFiles(): Promise<FilesResponse> {
    return this.jsonRequest(this.vaultUrl('/files'), 'GET', undefined, filesResponseSchema.parse);
  }

  resolve(path: string): Promise<ResolveResponse> {
    // Query parameter, not a wildcard route: request paths stay out of the
    // access log, which records `req.path` but not the query string (§13.3).
    return this.jsonRequest(
      `${this.vaultUrl('/resolve')}?path=${encodeURIComponent(path)}`,
      'GET',
      undefined,
      resolveResponseSchema.parse,
    );
  }

  private async jsonRequest<T>(
    url: string,
    method: string,
    body: unknown | undefined,
    parse: (value: unknown) => T,
    tokenOverride?: string,
  ): Promise<T> {
    const token = tokenOverride ?? this.token;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.versionHeaders(),
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const options: RequestUrlParam = {
      url,
      method,
      headers,
      throw: false,
    };
    if (body !== undefined) {
      options.body = JSON.stringify(body);
    }
    const response = await this.request(options);
    this.assertSuccess(response.status, response.text);
    return parse(response.json);
  }

  private versionHeaders(): Record<string, string> {
    return { [PLUGIN_VERSION_HEADER]: PLUGIN_VERSION, [PROTOCOL_VERSION_HEADER]: PROTOCOL_VERSION };
  }

  protected async request(options: RequestUrlParam) {
    try {
      return await requestUrl(options);
    } catch (error) {
      if (error instanceof TephraHttpError) throw error;
      throw new TephraHttpError(0, 'Unable to reach the Tephra server.');
    }
  }

  private baseUrl(serverUrlOverride?: string): string {
    return (serverUrlOverride ?? this.serverUrl).replace(/\/+$/, '');
  }

  private vaultUrl(endpoint: string, vaultIdOverride?: string): string {
    const targetId = vaultIdOverride ?? this.vaultId;
    return `${this.baseUrl()}/api/v1/vaults/${encodeURIComponent(targetId)}${endpoint}`;
  }

  private assertSuccess(status: number, text: string): void {
    if (status >= 200 && status < 300) return;
    let message = `Tephra request failed (${String(status)})`;
    try {
      const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
      if (parsed.error?.message) message = parsed.error.message;
      // Keep the machine-readable code: the coordinator self-heals
      // DUPLICATE_FILE_ID / DUPLICATE_PATH commits by repairing and retrying.
      if (parsed.error?.code) message += ` (${parsed.error.code})`;
    } catch {
      /* Preserve the non-sensitive generic message. */
    }
    throw new TephraHttpError(status, message);
  }
}
