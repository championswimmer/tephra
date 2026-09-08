import type {
  ApiToken,
  CreatedToken,
  FilesResponse,
  GraphResponse,
  LinksResponse,
  RenderedNote,
  ResolveResponse,
  User,
  Vault,
} from './types';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string };
}

function csrfToken(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const match = /(?:^|;\s*)tephra_csrf=([^;]+)/.exec(document.cookie);
  const token = match?.[1];
  return token ? decodeURIComponent(token) : undefined;
}

export class ApiClient {
  constructor(private readonly baseUrl = '/api/v1') {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body !== undefined && !headers.has('Content-Type'))
      headers.set('Content-Type', 'application/json');
    headers.set('Accept', 'application/json');
    const method = (init.method ?? 'GET').toUpperCase();
    const csrf = csrfToken();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && csrf) {
      headers.set('x-tephra-csrf', csrf);
      headers.set('X-CSRF-Token', csrf);
    }
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        credentials: 'include',
      });
    } catch {
      throw new ApiError(0, 'NETWORK_ERROR', 'Unable to reach the Tephra server.');
    }
    if (!response.ok) {
      let body: ErrorBody = {};
      try {
        body = (await response.json()) as ErrorBody;
      } catch {
        /* non-JSON error response */
      }
      throw new ApiError(
        response.status,
        body.error?.code ?? 'HTTP_ERROR',
        body.error?.message ?? `Request failed (${response.status}).`,
      );
    }
    if (response.status === 204) return undefined as T;
    if (response.headers.get('content-type')?.includes('application/json'))
      return response.json() as Promise<T>;
    return response.text() as Promise<T>;
  }

  me = () => this.request<{ user: User }>('/auth/me');
  bootstrapStatus = () => this.request<{ required: boolean }>('/auth/bootstrap/status');
  bootstrap = (input: { email: string; password: string; bootstrapToken: string }) =>
    this.request<{ user: User }>('/auth/bootstrap', {
      method: 'POST',
      body: JSON.stringify({
        email: input.email,
        password: input.password,
        token: input.bootstrapToken,
        bootstrapToken: input.bootstrapToken,
      }),
    });
  login = (input: { email: string; password: string }) =>
    this.request<{ user: User }>('/auth/login', { method: 'POST', body: JSON.stringify(input) });
  logout = () => this.request<void>('/auth/logout', { method: 'POST' });
  vaults = () => this.request<{ vaults: Vault[] }>('/vaults');
  vault = (id: string) => this.request<{ vault: Vault }>(`/vaults/${encodeURIComponent(id)}`);
  createVault = (name: string) =>
    this.request<{ vault: Vault }>('/vaults', { method: 'POST', body: JSON.stringify({ name }) });
  files = (vaultId: string) =>
    this.request<FilesResponse>(`/vaults/${encodeURIComponent(vaultId)}/files`);
  resolve = (vaultId: string, path: string) =>
    this.request<ResolveResponse>(
      `/vaults/${encodeURIComponent(vaultId)}/resolve?path=${encodeURIComponent(path)}`,
    );
  rendered = (vaultId: string, fileId: string) =>
    this.request<RenderedNote>(
      `/vaults/${encodeURIComponent(vaultId)}/files/${encodeURIComponent(fileId)}/rendered`,
    );
  source = (vaultId: string, fileId: string) =>
    this.request<string>(
      `/vaults/${encodeURIComponent(vaultId)}/files/${encodeURIComponent(fileId)}/content`,
      { headers: { Accept: 'text/plain' } },
    );
  contentUrl = (vaultId: string, fileId: string) =>
    `${this.baseUrl}/vaults/${encodeURIComponent(vaultId)}/files/${encodeURIComponent(fileId)}/content`;
  graph = (vaultId: string) =>
    this.request<GraphResponse>(`/vaults/${encodeURIComponent(vaultId)}/graph`);
  links = (vaultId: string, fileId: string) =>
    this.request<LinksResponse>(
      `/vaults/${encodeURIComponent(vaultId)}/links?fileId=${encodeURIComponent(fileId)}`,
    );
  tokens = (vaultId: string) =>
    this.request<{ tokens: ApiToken[] }>(`/vaults/${encodeURIComponent(vaultId)}/tokens`);
  createToken = (vaultId: string, name: string) =>
    this.request<CreatedToken>(`/vaults/${encodeURIComponent(vaultId)}/tokens`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
  revokeToken = (vaultId: string, tokenId: string) =>
    this.request<void>(
      `/vaults/${encodeURIComponent(vaultId)}/tokens/${encodeURIComponent(tokenId)}`,
      { method: 'DELETE' },
    );
}

export const api = new ApiClient();
