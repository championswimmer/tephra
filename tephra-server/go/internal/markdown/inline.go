package markdown

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/championswimmer/tephra/tephra-server/go/internal/jstext"
	"github.com/championswimmer/tephra/tephra-server/go/internal/linkresolver"
)

// renderPanic carries an error that the TS implementation surfaces as a thrown
// exception (String.fromCodePoint RangeError); RenderMarkdown recovers it.
type renderPanic struct{ err error }

var (
	entityRe = regexp.MustCompile(`&#(?:[xX]([0-9a-fA-F]+)|([0-9]+));?`)
	schemeRe = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9+.-]*:`)
	uriRe    = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:` + notSp + `*$`)
	emailRe  = regexp.MustCompile(`^[a-zA-Z0-9.!#$%&'*+/=?^_` + "`" + `{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$`)
	autoRe   = regexp.MustCompile(`<([^` + jstext.SpaceClass + `<>]+)>`)
	boldRe   = regexp.MustCompile(`\*\*([^*]+)\*\*`)
	emRe     = regexp.MustCompile(`\*([^*]+)\*`)
	tokenRe  = regexp.MustCompile("([0-9]+)")
	mdLinkIn = regexp.MustCompile(`(!?)\[([^\]\n]*)\]\(([^)\n]+)\)`)
)

var errInvalidCodePoint = fmt.Errorf("markdown: invalid code point in character reference")

// safeHref returns ok=false for javascript:, data: and vbscript: URLs
// (including entity- and whitespace-obfuscated forms).
func safeHref(value string) (string, bool) {
	decoded := replaceAll(entityRe, value, func(m []string) string {
		var n uint64
		var err error
		if m[1] != "" {
			n, err = strconv.ParseUint(m[1], 16, 32)
		} else {
			n, err = strconv.ParseUint(m[2], 10, 32)
		}
		if err != nil || n > 0x10FFFF {
			panic(renderPanic{errInvalidCodePoint})
		}
		if n >= 0xD800 && n <= 0xDFFF {
			return "�"
		}
		return string(rune(n))
	})
	var b strings.Builder
	for _, r := range decoded {
		if r > 0x20 {
			b.WriteRune(r)
		}
	}
	compact := jstext.Lower(b.String())
	if strings.HasPrefix(compact, "javascript:") || strings.HasPrefix(compact, "data:") || strings.HasPrefix(compact, "vbscript:") {
		return "", false
	}
	return value, true
}

func resolveForRender(o *RenderOptions, target string) (RenderTarget, bool) {
	if o.ResolveLink != nil {
		return o.ResolveLink(o.SourcePath, target), true
	}
	if o.VaultIndex != nil {
		r := linkresolver.ResolveLink(o.SourcePath, target, o.VaultIndex)
		return RenderTarget{TargetFileID: r.TargetFileID, TargetPath: r.TargetPath, Unresolved: r.Unresolved, Ambiguous: r.Ambiguous, TargetKind: r.TargetKind}, true
	}
	return RenderTarget{}, false
}

func linkState(r RenderTarget, ok bool) string {
	if ok && r.Ambiguous {
		return "tephra-ambiguous"
	}
	if ok && r.Unresolved {
		return "tephra-unresolved"
	}
	return "tephra-link"
}

func fileAttrs(r RenderTarget, ok bool, linkPath string) (fileAttr, missingAttr string) {
	if ok && r.TargetFileID != "" {
		fileAttr = ` data-file-id="` + escapeHTML(r.TargetFileID) + `"`
	}
	if ok && r.TargetFileID == "" && r.Unresolved {
		missingAttr = ` data-unresolved-target="` + escapeHTML(linkPath) + `"`
	}
	return
}

// replaceCodeSpans emulates value.replace(/(`+)([^`]*?)\1/g, ...).
func replaceCodeSpans(s string, f func(code string) string) string {
	var out strings.Builder
	last := 0
	for i := 0; i < len(s); {
		if s[i] != '`' {
			i++
			continue
		}
		n := 0
		for i+n < len(s) && s[i+n] == '`' {
			n++
		}
		matched := false
		for k := n; k >= 1; k-- {
			j := i + k
			e := strings.IndexByte(s[j:], '`')
			if e < 0 {
				continue
			}
			e += j
			run := 0
			for e+run < len(s) && s[e+run] == '`' {
				run++
			}
			if run >= k {
				out.WriteString(s[last:i])
				out.WriteString(f(s[j:e]))
				last = e + k
				i = last
				matched = true
				break
			}
		}
		if !matched {
			i++
		}
	}
	out.WriteString(s[last:])
	return out.String()
}

