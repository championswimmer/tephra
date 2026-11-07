package mcp

import vm "github.com/championswimmer/tephra/tephra-server/go/internal/vaultmodel"

// toolSpec is one entry of the TS `tools` table. Schemas are the exact output
// of z.toJSONSchema for the TS input schemas.
type toolSpec struct {
	name        string
	description string
	scope       vm.ApiTokenScope
	schema      string
}

// tools is in the TS declaration order (tools/list order).
var tools = []toolSpec{
	{
		name:        "list_vaults",
		description: "List the vaults this credential can access.",
		scope:       vm.ScopeVaultReadMetadata,
		schema:      `{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{},"additionalProperties":false}`,
	},
	{
		name:        "search_notes",
		description: "Search notes in a vault by path or title (case-insensitive substring). Returns path, fileId, blobHash and title.",
		scope:       vm.ScopeVaultReadMetadata,
		schema:      `{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"vault":{"description":"Vault id or name. Optional when the API token is bound to a single vault.","type":"string"},"query":{"type":"string","minLength":1,"maxLength":200,"description":"Text to look for in note paths/titles."},"limit":{"description":"Max results (default 20).","type":"integer","minimum":1,"maximum":100}},"required":["query"],"additionalProperties":false}`,
	},
	{
		name:        "read_note",
		description: "Fetch a Markdown note. Returns its content, blobHash (pass it as baseHash when editing) and the vault revision.",
		scope:       vm.ScopeVaultReadMetadata,
		schema:      `{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"vault":{"description":"Vault id or name. Optional when the API token is bound to a single vault.","type":"string"},"path":{"type":"string","minLength":1,"description":"Vault-relative note path, e.g. \"Projects/Plan.md\"."}},"required":["path"],"additionalProperties":false}`,
	},
	{
		name:        "create_note",
		description: "Create a new Markdown note (path must end in .md and must not already exist; parent folders are implicit). Creates one vault revision.",
		scope:       vm.ScopeVaultWrite,
		schema:      `{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"vault":{"description":"Vault id or name. Optional when the API token is bound to a single vault.","type":"string"},"path":{"type":"string","minLength":1,"description":"Vault-relative note path, e.g. \"Projects/Plan.md\"."},"content":{"type":"string","description":"Full Markdown content of the new note."}},"required":["path","content"],"additionalProperties":false}`,
	},
	{
		name:        "update_note",
		description: "Edit an existing Markdown note. Provide exactly one of `patch` (unified diff with \"@@ -a,b +c,d @@\" hunks; context and removed lines must match the current note exactly) or `content` (full replacement). `baseHash` (from read_note) is required with `content` and optional with `patch`. On conflict, re-read the note and retry.",
		scope:       vm.ScopeVaultWrite,
		schema:      `{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"vault":{"description":"Vault id or name. Optional when the API token is bound to a single vault.","type":"string"},"path":{"type":"string","minLength":1,"description":"Vault-relative note path, e.g. \"Projects/Plan.md\"."},"patch":{"description":"Unified diff to apply to the current note.","type":"string","minLength":1},"content":{"description":"Complete new content for the note.","type":"string"},"baseHash":{"description":"blobHash of the version the edit is based on (from read_note).","type":"string"}},"required":["path"],"additionalProperties":false}`,
	},
}
