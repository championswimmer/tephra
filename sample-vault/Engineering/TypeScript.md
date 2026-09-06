<!-- Expected: [[Glossary]] below resolves to Engineering/Glossary.md (same-folder match wins over Maps/Glossary.md). -->
# TypeScript

Notes on the project's TypeScript setup. See [[Maps/Engineering MOC|Engineering MOC]].

Related: [[Engineering/SQLite|SQLite]] for storage, [[Engineering/HTTP Caching|HTTP Caching]] for network caching, and [[Glossary]] for engineering terms.

## Strict mode

We keep `strict` on. The narrowest type wins.

```ts
type Result<T> = { ok: true; value: T } | { ok: false; error: string };

function unwrap<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(r.error);
  return r.value;
}
```

## Build cache

`tsc --incremental` output is cached; invalidation rules rhyme with [[Engineering/HTTP Caching#Cache keys|cache keys]].
