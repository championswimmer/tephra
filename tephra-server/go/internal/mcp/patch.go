package mcp

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"
)

// PatchError is a unified-diff application/parse failure (shown to the model).
type PatchError struct{ Message string }

func (e *PatchError) Error() string { return e.Message }

type hunk struct {
	oldStart int
	oldLines []string
	newLines []string
}

var hunkHeaderRE = regexp.MustCompile(`^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@`)

// jsonQuote is JSON.stringify for a string.
func jsonQuote(s string) string {
	var sb strings.Builder
	sb.WriteByte('"')
	for _, r := range s {
		switch {
		case r == '"':
			sb.WriteString(`\"`)
		case r == '\\':
			sb.WriteString(`\\`)
		case r == '\b':
			sb.WriteString(`\b`)
		case r == '\f':
			sb.WriteString(`\f`)
		case r == '\n':
			sb.WriteString(`\n`)
		case r == '\r':
			sb.WriteString(`\r`)
		case r == '\t':
			sb.WriteString(`\t`)
		case r < 0x20:
			sb.WriteString(`\u00`)
			sb.WriteByte("0123456789abcdef"[r>>4])
			sb.WriteByte("0123456789abcdef"[r&15])
		default:
			sb.WriteRune(r)
		}
	}
	sb.WriteByte('"')
	return sb.String()
}

// sliceUTF16 is s.slice(0, n) for JavaScript strings.
func sliceUTF16(s string, n int) string {
	u := utf16.Encode([]rune(s))
	if len(u) <= n {
		return s
	}
	return string(utf16.Decode(u[:n]))
}

func parseHunks(patch string) ([]*hunk, error) {
	lines := strings.Split(strings.ReplaceAll(patch, "\r\n", "\n"), "\n")
	if lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	var hunks []*hunk
	var current *hunk
	for _, line := range lines {
		if m := hunkHeaderRE.FindStringSubmatch(line); m != nil {
			f, _ := strconv.ParseFloat(m[1], 64)
			current = &hunk{oldStart: int(math.Min(f, 1e15)), oldLines: []string{}, newLines: []string{}}
			hunks = append(hunks, current)
			continue
		}
		if current == nil {
			continue // file headers (---/+++/diff/index) before the first hunk
		}
		if strings.HasPrefix(line, "\\") {
			continue // "\ No newline at end of file"
		}
		switch {
		case strings.HasPrefix(line, "-"):
			current.oldLines = append(current.oldLines, line[1:])
		case strings.HasPrefix(line, "+"):
			current.newLines = append(current.newLines, line[1:])
		case strings.HasPrefix(line, " "):
			current.oldLines = append(current.oldLines, line[1:])
			current.newLines = append(current.newLines, line[1:])
		case line == "":
			// Blank context line whose leading space was stripped by the sender.
			current.oldLines = append(current.oldLines, "")
			current.newLines = append(current.newLines, "")
		default:
			return nil, &PatchError{"Unrecognised patch line: " + jsonQuote(sliceUTF16(line, 40))}
		}
	}
	if len(hunks) == 0 {
		return nil, &PatchError{`Patch contains no "@@ -a,b +c,d @@" hunks.`}
	}
	return hunks, nil
}

func matchesAt(source []string, at int, expected []string) bool {
	if at < 0 || at+len(expected) > len(source) {
		return false
	}
	for i, line := range expected {
		if source[at+i] != line {
			return false
		}
	}
	return true
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

// ApplyUnifiedDiff applies a unified diff. Context and removed lines must
// match the source exactly; line numbers are only a hint (the closest exact
// match wins), so small offsets from earlier edits are tolerated but nothing
// is guessed. Failures are *PatchError.
func ApplyUnifiedDiff(source, patch string) (string, error) {
	lines := strings.Split(source, "\n")
	drift, cursor := 0, 0
	hunks, err := parseHunks(patch)
	if err != nil {
		return "", err
	}
	for index, h := range hunks {
		hint := h.oldStart - 1 + drift
		if hint < 0 {
			hint = 0
		}
		at := -1
		if len(h.oldLines) == 0 {
			at = h.oldStart + drift // pure insertion: after line oldStart
			if at > len(lines) {
				at = len(lines)
			}
		} else {
			best := math.MaxInt
			for candidate := cursor; candidate+len(h.oldLines) <= len(lines); candidate++ {
				if matchesAt(lines, candidate, h.oldLines) && abs(candidate-hint) < best {
					best = abs(candidate - hint)
					at = candidate
				}
			}
		}
		if at < 0 || at < cursor {
			return "", &PatchError{fmt.Sprintf("Hunk %d does not apply: its context/removed lines were not found in the current note. Re-read the note and regenerate the patch.", index+1)}
		}
		next := make([]string, 0, len(lines)-len(h.oldLines)+len(h.newLines))
		next = append(next, lines[:at]...)
		next = append(next, h.newLines...)
		next = append(next, lines[at+len(h.oldLines):]...)
		lines = next
		drift = at + len(h.newLines) - (h.oldStart - 1 + len(h.oldLines))
		cursor = at + len(h.newLines)
	}
	return strings.Join(lines, "\n"), nil
}
