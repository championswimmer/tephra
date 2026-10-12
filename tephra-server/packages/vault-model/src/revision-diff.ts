import type { IdGenerator } from '@tephra/core';
import type {
  CurrentVaultFile,
  FileChangeType,
  FileVersion,
  IncomingVaultFile,
} from './entities.js';

export interface RevisionDiff {
  versions: FileVersion[];
  createdFileIds: string[];
  modifiedFileIds: string[];
  renamedFileIds: string[];
  deletedFileIds: string[];
  isNoOp: boolean;
}

/**
 * Diffs a complete incoming manifest by stable file ID. A simultaneous rename and
 * content change emits both append-only events at the same revision.
 */
export function diffRevision(input: {
  vaultId: string;
  revision: number;
  createdAt: number;
  current: readonly CurrentVaultFile[];
  incoming: readonly IncomingVaultFile[];
  ids: IdGenerator;
}): RevisionDiff {
  const currentById = new Map(input.current.map((file) => [file.fileId, file]));
  const incomingIds = new Set(input.incoming.map((file) => file.fileId));
  const versions: FileVersion[] = [];
  const createdFileIds: string[] = [];
  const modifiedFileIds: string[] = [];
  const renamedFileIds: string[] = [];
  const deletedFileIds: string[] = [];

  const append = (file: IncomingVaultFile, changeType: Exclude<FileChangeType, 'delete'>): void => {
    versions.push({
      id: input.ids.generate(),
      vaultId: input.vaultId,
      fileId: file.fileId,
      revision: input.revision,
      path: file.path,
      blobHash: file.blobHash,
      size: file.size,
      mtime: file.mtime,
      changeType,
      createdAt: input.createdAt,
    });
  };

  for (const file of input.incoming) {
    const previous = currentById.get(file.fileId);
    if (previous === undefined) {
      createdFileIds.push(file.fileId);
      append(file, 'create');
      continue;
    }
    if (previous.path !== file.path) {
      renamedFileIds.push(file.fileId);
      append(file, 'rename');
    }
    if (previous.blobHash !== file.blobHash) {
      modifiedFileIds.push(file.fileId);
      append(file, 'modify');
    }
  }

  for (const file of input.current) {
    if (!incomingIds.has(file.fileId)) {
      deletedFileIds.push(file.fileId);
      versions.push({
        id: input.ids.generate(),
        vaultId: input.vaultId,
        fileId: file.fileId,
        revision: input.revision,
        path: file.path,
        blobHash: null,
        size: null,
        mtime: null,
        changeType: 'delete',
        createdAt: input.createdAt,
      });
    }
  }

  return {
    versions,
    createdFileIds,
    modifiedFileIds,
    renamedFileIds,
    deletedFileIds,
    isNoOp: versions.length === 0,
  };
}
