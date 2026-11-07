// Package markdown is a behavioural port of packages/markdown: Obsidian-flavoured
// Markdown parsing (frontmatter, headings, tags, blocks, links) and a safe
// HTML renderer. Output must match the TypeScript implementation byte for byte.
package markdown

import "github.com/championswimmer/tephra/tephra-server/go/internal/linkresolver"

// HeadingInfo describes one heading.
type HeadingInfo struct {
	Level int    `json:"level"`
	Text  string `json:"text"`
	Slug  string `json:"slug"`
	Line  int    `json:"line"`
}

// BlockInfo describes one block id (`^id`).
type BlockInfo struct {
	ID   string `json:"id"`
	Line int    `json:"line"`
}

// Link syntaxes.
const (
	SyntaxWiki     = "wiki"
	SyntaxMarkdown = "markdown"
)

// ParsedLink is one wiki/Markdown link or embed. Subpath and DisplayText are
// nil where the TS fields are undefined.
type ParsedLink struct {
	Raw         string  `json:"raw"`
	LinkPath    string  `json:"linkPath"`
	Subpath     *string `json:"subpath,omitempty"`
	DisplayText *string `json:"displayText,omitempty"`
	IsEmbed     bool    `json:"isEmbed"`
	Syntax      string  `json:"syntax"`
}

// ParsedNote is the result of ParseNote.
type ParsedNote struct {
	Frontmatter Frontmatter   `json:"frontmatter"`
	Headings    []HeadingInfo `json:"headings"`
	Tags        []string      `json:"tags"`
	Blocks      []BlockInfo   `json:"blocks"`
	Links       []ParsedLink  `json:"links"`
}

// RenderedNote is the result of RenderMarkdown.
type RenderedNote struct {
	ParsedNote
	HTML string `json:"html"`
}

// RenderTarget is what a link-resolution callback returns for rendering.
// Empty strings stand for null. Kind is the deprecated alias of TargetKind.
type RenderTarget struct {
	TargetFileID string
	TargetPath   string
	Unresolved   bool
	Ambiguous    bool
	TargetKind   string
	Kind         string
}

// RenderOptions mirrors MarkdownRenderOptions. ResolveLink takes precedence
// over VaultIndex; with neither, links are rendered without resolution state.
type RenderOptions struct {
	Markdown      string
	SourcePath    string
	VaultIndex    *linkresolver.VaultPathIndex
	ResolveLink   func(sourcePath, linkPath string) RenderTarget
	AttachmentURL func(fileID string) string
}
