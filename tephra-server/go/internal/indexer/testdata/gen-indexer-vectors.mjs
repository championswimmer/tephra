#!/usr/bin/env node
// Generates indexer-vectors.json from the TypeScript indexer package.
//
//   cd tephra-server && npx tsx go/internal/indexer/testdata/gen-indexer-vectors.mjs
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNote } from '../../../../packages/markdown/src/index.ts';
import { buildGraph, buildGraphPayload, buildIndexRows, GRAPH_NODE_LIMIT } from '../../../../packages/indexer/src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const vaultDir = join(here, '../../../../packages/test-fixtures/vault');

let state = 0x1badf00d;
function rand() {
  state ^= state << 13; state >>>= 0;
  state ^= state >>> 17;
  state ^= state << 5; state >>>= 0;
  return state / 0x100000000;
}
const pick = (a) => a[Math.floor(rand() * a.length)];

const file = (fileId, path, mtime, kind) => ({ fileId, vaultId: 'vault', path, kind, blobHash: `hash-${fileId}`, size: 1, mtime, updatedRevision: 1 });
const meta = (fileId, title, tags) => ({ fileId, vaultId: 'vault', indexedBlobHash: `hash-${fileId}`, title, frontmatter: {}, headings: [], tags, blocks: [], indexedAt: 1 });
const link = (id, sourceFileId, targetFileId, isEmbed) => ({ id, vaultId: 'vault', sourceFileId, rawText: '', linkPath: 'x', subpath: null, displayText: null, isEmbed, targetFileId, createdAt: 1 });

const nameParts = ['a', 'B', 'ä', 'Z', 'é', 'e', '日本', 'x y', '<b>&"q"', 'back\\slash', 'tab\there', 'ln\u2028sep', 'ctl\u0001', '😀', '\uffee', '10', '2', 'Note', 'note'];
const tagParts = ['alpha', 'Beta', 'z', 'é', '😀', '\uffee', 'a/b', 'A', '10', '2'];

function randomCase(name, n) {
  const files = [];
  for (let i = 0; i < n; i++) {
    const kind = rand() < 0.25 ? 'attachment' : 'markdown';
    const path = `${pick(nameParts)}${pick(nameParts)}/${pick(nameParts)}${i}.${kind === 'markdown' ? 'md' : 'png'}`;
    files.push(file(`f${i}`, path, Math.floor(rand() * 1000), kind));
  }
  const metadataRows = files.filter((f) => f.kind === 'markdown' && rand() < 0.9).map((f) => {
    const tags = Array.from({ length: Math.floor(rand() * 4) }, () => pick(tagParts));
    return meta(f.fileId, rand() < 0.2 ? null : `T ${pick(nameParts)}`, tags);
  });
  const links = [];
  for (let i = 0; i < n * 2; i++) {
    const s = pick(files).fileId;
    const t = rand() < 0.2 ? null : pick(files).fileId;
    links.push(link(`l${i}`, s, t, rand() < 0.3));
  }
  const latest = 1 + Math.floor(rand() * 5);
  const indexed = rand() < 0.5 ? latest : Math.max(0, latest - 1);
  return { name, files, metadataRows, links, latest, indexed };
}

const cases = [randomCase('small', 6), randomCase('medium', 40), randomCase('large', 150)];
for (const c of cases) {
  c.payload = JSON.stringify(buildGraphPayload({ files: c.files, metadataRows: c.metadataRows, links: c.links, latestRevision: c.latest, indexedRevision: c.indexed }));
}

// Truncation: input is generated in Go from `count`; only the digest is stored.
const count = GRAPH_NODE_LIMIT + 500;
const bigFiles = Array.from({ length: count }, (_, i) => file(`note-${i}`, `Note-${i}.md`, i, 'markdown'));
const bigLinks = Array.from({ length: 3000 }, (_, i) => link(`l${i}`, `note-${(i * 7) % count}`, `note-${(i * 13) % count}`, i % 5 === 0));
const bigPayload = JSON.stringify(buildGraphPayload({
  files: bigFiles, metadataRows: bigFiles.map((f) => meta(f.fileId, null, [])), links: bigLinks, latestRevision: 1, indexedRevision: 1,
}));
const truncation = { count, links: 3000, sha256: createHash('sha256').update(bigPayload).digest('hex') };

// Compatibility vault (real Markdown through the TS parser).
function list(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) out.push(...list(abs));
    else if (e.isFile()) out.push(relative(vaultDir, abs).split('\\').join('/'));
  }
  return out;
}
const paths = list(vaultDir).sort();
const files = [];
const notes = [];
paths.forEach((path, index) => {
  const fileId = `fixture-${String(index).padStart(3, '0')}`;
  const kind = path.toLowerCase().endsWith('.md') ? 'markdown' : 'attachment';
  files.push({ fileId, vaultId: 'compat-fixture', path, kind, blobHash: `fixture-hash-${fileId}`, size: 1, mtime: 1, updatedRevision: 1 });
  if (kind === 'markdown') notes.push({ fileId, parsed: parseNote(readFileSync(join(vaultDir, path), 'utf8')) });
});
let seq = 0;
const rows = buildIndexRows({ vaultId: 'compat-fixture', files, notes, indexedAt: 1700000000000, generateId: () => `compat-link-${String((seq += 1)).padStart(3, '0')}` });
const graph = buildGraph({ files, metadata: rows.metadata, links: rows.links });
const fixture = {
  files, rows: JSON.parse(JSON.stringify(rows)), graph,
  payload: JSON.stringify(buildGraphPayload({ files, metadataRows: rows.metadata, links: rows.links, latestRevision: 3, indexedRevision: 3 })),
};

writeFileSync(join(here, 'indexer-vectors.json'), JSON.stringify({ cases, truncation, fixture }, null, 1) + '\n');
