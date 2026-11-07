package markdown

import (
	"regexp"
	"strings"

	"github.com/championswimmer/tephra/tephra-server/go/internal/jstext"
)

// tableAlign is "left", "center", "right" or "" (none).
type tableAlign string

// splitTableRow splits a GFM table row on unescaped pipes, stripping optional
// outer pipes. Pipes inside [[wikilinks|alias]], [...] labels and backtick code
// spans do not split cells. ok is false when the line has no splitting pipe.
func splitTableRow(line string) (cells []string, ok bool) {
	runes := []rune(line)
	var current strings.Builder
	escaped, hasPipe, inWiki, inCode := false, false, false, false
	bracketDepth := 0
	at := func(i int) rune {
		if i < len(runes) {
			return runes[i]
		}
		return -1
	}
	for index := 0; index < len(runes); {
		ch := runes[index]
		if escaped {
			if ch == '|' {
				current.WriteRune('|')
			} else {
				current.WriteRune('\\')
				current.WriteRune(ch)
			}
			escaped = false
			index++
			continue
		}
		if ch == '\\' {
			escaped = true
			index++
			continue
		}
		if ch == '`' {
			run := 1
			for at(index+run) == '`' {
				run++
			}
			current.WriteString(strings.Repeat("`", run))
			index += run
			inCode = !inCode
			continue
		}
		if !inCode {
			if !inWiki && ch == '[' && at(index+1) == '[' {
				inWiki = true
				current.WriteString("[[")
				index += 2
				continue
			}
			if inWiki && ch == ']' && at(index+1) == ']' {
				inWiki = false
				current.WriteString("]]")
				index += 2
				continue
			}
			if !inWiki {
				if ch == '[' {
					bracketDepth++
				} else if ch == ']' && bracketDepth > 0 {
					bracketDepth--
				}
			}
		}
		if ch == '|' && !inWiki && !inCode && bracketDepth == 0 {
			hasPipe = true
			cells = append(cells, current.String())
			current.Reset()
			index++
			continue
		}
		current.WriteRune(ch)
		index++
	}
	if escaped {
		current.WriteRune('\\')
	}
	cells = append(cells, current.String())
	if !hasPipe {
		return nil, false
	}
	if len(cells) > 0 && jstext.Trim(cells[0]) == "" {
		cells = cells[1:]
	}
	if len(cells) > 0 && jstext.Trim(cells[len(cells)-1]) == "" {
		cells = cells[:len(cells)-1]
	}
	for i := range cells {
		cells[i] = jstext.Trim(cells[i])
	}
	if cells == nil {
		cells = []string{}
	}
	return cells, true
}

var delimiterRe = regexp.MustCompile(`^(:?)-+(:?)$`)

// parseTableDelimiter parses a GFM delimiter row; ok is false if invalid.
func parseTableDelimiter(line string) (aligns []tableAlign, ok bool) {
	cells, has := splitTableRow(line)
	if !has || len(cells) == 0 {
		return nil, false
	}
	for _, cell := range cells {
		m := delimiterRe.FindStringSubmatch(cell)
		if m == nil {
			return nil, false
		}
		left, right := m[1] == ":", m[2] == ":"
		switch {
		case left && right:
			aligns = append(aligns, "center")
		case right:
			aligns = append(aligns, "right")
		case left:
			aligns = append(aligns, "left")
		default:
			aligns = append(aligns, "")
		}
	}
	return aligns, true
}
