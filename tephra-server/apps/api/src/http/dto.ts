import type { CurrentVaultFile } from '@tephra/vault-model';

export function fileDto(file: CurrentVaultFile): Record<string, unknown> {
  return {
    fileId: file.fileId,
    path: file.path,
    blobHash: file.blobHash,
    size: file.size,
    mtime: file.mtime,
    ...(file.mimeType === undefined ? {} : { mimeType: file.mimeType }),
    kind: file.kind,
  };
}
