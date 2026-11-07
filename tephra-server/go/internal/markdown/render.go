package markdown

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/championswimmer/tephra/tephra-server/go/internal/jstext"
)

var (
	fenceLangRe = regexp.MustCompile(`^[\w+#.-]+$`)
	quoteRe     = regexp.MustCompile(`^ {0,3}>` + sp + `?(` + dot + `*)$`)
	fenceRe     = regexp.MustCompile(`^` + sp + `*(` + "`{3,}|~{3,}" + `)(` + dot + `*)$`)
	listRe      = regexp.MustCompile(`^` + sp + `*[-*+]` + sp + `+(` + dot + `*)$`)
	taskRe      = regexp.MustCompile(`^\[([ xX])\]` + sp + `*(` + dot + `*)$`)
	calloutRe   = regexp.MustCompile(`^\[!(\w[\w-]*)\]([+-]?)` + sp + `*(` + dot + `*)$`)
)

// fenceLanguage returns the first word of a fence info string if it only
// contains safe class-name characters.
func fenceLanguage(info string) string {
	word := jstext.Trim(info)
	if i := strings.IndexFunc(word, jstext.IsSpace); i >= 0 {
		word = word[:i]
	}
	if fenceLangRe.MatchString(word) {
		return word
	}
	return ""
}

func renderCodeBlock(code []string, language string) string {
	cls := ""
	if language != "" {
		cls = ` class="language-` + language + `"`
	}
	return "<pre><code" + cls + ">" + escapeHTML(strings.Join(code, "\n")) + "</code></pre>"
}

type listItem struct {
	checked *bool
	content string
}

