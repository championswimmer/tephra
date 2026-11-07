package markdown

import (
	"regexp"
	"strings"

	"github.com/championswimmer/tephra/tephra-server/go/internal/jstext"
)

var (
	sp    = `[` + jstext.SpaceClass + `]`
	notSp = `[^` + jstext.SpaceClass + `]`
	dot   = jstext.Dot
)

var htmlEscaper = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&#39;")

func escapeHTML(value string) string { return htmlEscaper.Replace(value) }

var slugStripRe = regexp.MustCompile(`[^\p{L}\p{N}` + jstext.SpaceClass + `-]`)
var slugSpaceRe = regexp.MustCompile(sp + `+`)

func slugify(value string) string {
	v := jstext.Lower(jstext.Trim(value))
	v = slugStripRe.ReplaceAllString(v, "")
	return slugSpaceRe.ReplaceAllString(v, "-")
}

// splitTarget splits `path#sub`; subpath is "" when absent or empty.
func splitTarget(value string) (linkPath, subpath string) {
	hash := strings.IndexByte(value, '#')
	if hash < 0 {
		return jstext.Trim(value), ""
	}
	return jstext.Trim(value[:hash]), jstext.Trim(value[hash+1:])
}

// replaceAll replaces every match of re in s using f, which receives the
// submatch strings (unmatched groups are "").
func replaceAll(re *regexp.Regexp, s string, f func(m []string) string) string {
	locs := re.FindAllStringSubmatchIndex(s, -1)
	if locs == nil {
		return s
	}
	var b strings.Builder
	last := 0
	for _, loc := range locs {
		b.WriteString(s[last:loc[0]])
		m := make([]string, len(loc)/2)
		for i := range m {
			if loc[2*i] >= 0 {
				m[i] = s[loc[2*i]:loc[2*i+1]]
			}
		}
		b.WriteString(f(m))
		last = loc[1]
	}
	b.WriteString(s[last:])
	return b.String()
}
