package markdown

import (
	"regexp"
	"sort"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/championswimmer/tephra/tephra-server/go/internal/jstext"
)

const hole rune = -1 // an array hole: joins as the empty string

// fenceAt emulates /^(\s*)(`{3,}|~{3,})/ applied to chars[index:].
func fenceAt(chars []rune, index int) (marker rune, length int, ok bool) {
	j := index
	for j < len(chars) && chars[j] >= 0 && jstext.IsSpace(chars[j]) {
		j++
	}
	if j >= len(chars) || (chars[j] != '`' && chars[j] != '~') {
		return 0, 0, false
	}
	marker = chars[j]
	k := j
	for k < len(chars) && chars[k] == marker {
		k++
	}
	if k-j < 3 {
		return 0, 0, false
	}
	return marker, k - j, true
}

func indexOf16(hay []uint16, tick uint16, n, from int) int {
	for i := from; i+n <= len(hay); i++ {
		match := true
		for k := 0; k < n; k++ {
			if hay[i+k] != tick {
				match = false
				break
			}
		}
		if match {
			return i
		}
	}
	return -1
}

// maskedCodeRanges replaces fenced and inline code with spaces (keeping
// newlines). It reproduces the TS implementation bug-for-bug, including the
// mixing of code-point indices (chars) with UTF-16 indices (indexOf).
func maskedCodeRanges(markdown string) string {
	chars := []rune(markdown)
	md16 := utf16.Encode(chars)
	inFence := false
	var fenceChar rune
	fenceLen := 0
	for index := 0; index < len(chars); {
		lineStart := index == 0 || chars[index-1] == '\n'
		if lineStart {
			if marker, length, ok := fenceAt(chars, index); ok {
				if !inFence {
					inFence, fenceChar, fenceLen = true, marker, length
				} else if fenceChar == marker && length >= fenceLen {
					inFence = false
				}
			}
		}
		if inFence {
			if chars[index] != '\n' {
				chars[index] = ' '
			}
			index++
			continue
		}
		if chars[index] == '`' {
			ticks := 1
			for index+ticks < len(chars) && chars[index+ticks] == '`' {
				ticks++
			}
			closing := indexOf16(md16, '`', ticks, index+ticks)
			if closing >= 0 {
				for cursor := index; cursor < closing+ticks; cursor++ {
					for cursor >= len(chars) {
						chars = append(chars, hole)
					}
					if chars[cursor] != '\n' {
						chars[cursor] = ' '
					}
				}
				index = closing + ticks
				continue
			}
		}
		index++
	}
	var b strings.Builder
	for _, r := range chars {
		if r != hole {
			b.WriteRune(r)
		}
	}
	return b.String()
}

var (
	wikiRe     = regexp.MustCompile(`(!?)\[\[([^\]\n]+)\]\]`)
	mdLinkRe   = regexp.MustCompile(`(!?)\[([^\]\n]*)\]\(([^)\n]+)\)`)
	linkTitleD = regexp.MustCompile(`^(` + notSp + `+)(?:` + sp + `+["'](?:` + dot + `)*["'])$`)
)

func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

func slice16(s []uint16, a, b int) string {
	if a < 0 {
		a = 0
	}
	if b > len(s) {
		b = len(s)
	}
	if a >= b {
		return ""
	}
	return string(utf16.Decode(s[a:b]))
}

func strPtr(s string) *string { return &s }

