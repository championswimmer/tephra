package markdown

import (
	"reflect"
	"strings"
	"testing"

	"github.com/championswimmer/tephra/tephra-server/go/internal/linkresolver"
)

func render(t *testing.T, o RenderOptions) string {
	t.Helper()
	note, err := RenderMarkdown(o)
	if err != nil {
		t.Fatal(err)
	}
	return note.HTML
}

func contains(t *testing.T, html, want string) {
	t.Helper()
	if !strings.Contains(html, want) {
		t.Errorf("html missing %q:\n%s", want, html)
	}
}

func notContains(t *testing.T, html, unwanted string) {
	t.Helper()
	if strings.Contains(html, unwanted) {
		t.Errorf("html unexpectedly contains %q:\n%s", unwanted, html)
	}
}

func TestParseNoteExtractsEverything(t *testing.T) {
	parsed := ParseNote("---\ntitle: Project\npublished: true\ntags: [planning, important]\naliases:\n  - Alpha\n---\n# Design #phase/one\nText [[Folder/Note#Heading|note]], [other](../Other.md#Part), and ![[image.png]]. ^block-1")
	if v, _ := parsed.Frontmatter.Get("title"); v != "Project" {
		t.Errorf("title %v", v)
	}
	if v, _ := parsed.Frontmatter.Get("published"); v != true {
		t.Errorf("published %v", v)
	}
	if v, _ := parsed.Frontmatter.Get("aliases"); !reflect.DeepEqual(v, []any{"Alpha"}) {
		t.Errorf("aliases %v", v)
	}
	wantHeadings := []HeadingInfo{{Level: 1, Text: "Design #phase/one", Slug: "design-phaseone", Line: 8}}
	if !reflect.DeepEqual(parsed.Headings, wantHeadings) {
		t.Errorf("headings %+v", parsed.Headings)
	}
	for _, tag := range []string{"planning", "important", "phase/one"} {
		found := false
		for _, got := range parsed.Tags {
			found = found || got == tag
		}
		if !found {
			t.Errorf("tag %q missing from %v", tag, parsed.Tags)
		}
	}
	if !reflect.DeepEqual(parsed.Blocks, []BlockInfo{{ID: "block-1", Line: 9}}) {
		t.Errorf("blocks %+v", parsed.Blocks)
	}
	if len(parsed.Links) != 3 {
		t.Fatalf("links %+v", parsed.Links)
	}
	l := parsed.Links
	if l[0].LinkPath != "Folder/Note" || *l[0].Subpath != "Heading" || *l[0].DisplayText != "note" || l[0].IsEmbed || l[0].Syntax != "wiki" {
		t.Errorf("link0 %+v", l[0])
	}
	if l[1].LinkPath != "../Other.md" || *l[1].Subpath != "Part" || l[1].IsEmbed || l[1].Syntax != "markdown" {
		t.Errorf("link1 %+v", l[1])
	}
	if l[2].LinkPath != "image.png" || l[2].Subpath != nil || !l[2].IsEmbed || l[2].Syntax != "wiki" {
		t.Errorf("link2 %+v", l[2])
	}
}

func TestParseNoteIgnoresCode(t *testing.T) {
	parsed := ParseNote("`[[Nope]] #nope`\n```js\nconst x = \"[[Also Nope]] #bad\";\n```\n[[Yes]] #good")
	if len(parsed.Links) != 1 || parsed.Links[0].LinkPath != "Yes" {
		t.Errorf("links %+v", parsed.Links)
	}
	if !reflect.DeepEqual(parsed.Tags, []string{"good"}) {
		t.Errorf("tags %v", parsed.Tags)
	}
}

func TestRendersAutolinks(t *testing.T) {
	html := render(t, RenderOptions{
		Markdown:   "See <https://example.com/a?b=1&c=2> or <me@example.com>, not <a link>, <javascript:alert(1)> or `<https://code.example>`.",
		SourcePath: "Auto.md",
	})
	contains(t, html, `<a href="https://example.com/a?b=1&amp;c=2" rel="noopener noreferrer">https://example.com/a?b=1&amp;c=2</a>`)
	contains(t, html, `<a href="mailto:me@example.com" rel="noopener noreferrer">me@example.com</a>`)
	contains(t, html, `&lt;a link&gt;`)
	notContains(t, html, `href="javascript:`)
	contains(t, html, `<code>&lt;https://code.example&gt;</code>`)
}

func TestEscapesRawHTMLAndBlocksDangerousSchemes(t *testing.T) {
	html := render(t, RenderOptions{
		Markdown:   "# Safe\n<script>alert(1)</script> [bad](java\nscript:alert(1)) ![bad](data:text/html,x)",
		SourcePath: "Safe.md",
	})
	contains(t, html, "&lt;script&gt;")
	notContains(t, html, "<script>")
	notContains(t, html, "data:text/html")
	notContains(t, html, "javascript:")
}

func TestPreservesRoutingTokensAndAttachmentEmbeds(t *testing.T) {
	html := render(t, RenderOptions{
		Markdown:   "[[Note#Part|read]] ![[pic.png]]",
		SourcePath: "Home.md",
		VaultIndex: linkresolver.CreateVaultPathIndex([]linkresolver.VaultPathEntry{
			{FileID: "note", Path: "Note.md", Kind: "markdown"},
			{FileID: "pic", Path: "pic.png", Kind: "attachment"},
		}),
		AttachmentURL: func(string) string { return "/files/pic" },
	})
	contains(t, html, `data-link-path="Note"`)
	contains(t, html, `data-subpath="Part"`)
	contains(t, html, `<img src="/files/pic"`)
}

