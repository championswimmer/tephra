import { describe, expect, it } from 'vitest';
import type { IdGenerator } from '@tephra/core';
import { diffRevision, type CurrentVaultFile, type IncomingVaultFile } from '../src/index.js';

class SequentialIds implements IdGenerator {
  private next = 0;
  generate(): string {
    this.next += 1;
    return `version_${String(this.next)}`;
  }
}

const current: CurrentVaultFile = {
  fileId: 'file_1',
  vaultId: 'vault_1',
  path: 'A.md',
  blobHash: 'old',
  size: 3,
  mtime: 10,
  kind: 'markdown',
  updatedRevision: 1,
};
const incoming: IncomingVaultFile = {
  fileId: 'file_1',
  path: 'A.md',
  blobHash: 'old',
  size: 3,
  mtime: 10,
  kind: 'markdown',
};

function diff(previous: readonly CurrentVaultFile[], next: readonly IncomingVaultFile[]) {
  return diffRevision({
    vaultId: 'vault_1',
    revision: 2,
    createdAt: 100,
    current: previous,
    incoming: next,
    ids: new SequentialIds(),
  });
}

describe('revision diff', () => {
  it('detects create', () => {
    const result = diff([], [incoming]);
    expect(result.versions.map((version) => version.changeType)).toEqual(['create']);
    expect(result.createdFileIds).toEqual(['file_1']);
  });

  it('detects content modification', () => {
    const result = diff([current], [{ ...incoming, blobHash: 'new', size: 4 }]);
    expect(result.versions.map((version) => version.changeType)).toEqual(['modify']);
  });

  it('detects rename while preserving file identity', () => {
    const result = diff([current], [{ ...incoming, path: 'Folder/A.md' }]);
    expect(result.versions).toMatchObject([
      { fileId: 'file_1', path: 'Folder/A.md', changeType: 'rename', blobHash: 'old' },
    ]);
  });

  it('records both rename and modify when both occur', () => {
    const result = diff([current], [{ ...incoming, path: 'B.md', blobHash: 'new' }]);
    expect(result.versions.map((version) => version.changeType)).toEqual(['rename', 'modify']);
  });

  it('detects delete with a tombstone', () => {
    const result = diff([current], []);
    expect(result.versions).toMatchObject([
      {
        fileId: 'file_1',
        path: 'A.md',
        changeType: 'delete',
        blobHash: null,
        size: null,
        mtime: null,
      },
    ]);
  });

  it('does not version unchanged content or metadata-only changes', () => {
    expect(diff([current], [incoming]).isNoOp).toBe(true);
    expect(diff([current], [{ ...incoming, mtime: 11 }]).isNoOp).toBe(true);
  });

  it('treats a wholesale id change as delete+create and references no new blobs', () => {
    // A mode switch or sidecar loss re-mints every id while paths and
    // content stay identical: identity churn, not content churn.
    const before: CurrentVaultFile[] = [
      { ...current, fileId: 'file_1', path: 'A.md', blobHash: 'hash-a' },
      {
        fileId: 'file_2',
        vaultId: 'vault_1',
        path: 'B.md',
        blobHash: 'hash-b',
        size: 5,
        mtime: 10,
        kind: 'markdown',
        updatedRevision: 1,
      },
    ];
    const after: IncomingVaultFile[] = [
      { ...incoming, fileId: 'file_new_1', path: 'A.md', blobHash: 'hash-a' },
      {
        fileId: 'file_new_2',
        path: 'B.md',
        blobHash: 'hash-b',
        size: 5,
        mtime: 10,
        kind: 'markdown',
      },
    ];
    const result = diff(before, after);
    expect(result.isNoOp).toBe(false);
    expect(result.deletedFileIds.sort()).toEqual(['file_1', 'file_2']);
    expect(result.createdFileIds.sort()).toEqual(['file_new_1', 'file_new_2']);
    expect(result.modifiedFileIds).toEqual([]);
    expect(result.renamedFileIds).toEqual([]);
    expect(result.versions.map((version) => version.changeType).sort()).toEqual([
      'create',
      'create',
      'delete',
      'delete',
    ]);
    // Every surviving version points at a blob the vault already held — an
    // identity change must never look like new content (no re-upload).
    const knownBlobs = new Set(before.map((file) => file.blobHash));
    for (const version of result.versions) {
      if (version.changeType === 'delete') {
        expect(version.blobHash).toBeNull();
      } else {
        expect(knownBlobs.has(version.blobHash ?? '')).toBe(true);
      }
    }
  });
});
