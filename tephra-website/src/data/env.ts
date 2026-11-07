// Canonical list of environment variables Tephra reads at startup.
// Mirrors the configuration table in tephra-server/README.md and the defaults baked into
// tephra-server/deploy/docker/Dockerfile.go. Keep both in sync when a variable is added or renamed.

export type EnvStatus = 'required' | 'setup' | 'default';

export interface EnvVar {
  name: string;
  status: EnvStatus;
  /** Default or the value the container image already sets. */
  fallback?: string;
  /** Short HTML; shown in the deploy-page table. */
  purpose: string;
}

export const envStatusLabel: Record<EnvStatus, string> = {
  required: 'Always',
  setup: 'First boot',
  default: 'Optional',
};

export const envVars: EnvVar[] = [
  {
    name: 'TEPHRA_PUBLIC_URL',
    status: 'required',
    purpose:
      'Browser-visible origin, including the scheme (<code>https://notes.yourname.com</code>). Used for redirects, cookies and MCP OAuth discovery. It must match the address people open.',
  },
  {
    name: 'TEPHRA_SESSION_SECRET',
    status: 'required',
    purpose:
      'Legacy: the Go server does not read it (sessions are opaque tokens stored hashed in the database). Deploy scripts still generate it; it is harmless. Never reuse the bootstrap token here.',
  },
  {
    name: 'TEPHRA_BOOTSTRAP_TOKEN',
    status: 'setup',
    purpose:
      'One-time proof for creating the first admin account at <code>/setup</code>. Delete it from the environment after that account exists.',
  },
  {
    name: 'HOST',
    status: 'default',
    fallback: '0.0.0.0 in the image',
    purpose: 'HTTP bind address. Leave it at <code>0.0.0.0</code> inside a container.',
  },
  {
    name: 'PORT',
    status: 'default',
    fallback: '8080',
    purpose:
      'Single port for the API and the web app. Railway injects its own value, so do not set it there.',
  },
  {
    name: 'NODE_ENV',
    status: 'default',
    fallback: 'production in the image',
    purpose:
      'When set to <code>production</code>, session cookies are marked <code>Secure</code>. The container image already sets it.',
  },
  {
    name: 'TEPHRA_DATABASE_DRIVER',
    status: 'default',
    fallback: 'sqlite',
    purpose:
      'Must be <code>sqlite</code>. Tephra refuses to start with any other value: live storage is disk-only.',
  },
  {
    name: 'TEPHRA_SQLITE_PATH',
    status: 'default',
    fallback: '/data/tephra.db in the image',
    purpose: 'SQLite database file. Keep it on the persistent disk, never in the container layer.',
  },
  {
    name: 'TEPHRA_BLOB_DRIVER',
    status: 'default',
    fallback: 'filesystem',
    purpose: 'Must be <code>filesystem</code>, matching the disk-only profile.',
  },
  {
    name: 'TEPHRA_BLOB_PATH',
    status: 'default',
    fallback: '/data/blobs in the image',
    purpose: 'Content-addressed attachment store. Must sit next to the database on the same disk.',
  },
  {
    name: 'TEPHRA_MAX_BLOB_BYTES',
    status: 'default',
    fallback: '104857600 (100 MiB)',
    purpose:
      'Largest attachment Tephra accepts. Platform request limits can be lower; raise both or neither.',
  },
  {
    name: 'TEPHRA_WEB_ROOT',
    status: 'default',
    fallback: '/app/web in the image',
    purpose:
      'Directory of the built web app served by the Tephra server. Only change it for custom builds.',
  },
];
