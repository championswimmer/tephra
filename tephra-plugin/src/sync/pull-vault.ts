import type { App } from 'obsidian';

/** Minimal vault surface the pull phase needs — faked wholesale in tests. */
export interface PullFileInfo {
  path: string;
  extension: string;
  size: number;
  mtime: number;
}

export interface PullVault {
  /** File at `path`, falling back to a case-insensitive path match. */
  getFile(path: string): PullFileInfo | null;
  exists(path: string): boolean;
  readText(path: string): Promise<string>;
  readBinary(path: string): Promise<Uint8Array>;
  /** Creates or overwrites a note; suppresses the vault echo via the adapter. */
  writeText(path: string, text: string): Promise<void>;
  /** Creates or overwrites an attachment, binary-safe. */
  writeBinary(path: string, bytes: Uint8Array): Promise<void>;
  /** Trash (falling back to delete) an existing file. */
  remove(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
}

/**
 * Live Obsidian adapter. Duck-types vault files (no `TFile` value import,
 * so the shim-based unit tests never touch the real module): anything with
 * a string `extension` counts as a file.
 */
export function obsidianPullVault(
  app: App,
  suppress: (path: string) => void,
): PullVault {
  const vault = app.vault;
  const isFile = (value: unknown): value is { path: string; extension: string } =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { path?: unknown }).path === 'string' &&
    typeof (value as { extension?: unknown }).extension === 'string';

  const fileAt = (path: string): { path: string; extension: string } | null => {
    const direct = vault.getAbstractFileByPath(path);
    if (isFile(direct)) return direct;
    // Case-insensitive fallback for the kind-classification rule.
    const lowered = path.toLowerCase();
    for (const file of vault.getFiles()) {
      if (file.path.toLowerCase() === lowered && isFile(file)) return file;
    }
    return null;
  };

  const statOf = (path: string): PullFileInfo | null => {
    const file = fileAt(path);
    if (!file) return null;
    const sized = file as { stat?: { size?: number; mtime?: number } };
    return {
      path: file.path,
      extension: file.extension,
      size: sized.stat?.size ?? 0,
      mtime: sized.stat?.mtime ?? 0,
    };
  };

  const ensureParent = async (path: string): Promise<void> => {
    const slash = path.lastIndexOf('/');
    if (slash <= 0) return;
    const parent = path.slice(0, slash);
    if (vault.getAbstractFileByPath(parent)) return;
    try {
      await vault.createFolder(parent);
    } catch {
      // Raced with another writer; the write below proves existence.
    }
  };

  return {
    getFile: (path) => statOf(path),
    exists: (path) => vault.getAbstractFileByPath(path) !== null,
    readText: async (path) => {
      const file = fileAt(path);
      if (!file) throw new Error(`File disappeared during pull: ${path}`);
      return vault.read(file as never);
    },
    readBinary: async (path) => {
      const file = fileAt(path);
      if (!file) throw new Error(`File disappeared during pull: ${path}`);
      return new Uint8Array(await vault.readBinary(file as never));
    },
    writeText: async (path, text) => {
      suppress(path);
      const file = fileAt(path);
      if (file) await vault.modify(file as never, text);
      else {
        await ensureParent(path);
        await vault.create(path, text);
      }
    },
    writeBinary: async (path, bytes) => {
      suppress(path);
      const file = fileAt(path);
      const buffer = Uint8Array.from(bytes).buffer as ArrayBuffer;
      if (file) await vault.adapter.writeBinary(file.path, buffer);
      else {
        await ensureParent(path);
        await vault.createBinary(path, buffer);
      }
    },
    remove: async (path) => {
      const file = fileAt(path);
      if (!file) return;
      suppress(path);
      try {
        await vault.trash(file as never, false);
      } catch {
        await vault.delete(file as never, false);
      }
    },
    rename: async (oldPath, newPath) => {
      const file = fileAt(oldPath);
      if (!file) throw new Error(`File disappeared during pull: ${oldPath}`);
      suppress(oldPath);
      suppress(newPath);
      await ensureParent(newPath);
      await vault.rename(file as never, newPath);
    },
  };
}