func renderInline(value string, o *RenderOptions) string {
	var tokens []string
	store := func(html string) string {
		tokens = append(tokens, html)
		return "" + strconv.Itoa(len(tokens)-1) + ""
	}
	output := replaceCodeSpans(value, func(code string) string {
		return store("<code>" + escapeHTML(code) + "</code>")
	})
	output = replaceAll(wikiRe, output, func(m []string) string {
		bang, inner := m[1], m[2]
		parts := strings.Split(inner, "|")
		linkPath, subpath := splitTarget(parts[0])
		display := strings.Join(parts[1:], "|")
		if display == "" {
			display = subpath
		}
		if display == "" {
			display = linkPath
		}
		full := linkPath
		if subpath != "" {
			full += "#" + subpath
		}
		resolved, ok := resolveForRender(o, full)
		attrs := `data-link-path="` + escapeHTML(linkPath) + `"`
		if subpath != "" {
			attrs += ` data-subpath="` + escapeHTML(subpath) + `"`
		}
		kind := resolved.TargetKind
		if kind == "" {
			kind = resolved.Kind
		}
		if bang == "!" && ok && resolved.TargetFileID != "" && kind == "attachment" && o.AttachmentURL != nil {
			src, safe := safeHref(o.AttachmentURL(resolved.TargetFileID))
			if !safe {
				return store(`<span class="tephra-unresolved" ` + attrs + `>` + escapeHTML(display) + `</span>`)
			}
			return store(`<img src="` + escapeHTML(src) + `" alt="` + escapeHTML(display) + `" ` + attrs + `>`)
		}
		embed := ""
		if bang == "!" {
			embed = ` data-embed="true"`
		}
		fileAttr, missingAttr := fileAttrs(resolved, ok, linkPath)
		return store(`<a href="#" class="` + linkState(resolved, ok) + `" ` + attrs + fileAttr + missingAttr + embed + `>` + escapeHTML(display) + `</a>`)
	})
	output = replaceAll(mdLinkIn, output, func(m []string) string {
		bang, label := m[1], m[2]
		destination := jstext.Trim(m[3])
		destination = strings.TrimPrefix(destination, "<")
		destination = strings.TrimSuffix(destination, ">")
		href, safe := safeHref(destination)
		if !safe {
			return store(`<span class="tephra-unsafe-link">` + escapeHTML(label) + `</span>`)
		}
		external := schemeRe.MatchString(destination) || strings.HasPrefix(destination, "//")
		if !external {
			linkPath, subpath := splitTarget(destination)
			resolved, ok := resolveForRender(o, destination)
			fileAttr, missingAttr := fileAttrs(resolved, ok, linkPath)
			sub := ""
			if subpath != "" {
				sub = ` data-subpath="` + escapeHTML(subpath) + `"`
			}
			return store(`<a href="#" class="` + linkState(resolved, ok) + `" data-link-path="` + escapeHTML(linkPath) + `"` + sub + fileAttr + missingAttr + `>` + escapeHTML(label) + `</a>`)
		}
		if bang == "!" {
			return store(`<img src="` + escapeHTML(href) + `" alt="` + escapeHTML(label) + `">`)
		}
		return store(`<a href="` + escapeHTML(href) + `" rel="noopener noreferrer">` + escapeHTML(label) + `</a>`)
	})
	// CommonMark/GFM autolinks: <scheme:uri> and <email@host>.
	output = replaceAll(autoRe, output, func(m []string) string {
		raw, inner := m[0], m[1]
		isURI := uriRe.MatchString(inner)
		isEmail := emailRe.MatchString(inner)
		if !isURI && !isEmail {
			return raw
		}
		target := inner
		if isEmail {
			target = "mailto:" + inner
		}
		href, safe := safeHref(target)
		if !safe {
			return raw
		}
		return store(`<a href="` + escapeHTML(href) + `" rel="noopener noreferrer">` + escapeHTML(inner) + `</a>`)
	})
	output = escapeHTML(output)
	output = boldRe.ReplaceAllString(output, "<strong>$1</strong>")
	output = emRe.ReplaceAllString(output, "<em>$1</em>")
	return replaceAll(tokenRe, output, func(m []string) string {
		n, err := strconv.Atoi(m[1])
		if err != nil || n < 0 || n >= len(tokens) {
			return ""
		}
		return tokens[n]
	})
}
