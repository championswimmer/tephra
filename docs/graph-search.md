# Graph search

The graph view's Filters search box supports a documented subset of Obsidian
search. Everything else (regular expressions, `OR`, `AND` groups, tasks,
`line:`/`section:`/`block:` operators) is out of scope and treated as literal
search terms.

## Supported syntax

| Syntax            | Meaning                                                      |
| ----------------- | ------------------------------------------------------------ |
| `term`            | Case-insensitive substring of the note path or title.        |
| `"quoted phrase"` | One term containing spaces (`path:"daily notes"` works too). |
| `path:text`       | Substring of the full vault-relative path.                   |
| `file:text`       | Substring of the file name (basename) only.                  |
| `tag:#name`       | Notes carrying exactly the tag `name` (`#` optional).        |
| `#name`           | Shorthand for `tag:#name`.                                   |
| `-clause`         | Negates any clause above (`-tag:#done -path:archive`).       |

Clauses combine with implicit AND: `project -tag:#done` keeps notes matching
`project` that are not tagged `done`. An empty query matches everything.

Tag matching is exact on the full tag path: `tag:#area` does not match
`area/work`; use `tag:#area/work` for that.

## How filters apply

1. The Tags / Attachments toggles remove those node kinds.
2. The search keeps real files (notes, attachments) that match; tag and
   unresolved nodes survive only while they still touch a visible file.
3. Existing files only removes unresolved-link nodes.
4. Orphan hiding runs last, because every earlier step can create orphans.

## Local graph

The local graph restricts the vault to the open note's neighbourhood first
(depth slider, `1–6`), then applies the same filters in the same order.
