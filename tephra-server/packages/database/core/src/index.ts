import type {
  ApiToken,
  BlobMetadata,
  CurrentVaultFile,
  Device,
  FileVersion,
  NoteLink,
  NoteMetadata,
  Session,
  User,
  Vault,
  VaultIndexState,
  VaultRevision,
} from '@tephra/vault-model';

export interface UserRepository {
  count(): Promise<number>;
  findById(id: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  insert(user: User): Promise<void>;
  update(user: User): Promise<void>;
}

export interface SessionRepository {
  findById(id: string): Promise<Session | null>;
  insert(session: Session): Promise<void>;
  delete(id: string): Promise<void>;
  deleteExpired(now: number): Promise<number>;
}

export interface VaultRepository {
  findById(id: string): Promise<Vault | null>;
  listByOwner(ownerUserId: string): Promise<Vault[]>;
  insert(vault: Vault): Promise<void>;
  update(vault: Vault): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface DeviceRepository {
  findById(id: string): Promise<Device | null>;
  listByUser(userId: string): Promise<Device[]>;
  insert(device: Device): Promise<void>;
  update(device: Device): Promise<void>;
}

export interface ApiTokenRepository {
  findById(id: string): Promise<ApiToken | null>;
  findByTokenHash(tokenHash: string): Promise<ApiToken | null>;
  listByVault(vaultId: string): Promise<ApiToken[]>;
  insert(token: ApiToken): Promise<void>;
  update(token: ApiToken): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface BlobRepository {
  findByHash(hash: string): Promise<BlobMetadata | null>;
  findByHashes(hashes: readonly string[]): Promise<BlobMetadata[]>;
  /**
   * Lists blobs that are not referenced by any current vault file or any
   * retained file version and were created strictly before `cutoff`,
   * oldest first. Used by blob garbage collection; callers must pass a
   * cutoff that leaves a grace period (for example 7 days) so blobs from
   * in-flight uploads are never returned.
   */
  findUnreferencedOlderThan(cutoff: number, limit: number): Promise<BlobMetadata[]>;
  insert(blob: BlobMetadata): Promise<void>;
  delete(hash: string): Promise<void>;
}

export interface VaultFileRepository {
  findById(vaultId: string, fileId: string): Promise<CurrentVaultFile | null>;
  findByPath(vaultId: string, path: string): Promise<CurrentVaultFile | null>;
  findByPathFold(vaultId: string, pathFold: string): Promise<CurrentVaultFile[]>;
  listByVault(vaultId: string): Promise<CurrentVaultFile[]>;
  upsert(file: CurrentVaultFile): Promise<void>;
  delete(vaultId: string, fileId: string): Promise<void>;
}

export interface VaultRevisionRepository {
  find(vaultId: string, revision: number): Promise<VaultRevision | null>;
  findLatest(vaultId: string): Promise<VaultRevision | null>;
  findByManifestHash(vaultId: string, manifestHash: string): Promise<VaultRevision | null>;
  list(vaultId: string): Promise<VaultRevision[]>;
  insert(revision: VaultRevision): Promise<void>;
}

export interface FileVersionRepository {
  listByRevision(vaultId: string, revision: number): Promise<FileVersion[]>;
  listByFile(vaultId: string, fileId: string): Promise<FileVersion[]>;
  findLatestByPath(vaultId: string, path: string): Promise<FileVersion | null>;
  insertMany(versions: readonly FileVersion[]): Promise<void>;
}

export interface NoteIndexRepository {
  findMetadata(fileId: string): Promise<NoteMetadata | null>;
  listMetadata(vaultId: string): Promise<NoteMetadata[]>;
  upsertMetadata(metadata: NoteMetadata): Promise<void>;
  deleteMetadata(fileId: string): Promise<void>;
  listLinksBySource(vaultId: string, sourceFileId: string): Promise<NoteLink[]>;
  listLinksByTarget(vaultId: string, targetFileId: string): Promise<NoteLink[]>;
  listLinks(vaultId: string): Promise<NoteLink[]>;
  replaceLinksForSource(
    vaultId: string,
    sourceFileId: string,
    links: readonly NoteLink[],
  ): Promise<void>;
  getState(vaultId: string): Promise<VaultIndexState | null>;
  setState(state: VaultIndexState): Promise<void>;
}

export interface Repositories {
  users: UserRepository;
  sessions: SessionRepository;
  vaults: VaultRepository;
  devices: DeviceRepository;
  apiTokens: ApiTokenRepository;
  blobs: BlobRepository;
  vaultFiles: VaultFileRepository;
  vaultRevisions: VaultRevisionRepository;
  fileVersions: FileVersionRepository;
  noteIndex: NoteIndexRepository;
}

export interface TransactionRepositories extends Repositories {
  /** Adapter-specific serialization or row locking for a vault commit. */
  lockVault(vaultId: string): Promise<void>;
}

export interface Database extends Repositories {
  transaction<T>(operation: (repositories: TransactionRepositories) => Promise<T>): Promise<T>;
}
