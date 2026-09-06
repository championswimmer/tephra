# SQLite

Embedded relational storage. Index: [[Maps/Engineering MOC|Engineering MOC]].

Related: [[Engineering/TypeScript|TypeScript]] (better-sqlite3 bindings), [[Engineering/HTTP Caching|HTTP Caching]] (cache backend), [[Engineering/Glossary|Engineering Glossary]].

## WAL Mode

Write-ahead logging keeps readers lock-free.

```sql
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

WAL files checkpoint on a schedule, so readers never block writers. ^wal-rule

## See also

- [[Engineering/HTTP Caching#Cache keys|How cache keys map to rows]]
- [[Projects/Website Redesign|Website Redesign]] uses SQLite for the demo index.
