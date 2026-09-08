import { describe, expect, it, vi } from 'vitest';
import {
  dryRunIdentityMigration,
  harvestFrontmatterIds,
  migrationNeedsConfirmation,
  writeSidecarIdsToFrontmatter,
  type MigrationEntry,
} from '../src/sync/identity/migrations';
import { mintFileId } from '../src/sync/identity/id-mint';

const VAULT = 'vault-1';

async function seededEntries(
  paths: Array<{ path: string; kind: 'markdown' | 'attachment'; size?: number }>,
  idOf: (path: string, kind: 'markdown' | 'attachment') => string | undefined,
): Promise<MigrationEntry[]> {
  return Promise.all(
    paths.map(async (file) => ({
      path: file.path,
      kind: file.kind,
      size: file.size ?? 100,
      currentId: idOf(file.path, file.kind),
    })),
  );
}

const FILES = [
  { path: 'A.md', kind: 'markdown' as const, size: 120 },
  { path: 'B.md', kind: 'markdown' as const, size: 340 },
  { path: 'img.png', kind: 'attachment' as const, size: 5000 },
];

async function mintedIds(): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const file of FILES) {
    ids.set(file.path, await mintFileId(VAULT, file.path, file.kind));
  }
  return ids;
}

describe('identity migration dry runs', () => {
  it('A→B harvest is zero-churn: everything preserved, nothing rewritten', async () => {
    const entries: MigrationEntry[] = FILES.map((file) => ({
      ...file,
      frontmatterId: `file_harvested_${file.path}`,
    }));
    const report = await dryRunIdentityMigration('frontmatter', 'sidecar', entries, {
      vaultId: VAULT,
    });
    expect(report.preserved).toBe(3);
    expect(report.changed).toBe(0);
    expect(report.rewrites).toBe(0);
    expect(report.bytesToUpload).toBe(0);
    expect(report.linksBreaking).toBe(0);
    expect(migrationNeedsConfirmation(report)).toBe(false);
  });

  it('B→A preserves ids but rewrites every markdown note', async () => {
    const minted = await mintedIds();
    const entries: MigrationEntry[] = FILES.map((file) => ({
      ...file,
      currentId: minted.get(file.path),
    }));
    const report = await dryRunIdentityMigration('sidecar', 'frontmatter', entries, {
      vaultId: VAULT,
    });
    expect(report.preserved).toBe(3);
    expect(report.changed).toBe(0);
    // Only Markdown notes are rewritten; the attachment keeps its sidecar id.
    expect(report.rewrites).toBe(2);
    expect(report.rewritePaths).toEqual(['A.md', 'B.md']);
    expect(report.bytesToUpload).toBe(120 + 340);
    expect(report.linksBreaking).toBe(0);
    expect(migrationNeedsConfirmation(report)).toBe(false);
  });

  it('B→A skips notes whose frontmatter already carries the sidecar id', async () => {
    const minted = await mintedIds();
    const entries: MigrationEntry[] = FILES.map((file) => ({
      ...file,
      currentId: minted.get(file.path),
      frontmatterId: file.path === 'A.md' ? minted.get(file.path) : undefined,
    }));
    const report = await dryRunIdentityMigration('sidecar', 'frontmatter', entries, {
      vaultId: VAULT,
    });
    expect(report.rewrites).toBe(1);
    expect(report.rewritePaths).toEqual(['B.md']);
    expect(report.bytesToUpload).toBe(340);
  });

  it('anything→C is a no-op for a fresh vault with no renames', async () => {
    const minted = await mintedIds();
    const entries = await seededEntries(FILES, (path) => minted.get(path));
    const report = await dryRunIdentityMigration('sidecar', 'path', entries, { vaultId: VAULT });
    expect(report.preserved).toBe(3);
    expect(report.changed).toBe(0);
    expect(report.rewrites).toBe(0);
    expect(migrationNeedsConfirmation(report)).toBe(false);
  });

  it('B→C with renamed history churns every diverged identity and gates on confirmation', async () => {
    const entries = await seededEntries(FILES, (path) => `file_old_${path}`);
    const report = await dryRunIdentityMigration('sidecar', 'path', entries, { vaultId: VAULT });
    expect(report.preserved).toBe(0);
    expect(report.changed).toBe(3);
    expect(report.changedPaths).toEqual(['A.md', 'B.md', 'img.png']);
    expect(report.linksBreaking).toBe(3);
    expect(report.rewrites).toBe(0);
    expect(report.bytesToUpload).toBe(0);
    expect(migrationNeedsConfirmation(report)).toBe(true);
  });

  it('A→C compares against harvestable frontmatter ids, not an empty sidecar', async () => {
    const entries: MigrationEntry[] = FILES.map((file) => ({
      ...file,
      frontmatterId: `file_harvested_${file.path}`,
    }));
    const report = await dryRunIdentityMigration('frontmatter', 'path', entries, {
      vaultId: VAULT,
    });
    expect(report.changed).toBe(3);
    expect(migrationNeedsConfirmation(report)).toBe(true);
  });

  it('C→B adopts current ids with zero churn', async () => {
    const entries = await seededEntries(FILES, (path) => `file_live_${path}`);
    const report = await dryRunIdentityMigration('path', 'sidecar', entries, { vaultId: VAULT });
    expect(report.preserved).toBe(3);
    expect(report.changed).toBe(0);
    expect(migrationNeedsConfirmation(report)).toBe(false);
  });

  it('same-mode preview is a no-op report', async () => {
    const entries = await seededEntries(FILES, () => undefined);
    const report = await dryRunIdentityMigration('sidecar', 'sidecar', entries, {
      vaultId: VAULT,
    });
    expect(report.preserved).toBe(3);
    expect(report.changed).toBe(0);
  });

  it('confirmation gating is exactly changed > 0', () => {
    expect(migrationNeedsConfirmation({ changed: 0 } as never)).toBe(false);
    expect(migrationNeedsConfirmation({ changed: 1 } as never)).toBe(true);
  });
});