func TestFileIDsAndUnresolvedMarkers(t *testing.T) {
	html := render(t, RenderOptions{
		Markdown:   "[[Note#Part|read]] [other](Other.md) [[Missing]] [gone](Gone.md)",
		SourcePath: "Home.md",
		VaultIndex: linkresolver.CreateVaultPathIndex([]linkresolver.VaultPathEntry{
			{FileID: "note-id", Path: "Note.md", Kind: "markdown"},
			{FileID: "other-id", Path: "Other.md", Kind: "markdown"},
		}),
	})
	contains(t, html, `data-file-id="note-id"`)
	contains(t, html, `data-file-id="other-id"`)
	contains(t, html, `data-unresolved-target="Missing"`)
	contains(t, html, `data-unresolved-target="Gone.md"`)
}

func TestCodeExamplesAreNotLinks(t *testing.T) {
	html := render(t, RenderOptions{Markdown: "`[[not a link]]`", SourcePath: "Home.md"})
	contains(t, html, "<code>[[not a link]]</code>")
	notContains(t, html, "data-link-path")
}

func TestBlockquotes(t *testing.T) {
	html := render(t, RenderOptions{Markdown: "> outer\n>> nested", SourcePath: "Home.md"})
	contains(t, html, "<blockquote>")
	contains(t, html, "outer")
	contains(t, html, "<blockquote>\n<p>nested</p>")
}

func TestChecklists(t *testing.T) {
	html := render(t, RenderOptions{Markdown: "- [ ] todo\n- [x] done", SourcePath: "Home.md"})
	contains(t, html, `<ul class="contains-task-list">`)
	contains(t, html, `class="task-list-item"`)
	contains(t, html, "checked")
	if n := strings.Count(html, "<ul"); n != 1 {
		t.Errorf("ul count %d", n)
	}
}

func TestTables(t *testing.T) {
	html := render(t, RenderOptions{Markdown: "| Directive | Meaning |\n| --------- | ------- |\n| `max-age` | Freshness |", SourcePath: "Home.md"})
	contains(t, html, "<table>")
	contains(t, html, "<th>Directive</th>")
	contains(t, html, "<td><code>max-age</code></td>")
}

func TestPipesWithoutDelimiterAreNotTables(t *testing.T) {
	notContains(t, render(t, RenderOptions{Markdown: "a | b\njust text", SourcePath: "Home.md"}), "<table>")
}

func TestWikilinkAliasPipesStayInCell(t *testing.T) {
	html := render(t, RenderOptions{Markdown: "| Feature | Example |\n| ------- | ------- |\n| Link | [[Engineering/SQLite|SQLite]] |", SourcePath: "Home.md"})
	contains(t, html, "<table>")
	contains(t, html, `<td><a href="#" class="tephra-link" data-link-path="Engineering/SQLite">SQLite</a></td>`)
}

func TestCallouts(t *testing.T) {
	html := render(t, RenderOptions{Markdown: "> [!note]\n> Body text.", SourcePath: "Home.md"})
	contains(t, html, `<div class="callout" data-callout="note">`)
	contains(t, html, `callout-title-inner">Note</div>`)
	contains(t, html, `<div class="callout-content">`)
	notContains(t, html, "<blockquote>")

	custom := render(t, RenderOptions{Markdown: "> [!tip] Custom\n> Body.", SourcePath: "Home.md"})
	contains(t, custom, `callout-title-inner">Custom</div>`)
	collapsed := render(t, RenderOptions{Markdown: "> [!faq]- Title\n> Body.", SourcePath: "Home.md"})
	contains(t, collapsed, `<details class="callout" data-callout="faq">`)
	notContains(t, collapsed, " open>")
	expanded := render(t, RenderOptions{Markdown: "> [!faq]+ Title\n> Body.", SourcePath: "Home.md"})
	contains(t, expanded, `<details class="callout" data-callout="faq" open>`)
}

func TestUnknownCalloutFallsBackToNote(t *testing.T) {
	html := render(t, RenderOptions{Markdown: "> [!bogus]\n> Body.", SourcePath: "Home.md"})
	contains(t, html, `data-callout="bogus"`)
	contains(t, html, `callout-title-inner">Bogus</div>`)
}

func TestFenceLanguageClass(t *testing.T) {
	r := func(md string) string { return render(t, RenderOptions{Markdown: md, SourcePath: "Home.md"}) }
	contains(t, r("```ts title=\"a\"\nconst a = 1;\n```"), `<pre><code class="language-ts">const a = 1;</code></pre>`)
	contains(t, r("~~~python\nprint(1)\n~~~"), `class="language-python"`)
	contains(t, r("```\nplain\n```"), `<pre><code>plain</code></pre>`)
	contains(t, r("```\"><script>\nx\n```"), `<pre><code>x</code></pre>`)
}

func TestInvalidCodePointReferenceFails(t *testing.T) {
	if _, err := RenderMarkdown(RenderOptions{Markdown: "[x](&#x110000;)", SourcePath: "a.md"}); err == nil {
		t.Fatal("expected error")
	}
}
