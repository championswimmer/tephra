#!/usr/bin/env node
// Compares two parity snapshots (golden first, candidate second).
//   node e2e/parity/compare.mjs golden/node.json candidate.json [--strict-soft]
// Exit 0: identical. Exit 1: differences (printed). "soft" steps (messages that embed
// third-party validator text, e.g. zod) are reported as warnings and do not fail
// unless --strict-soft is given.
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const strictSoft = argv.includes('--strict-soft');
const [aPath, bPath] = argv.filter((a) => !a.startsWith('--'));
if (!aPath || !bPath) {
  console.error('usage: compare.mjs a.json b.json [--strict-soft]');
  process.exit(2);
}
const a = JSON.parse(readFileSync(aPath, 'utf8'));
const b = JSON.parse(readFileSync(bPath, 'utf8'));

const show = (v) => {
  const s = JSON.stringify(v);
  return s === undefined
    ? '<absent>'
    : s.length > 300
      ? `${s.slice(0, 300)}...(${s.length} chars)`
      : s;
};

function diff(x, y, path, out) {
  if (JSON.stringify(x) === JSON.stringify(y)) return;
  const bothObj =
    x &&
    y &&
    typeof x === 'object' &&
    typeof y === 'object' &&
    Array.isArray(x) === Array.isArray(y);
  if (!bothObj) {
    out.push(`${path}: expected ${show(x)}\n${' '.repeat(path.length + 2)}actual   ${show(y)}`);
    return;
  }
  if (Array.isArray(x)) {
    if (x.length !== y.length)
      out.push(`${path}: array length expected ${x.length}, actual ${y.length}`);
    for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
      if (i < x.length && i < y.length) diff(x[i], y[i], `${path}[${i}]`, out);
      else out.push(`${path}[${i}]: expected ${show(x[i])}, actual ${show(y[i])}`);
    }
    return;
  }
  const kx = Object.keys(x),
    ky = Object.keys(y);
  for (const k of new Set([...kx, ...ky])) {
    if (!(k in y)) out.push(`${path}.${k}: missing in actual (expected ${show(x[k])})`);
    else if (!(k in x)) out.push(`${path}.${k}: unexpected in actual (${show(y[k])})`);
    else diff(x[k], y[k], `${path}.${k}`, out);
  }
  // Key ordering is part of JSON parity.
  const common = kx.filter((k) => k in y);
  if (JSON.stringify(common) !== JSON.stringify(ky.filter((k) => k in x)))
    out.push(`${path}: key order differs (expected ${kx.join(',')}; actual ${ky.join(',')})`);
}

let failures = 0,
  warnings = 0;
const total = Math.max(a.steps.length, b.steps.length);
for (let i = 0; i < total; i += 1) {
  const x = a.steps[i],
    y = b.steps[i];
  const label = `#${i + 1} ${(x ?? y).method} ${(x ?? y).path}  [${(x ?? y).name}]`;
  const out = [];
  if (!x) out.push('extra step in actual');
  else if (!y) out.push('step missing in actual');
  else {
    if (x.name !== y.name || x.method !== y.method || x.path !== y.path)
      out.push(
        `step identity differs: expected "${x.name}" ${x.method} ${x.path}; actual "${y.name}" ${y.method} ${y.path}`,
      );
    diff(x.status, y.status, 'status', out);
    diff(x.headers, y.headers, 'headers', out);
    diff(x.body, y.body, 'body', out);
  }
  if (out.length === 0) continue;
  const soft = !strictSoft && (x?.soft || y?.soft);
  if (soft) warnings += 1;
  else failures += 1;
  console.log(`${soft ? 'SOFT' : 'DIFF'} ${label}`);
  for (const line of out) console.log(`    ${line}`);
}
console.log(`\n${total} steps compared: ${failures} differing, ${warnings} soft-differing.`);
process.exit(failures > 0 ? 1 : 0);
