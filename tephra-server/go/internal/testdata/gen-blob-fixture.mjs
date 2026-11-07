// Populates internal/testdata/blobs-fixture/ using the Node FilesystemBlobStore, plus manifest.json.
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FilesystemBlobStore } from '../../../packages/blob-store/filesystem/src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, 'blobs-fixture');
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
const store = new FilesystemBlobStore(root);
const manifest = [];
for (const text of ['hello blob', '', 'unicode ✓ content']) {
  const bytes = new TextEncoder().encode(text);
  const hash = createHash('sha256').update(bytes).digest('hex');
  await store.put({ hash, bytes, size: bytes.byteLength });
  manifest.push({ hash, content: text });
}
writeFileSync(join(here, 'blobs-fixture-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