function mockHarvestApp(entries: Array<{ path: string; frontmatter?: string; content?: string }>) {
  return {
    vault: {
      getMarkdownFiles: () => entries.map((entry) => ({ path: entry.path })),
      read: async (file: { path: string }) => {
        const found = entries.find((entry) => entry.path === file.path);
        if (!found || found.content === undefined) throw new Error(`unreadable: ${file.path}`);
        return found.content;
      },
    },
    metadataCache: {
      getFileCache: (file: { path: string }) => {
        const found = entries.find((entry) => entry.path === file.path);
        return found?.frontmatter
          ? { frontmatter: { 'tephra-file-id': found.frontmatter } }
          : null;
      },
    },
  };
}

describe('harvestFrontmatterIds', () => {
  it('prefers metadataCache and falls back to raw reads', async () => {
    const app = mockHarvestApp([
      { path: 'Cached.md', frontmatter: 'file_cached' },
      { path: 'Raw.md', content: '---\ntephra-file-id: file_raw\n---\n# Raw\n' },
      { path: 'Plain.md', content: '# No id here\n' },
      { path: 'Unreadable.md' },
    ]);
    const harvested = await harvestFrontmatterIds(app as never);
    expect(harvested.get('Cached.md')).toBe('file_cached');
    expect(harvested.get('Raw.md')).toBe('file_raw');
    expect(harvested.has('Plain.md')).toBe(false);
    expect(harvested.has('Unreadable.md')).toBe(false);
  });
});

describe('writeSidecarIdsToFrontmatter', () => {
  function mockWriteApp(opts: { processThrows: boolean; rawContent: string }) {
    const processFrontMatter = vi.fn(async () => {
      if (opts.processThrows) throw new Error('invalid YAML');
    });
    const modify = vi.fn(async () => undefined);
    const app = {
      vault: {
        getFileByPath: (path: string) => ({ path }),
        read: async () => opts.rawContent,
        modify,
      },
      fileManager: { processFrontMatter },
    };
    return { app, processFrontMatter, modify };
  }

  it('writes via processFrontMatter on the happy path', async () => {
    const { app, processFrontMatter, modify } = mockWriteApp({
      processThrows: false,
      rawContent: '# A\n',
    });
    const result = await writeSidecarIdsToFrontmatter(
      app as never,
      new Map([['A.md', 'file_a']]),
    );
    expect(result).toEqual({ written: ['A.md'], failed: [] });
    expect(processFrontMatter).toHaveBeenCalledTimes(1);
    expect(modify).not.toHaveBeenCalled();
  });

  it('falls back to raw injection when processFrontMatter throws', async () => {
    const { app, modify } = mockWriteApp({
      processThrows: true,
      rawContent: '---\ntitle: A\n---\n# A\n',
    });
    const result = await writeSidecarIdsToFrontmatter(
      app as never,
      new Map([['A.md', 'file_a']]),
    );
    expect(result.written).toEqual(['A.md']);
    expect(result.failed).toEqual([]);
    expect(modify).toHaveBeenCalledTimes(1);
    const written = (modify.mock.calls[0] as unknown[] | undefined)?.[1] as string;
    expect(written).toContain('tephra-file-id: file_a');
  });

  it('lists failures when both write paths throw, keeping the sidecar id', async () => {
    const processFrontMatter = vi.fn(async () => {
      throw new Error('invalid YAML');
    });
    const modify = vi.fn(async () => {
      throw new Error('disk full');
    });
    const app = {
      vault: {
        getFileByPath: (path: string) => ({ path }),
        read: async () => '# A\n',
        modify,
      },
      fileManager: { processFrontMatter },
    };
    const result = await writeSidecarIdsToFrontmatter(
      app as never,
      new Map([['A.md', 'file_a']]),
    );
    expect(result.written).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.path).toBe('A.md');
    expect(result.failed[0]?.reason).toContain('disk full');
  });

  it('lists files missing from the vault as failed', async () => {
    const app = {
      vault: {
        getFileByPath: () => null,
        read: vi.fn(),
        modify: vi.fn(),
      },
      fileManager: { processFrontMatter: vi.fn() },
    };
    const result = await writeSidecarIdsToFrontmatter(
      app as never,
      new Map([['Gone.md', 'file_gone']]),
    );
    expect(result.written).toEqual([]);
    expect(result.failed).toHaveLength(1);
  });
});
