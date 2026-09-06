# HTTP Caching

How we cache rendered pages. Index: [[Maps/Engineering MOC|Engineering MOC]].

Related: [[Engineering/TypeScript|TypeScript]], [[Engineering/SQLite|SQLite]], [[Engineering/Glossary|Engineering Glossary]].

## Cache keys

Keys combine path and content hash, so renames invalidate cleanly. ^cache-key

| Directive | Meaning |
| --------- | ------- |
| `max-age` | Freshness lifetime in seconds |
| `ETag` | Validator for conditional requests |
| `no-cache` | Revalidate before reuse |

```http
GET /notes/engineering-moc HTTP/1.1
If-None-Match: "abc123"
```

> [!note]
> Stale-while-revalidate keeps the demo snappy while Tephra re-renders in the background.