func renderBlocks(lines []string, o *RenderOptions) []string {
	var html []string
	inFence := false
	var fence byte
	fenceLang := ""
	var code, paragraph, quoteBuffer []string
	var listBuffer []listItem
	flushParagraph := func() {
		if len(paragraph) > 0 {
			html = append(html, "<p>"+strings.ReplaceAll(renderInline(strings.Join(paragraph, "\n"), o), "\n", "<br>")+"</p>")
		}
		paragraph = nil
	}
	flushList := func() {
		if len(listBuffer) == 0 {
			return
		}
		hasTask := false
		items := make([]string, len(listBuffer))
		for i, item := range listBuffer {
			if item.checked != nil {
				hasTask = true
				checkedAttr := ""
				if *item.checked {
					checkedAttr = " checked"
				}
				items[i] = `<li class="task-list-item"><input type="checkbox" disabled` + checkedAttr + `> ` + renderInline(item.content, o) + `</li>`
			} else {
				items[i] = "<li>" + renderInline(item.content, o) + "</li>"
			}
		}
		joined := strings.Join(items, "\n")
		if hasTask {
			html = append(html, "<ul class=\"contains-task-list\">\n"+joined+"\n</ul>")
		} else {
			html = append(html, "<ul>\n"+joined+"\n</ul>")
		}
		listBuffer = nil
	}
	flushQuote := func() {
		if len(quoteBuffer) == 0 {
			return
		}
		if head := calloutRe.FindStringSubmatch(quoteBuffer[0]); head != nil {
			html = append(html, renderCallout(head[1], head[2], head[3], quoteBuffer[1:],
				func(v string) string { return renderInline(v, o) },
				func(l []string) []string { return renderBlocks(l, o) }))
		} else {
			inner := strings.Join(renderBlocks(quoteBuffer, o), "\n")
			if jstext.Trim(inner) != "" {
				html = append(html, "<blockquote>\n"+inner+"\n</blockquote>")
			}
		}
		quoteBuffer = nil
	}
	for index := 0; index < len(lines); index++ {
		line := lines[index]
		if quote := quoteRe.FindStringSubmatch(line); quote != nil {
			flushParagraph()
			flushList()
			quoteBuffer = append(quoteBuffer, quote[1])
			continue
		}
		if fm := fenceRe.FindStringSubmatch(line); fm != nil {
			marker := fm[1]
			if !inFence {
				flushParagraph()
				flushQuote()
				flushList()
				inFence, fence, fenceLang, code = true, marker[0], fenceLanguage(fm[2]), nil
			} else if marker[0] == fence {
				html = append(html, renderCodeBlock(code, fenceLang))
				inFence = false
			}
			continue
		}
		if inFence {
			code = append(code, line)
			continue
		}
		if jstext.Trim(line) == "" {
			if len(quoteBuffer) > 0 {
				flushList()
				quoteBuffer = append(quoteBuffer, "")
			} else {
				flushParagraph()
				flushList()
			}
			continue
		}
		if h := headingRe.FindStringSubmatch(line); h != nil {
			flushParagraph()
			flushQuote()
			flushList()
			text := h[2]
			level := strconv.Itoa(len(h[1]))
			html = append(html, "<h"+level+` id="`+escapeHTML(slugify(text))+`">`+renderInline(text, o)+"</h"+level+">")
			continue
		}
		if lm := listRe.FindStringSubmatch(line); lm != nil {
			flushParagraph()
			flushQuote()
			rest := lm[1]
			if task := taskRe.FindStringSubmatch(rest); task != nil {
				checked := strings.ToLower(task[1]) == "x"
				listBuffer = append(listBuffer, listItem{&checked, task[2]})
			} else {
				listBuffer = append(listBuffer, listItem{nil, rest})
			}
			continue
		}
		// GFM table: header row + delimiter row + consecutive body rows.
		if strings.Contains(line, "|") && index+1 < len(lines) {
			head, hok := splitTableRow(line)
			aligns, aok := parseTableDelimiter(lines[index+1])
			if hok && aok && len(head) > 0 && len(head) == len(aligns) {
				flushParagraph()
				flushQuote()
				flushList()
				var bodyRows [][]string
				cursor := index + 2
				for cursor < len(lines) {
					rowLine := lines[cursor]
					if jstext.Trim(rowLine) == "" {
						break
					}
					row, rok := splitTableRow(rowLine)
					if !rok {
						break
					}
					for len(row) < len(head) {
						row = append(row, "")
					}
					bodyRows = append(bodyRows, row[:len(head)])
					cursor++
				}
				alignAttr := func(a tableAlign) string {
					if a == "" {
						return ""
					}
					return ` align="` + string(a) + `"`
				}
				ths := make([]string, len(head))
				for i, cell := range head {
					ths[i] = "<th" + alignAttr(aligns[i]) + ">" + renderInline(cell, o) + "</th>"
				}
				thead := "<thead>\n<tr>\n" + strings.Join(ths, "\n") + "\n</tr>\n</thead>"
				tbody := ""
				if len(bodyRows) > 0 {
					trs := make([]string, len(bodyRows))
					for r, row := range bodyRows {
						tds := make([]string, len(row))
						for i, cell := range row {
							tds[i] = "<td" + alignAttr(aligns[i]) + ">" + renderInline(cell, o) + "</td>"
						}
						trs[r] = "<tr>\n" + strings.Join(tds, "\n") + "\n</tr>"
					}
					tbody = "\n<tbody>\n" + strings.Join(trs, "\n") + "\n</tbody>"
				}
				html = append(html, "<table>\n"+thead+tbody+"\n</table>")
				index = cursor - 1
				continue
			}
		}
		// Lazy continuation: a plain paragraph line directly after quote lines.
		if len(quoteBuffer) > 0 {
			flushList()
			quoteBuffer = append(quoteBuffer, line)
			continue
		}
		flushList()
		paragraph = append(paragraph, line)
	}
	flushParagraph()
	flushQuote()
	flushList()
	if inFence {
		html = append(html, renderCodeBlock(code, fenceLang))
	}
	return html
}

// RenderMarkdown parses and renders a note. Like the TS implementation it
// fails when a character reference in a link destination is not a valid
// Unicode code point (String.fromCodePoint RangeError).
func RenderMarkdown(options RenderOptions) (note RenderedNote, err error) {
	defer func() {
		if r := recover(); r != nil {
			if p, ok := r.(renderPanic); ok {
				note, err = RenderedNote{}, p.err
				return
			}
			panic(r)
		}
	}()
	parsed := ParseNote(options.Markdown)
	_, body, _ := readFrontmatter(options.Markdown)
	html := renderBlocks(strings.Split(body, "\n"), &options)
	return RenderedNote{ParsedNote: parsed, HTML: strings.Join(html, "\n")}, nil
}