func parseLinks(body string) []ParsedLink {
	masked := maskedCodeRanges(body)
	body16 := utf16.Encode([]rune(body))
	type found struct {
		index int
		link  ParsedLink
	}
	var all []found
	type span struct{ start, end int }
	var occupied []span
	ascii := utf8.RuneCountInString(masked) == len(masked)
	off := func(b int) int {
		if ascii {
			return b
		}
		return utf16Len(masked[:b])
	}
	for _, loc := range wikiRe.FindAllStringSubmatchIndex(masked, -1) {
		index := off(loc[0])
		length := off(loc[1]) - index
		raw := slice16(body16, index, index+length)
		inner := strings.Split(masked[loc[4]:loc[5]], "|")
		linkPath, subpath := splitTarget(inner[0])
		if linkPath == "" {
			continue
		}
		link := ParsedLink{Raw: raw, LinkPath: linkPath, IsEmbed: loc[3] > loc[2], Syntax: SyntaxWiki}
		if subpath != "" {
			link.Subpath = strPtr(subpath)
		}
		if len(inner) > 1 {
			link.DisplayText = strPtr(jstext.Trim(strings.Join(inner[1:], "|")))
		}
		all = append(all, found{index, link})
		occupied = append(occupied, span{index, index + length})
	}
	for _, loc := range mdLinkRe.FindAllStringSubmatchIndex(masked, -1) {
		index := off(loc[0])
		skip := false
		for _, o := range occupied {
			if index >= o.start && index < o.end {
				skip = true
				break
			}
		}
		if skip {
			continue
		}
		length := off(loc[1]) - index
		destination := jstext.Trim(masked[loc[6]:loc[7]])
		if strings.HasPrefix(destination, "<") && strings.HasSuffix(destination, ">") {
			if len(destination) >= 2 {
				destination = destination[1 : len(destination)-1]
			} else {
				destination = ""
			}
		}
		if m := linkTitleD.FindStringSubmatch(destination); m != nil {
			destination = m[1]
		}
		linkPath, subpath := splitTarget(destination)
		link := ParsedLink{
			Raw: slice16(body16, index, index+length), LinkPath: linkPath,
			DisplayText: strPtr(masked[loc[4]:loc[5]]), IsEmbed: loc[3] > loc[2], Syntax: SyntaxMarkdown,
		}
		if subpath != "" {
			link.Subpath = strPtr(subpath)
		}
		all = append(all, found{index, link})
	}
	sort.SliceStable(all, func(i, j int) bool { return all[i].index < all[j].index })
	out := make([]ParsedLink, len(all))
	for i, f := range all {
		out[i] = f.link
	}
	return out
}

func frontmatterTags(fm Frontmatter) []string {
	value, ok := fm.Get("tags")
	if !ok || value == nil {
		value, _ = fm.Get("tag")
	}
	var items []string
	switch v := value.(type) {
	case []any:
		for _, item := range v {
			if s, ok := item.(string); ok {
				items = append(items, s)
			}
		}
	case string:
		items = strings.FieldsFunc(v, func(r rune) bool { return r == ' ' || r == ',' })
	}
	var out []string
	for _, tag := range items {
		tag = strings.TrimPrefix(tag, "#")
		if tag != "" {
			out = append(out, tag)
		}
	}
	return out
}

var (
	headingRe = regexp.MustCompile(`^(#{1,6})` + sp + `+(` + dot + `+?)` + sp + `*#*` + sp + `*$`)
	blockRe   = regexp.MustCompile(`(?:^|` + sp + `)\^([A-Za-z0-9-]+)` + sp + `*$`)
	tagRe     = regexp.MustCompile(`(^|[` + jstext.SpaceClass + `(])#([\p{L}\p{N}_/-]+)`)
)

// ParseNote extracts frontmatter, headings, tags, block ids and links.
func ParseNote(markdown string) ParsedNote {
	fm, body, offset := readFrontmatter(markdown)
	masked := maskedCodeRanges(body)
	headings := []HeadingInfo{}
	blocks := []BlockInfo{}
	tags := []string{}
	seen := map[string]bool{}
	addTag := func(t string) {
		if t != "" && !seen[t] {
			seen[t] = true
			tags = append(tags, t)
		}
	}
	for _, t := range frontmatterTags(fm) {
		addTag(t)
	}
	lines := strings.Split(body, "\n")
	maskedLines := strings.Split(masked, "\n")
	for index := range lines {
		safeLine := ""
		if index < len(maskedLines) {
			safeLine = maskedLines[index]
		}
		if m := headingRe.FindStringSubmatch(safeLine); m != nil {
			text := jstext.Trim(m[2])
			headings = append(headings, HeadingInfo{Level: len(m[1]), Text: text, Slug: slugify(text), Line: index + offset + 1})
		}
		for _, m := range blockRe.FindAllStringSubmatch(safeLine, -1) {
			blocks = append(blocks, BlockInfo{ID: m[1], Line: index + offset + 1})
		}
		for _, m := range tagRe.FindAllStringSubmatch(safeLine, -1) {
			addTag(m[2])
		}
	}
	return ParsedNote{Frontmatter: fm, Headings: headings, Tags: tags, Blocks: blocks, Links: parseLinks(body)}
}
