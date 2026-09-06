import { requestUrl, type RequestUrlParam } from 'obsidian';
import {
  blobUploadResponseSchema,
  syncCommitResponseSchema,
  syncPlanResponseSchema,
  type SyncCommitBody,
  type SyncCommitResponse,
  type SyncPlanBody,
  type SyncPlanResponse,
} from '@tephra/protocol';

export class TephraHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'TephraHttpError';
  }
}

export interface TephraClientLike {
  plan(body: SyncPlanBody): Promise<SyncPlanResponse>;
  uploadBlob(hash: string, bytes: Uint8Array): Promise<void>;
  commit(body: SyncCommitBody): Promise<SyncCommitResponse>;
}

export class TephraClient implements TephraClientLike {
  constructor(
    private readonly serverUrl: string,
    private readonly vaultId: string,
    private readonly token: string,
  ) {}

  plan(body: SyncPlanBody): Promise<SyncPlanResponse> {
    return this.jsonRequest('/sync/plan', 'POST', body, syncPlanResponseSchema.parse);
  }

  async uploadBlob(hash: string, bytes: Uint8Array): Promise<void> {
    const response = await this.request({
      url: this.url(`/blobs/${encodeURIComponent(hash)}`),
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/octet-stream',
        'X-Tephra-Blob-Size': String(bytes.byteLength),
      },
      body: Uint8Array.from(bytes).buffer,
      throw: false,
    });
    this.assertSuccess(response.status, response.text);
    blobUploadResponseSchema.parse(response.json);
  }

  commit(body: SyncCommitBody): Promise<SyncCommitResponse> {
    return this.jsonRequest('/sync/commit', 'POST', body, syncCommitResponseSchema.parse);
  }

  private async jsonRequest<T>(
    endpoint: string,
    method: string,
    body: unknown,
    parse: (value: unknown) => T,
  ): Promise<T> {
    const response = await this.request({
      url: this.url(endpoint),
      method,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      throw: false,
    });
    this.assertSuccess(response.status, response.text);
    return parse(response.json);
  }

  protected async request(options: RequestUrlParam) {
    try {
      return await requestUrl(options);
    } catch (error) {
      if (error instanceof TephraHttpError) throw error;
      throw new TephraHttpError(0, 'Unable to reach the Tephra server.');
    }
  }

  private url(endpoint: string): string {
    return `${this.serverUrl.replace(/\/+$/, '')}/api/v1/vaults/${encodeURIComponent(this.vaultId)}${endpoint}`;
  }

  private assertSuccess(status: number, text: string): void {
    if (status >= 200 && status < 300) return;
    let message = `Tephra request failed (${String(status)})`;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      /* Preserve the non-sensitive generic message. */
    }
    throw new TephraHttpError(status, message);
  }
}
