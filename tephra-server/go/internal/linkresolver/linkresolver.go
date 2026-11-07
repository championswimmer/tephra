// Package linkresolver resolves Obsidian-style link targets against a snapshot
// of vault paths. It is a behavioural port of packages/link-resolver.
package linkresolver

import (
	"encoding/json"
	"sort"
	"strings"

	"github.com/championswimmer/tephra/tephra-server/go/internal/jstext"
)

// Kind of a vault entry.
const (
	KindMarkdown   = "markdown"
	KindAttachment = "attachment"
)

// Link resolution statuses.
const (
	StatusResolved   = "resolved"
	StatusUnresolved = "unresolved"
	StatusAmbiguous  = "ambiguous"
)

// VaultPathEntry is one file in the vault snapshot.
type VaultPathEntry struct {
	FileID string `json:"fileId"`
	Path   string `json:"path"`
	Kind   string `json:"kind"`
}

type indexedEntry struct {
	entry      VaultPathEntry
	norm       string // normalize(entry.path)
	normOK     bool
	comparison string // noteComparisonPath(normalize(path) ?? path, kind)
}

// VaultPathIndex is an immutable snapshot of vault paths sorted like the TS
// createVaultPathIndex, with normalized forms precomputed.
type VaultPathIndex struct {
	Files   []VaultPathEntry
	entries []indexedEntry
}

// ResolveLinkResult mirrors the TS ResolveLinkResult. Empty strings stand for
// JSON null in TargetFileID, TargetPath, TargetKind and Subpath.
type ResolveLinkResult struct {
	TargetFileID string
	TargetPath   string
	TargetKind   string
	Subpath      string
	Status       string
	Unresolved   bool
	Ambiguous    bool
	Candidates   []string
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// MarshalJSON emits the same shape as the TS object (null for absent values).
func (r ResolveLinkResult) MarshalJSON() ([]byte, error) {
	candidates := r.Candidates
	if candidates == nil {
		candidates = []string{}
	}
	return json.Marshal(struct {
		TargetFileID any      `json:"targetFileId"`
		TargetPath   any      `json:"targetPath"`
		TargetKind   any      `json:"targetKind"`
		Subpath      any      `json:"subpath"`
		Status       string   `json:"status"`
		Unresolved   bool     `json:"unresolved"`
		Ambiguous    bool     `json:"ambiguous"`
		Candidates   []string `json:"candidates"`
	}{nullable(r.TargetFileID), nullable(r.TargetPath), nullable(r.TargetKind), nullable(r.Subpath), r.Status, r.Unresolved, r.Ambiguous, candidates})
}

// CreateVaultPathIndex sorts files by localeCompare on path (stable) and
// precomputes normalized paths.
func CreateVaultPathIndex(files []VaultPathEntry) *VaultPathIndex {
	sorted := append([]VaultPathEntry(nil), files...)
	sort.SliceStable(sorted, func(i, j int) bool { return jstext.LocaleCompare(sorted[i].Path, sorted[j].Path) < 0 })
	entries := make([]indexedEntry, len(sorted))
	for i, entry := range sorted {
		n, ok := normalize(entry.Path)
		base := n
		if !ok {
			base = entry.Path
		}
		entries[i] = indexedEntry{entry: entry, norm: n, normOK: ok, comparison: noteComparisonPath(base, entry.Kind)}
	}
	return &VaultPathIndex{Files: sorted, entries: entries}
}

func decode(value string) string {
	if decoded, ok := jstext.DecodeURIComponent(value); ok {
		return decoded
	}
	return value
}

// normalize mirrors the TS normalize; ok is false where TS returns null.
func normalize(value string) (string, bool) {
	decoded := jstext.NFC(decode(value))
	decoded = strings.ReplaceAll(decoded, `\`, "/")
	decoded = strings.TrimLeft(decoded, "/")
	decoded = strings.TrimRight(decoded, "/")
	var output []string
	for _, segment := range strings.Split(decoded, "/") {
		if segment == "" || segment == "." {
			continue
		}
		if segment == ".." {
			if len(output) == 0 {
				return "", false
			}
			output = output[:len(output)-1]
		} else {
			output = append(output, segment)
		}
	}
	return strings.Join(output, "/"), true
}

func hasMdSuffix(s string) bool {
	n := len(s)
	return n >= 3 && s[n-3] == '.' && (s[n-2]|0x20) == 'm' && (s[n-1]|0x20) == 'd' && s[n-2] < 0x80 && s[n-1] < 0x80
}

func stripMd(s string) string {
	if hasMdSuffix(s) {
		return s[:len(s)-3]
	}
	return s
}

func noteComparisonPath(path, kind string) string {
	if kind == KindMarkdown {
		return stripMd(path)
	}
	return path
}

func splitSubpath(input string) (path, subpath string) {
	hash := strings.IndexByte(input, '#')
	if hash < 0 {
		return input, ""
	}
	return input[:hash], decode(input[hash+1:])
}

func result(status string, entry *VaultPathEntry, subpath string, candidates []string) ResolveLinkResult {
	r := ResolveLinkResult{
		Subpath:    subpath,
		Status:     status,
		Unresolved: status != StatusResolved,
		Ambiguous:  status == StatusAmbiguous,
		Candidates: candidates,
	}
	if r.Candidates == nil {
		r.Candidates = []string{}
	}
	if entry != nil {
		r.TargetFileID, r.TargetPath, r.TargetKind = entry.FileID, entry.Path, entry.Kind
	}
	return r
}

func paths(matches []*indexedEntry) []string {
	out := make([]string, len(matches))
	for i, m := range matches {
		out[i] = m.entry.Path
	}
	return out
}

func choose(matches []*indexedEntry, subpath string) (ResolveLinkResult, bool) {
	if len(matches) == 1 {
		return result(StatusResolved, &matches[0].entry, subpath, nil), true
	}
	if len(matches) > 1 {
		return result(StatusAmbiguous, nil, subpath, paths(matches)), true
	}
	return ResolveLinkResult{}, false
}

func lastSegment(s string) string {
	if i := strings.LastIndexByte(s, '/'); i >= 0 {
		return s[i+1:]
	}
	return s
}

func folderOf(s string) string {
	if i := strings.LastIndexByte(s, '/'); i >= 0 {
		return s[:i]
	}
	return ""
}

// ResolveLink resolves an Obsidian target against a snapshot of current vault paths.
func ResolveLink(sourcePath, rawLinkPath string, index *VaultPathIndex) ResolveLinkResult {
	pathPart, subpath := splitSubpath(rawLinkPath)
	target, ok := normalize(pathPart)
	if !ok {
		return result(StatusUnresolved, nil, subpath, nil)
	}
	entries := index.entries
	normSource, normSourceOK := normalize(sourcePath)
	if target == "" {
		for i := range entries {
			if entries[i].normOK == normSourceOK && entries[i].norm == normSource {
				return result(StatusResolved, &entries[i].entry, subpath, nil)
			}
		}
		return result(StatusUnresolved, nil, subpath, nil)
	}
	targetWithoutMd := stripMd(target)

	// Explicit root-relative path has priority.
	var matches []*indexedEntry
	for i := range entries {
		e := &entries[i]
		if e.comparison == targetWithoutMd || (e.normOK && e.norm == target) {
			matches = append(matches, e)
		}
	}
	if r, ok := choose(matches, subpath); ok {
		return r
	}

	sourceBase := sourcePath
	if normSourceOK {
		sourceBase = normSource
	}
	sourceFolder := folderOf(sourceBase)
	joined := target
	if sourceFolder != "" {
		joined = sourceFolder + "/" + target
	}
	if relative, ok := normalize(joined); ok {
		relativeWithoutMd := stripMd(relative)
		matches = nil
		for i := range entries {
			e := &entries[i]
			if e.comparison == relativeWithoutMd || (e.normOK && e.norm == relative) {
				matches = append(matches, e)
			}
		}
		if r, ok := choose(matches, subpath); ok {
			return r
		}
	}

	// Folder-qualified links may omit leading folders. They resolve only when unique.
	if strings.Contains(targetWithoutMd, "/") {
		matches = nil
		for i := range entries {
			e := &entries[i]
			if e.comparison == targetWithoutMd || strings.HasSuffix(e.comparison, "/"+targetWithoutMd) {
				matches = append(matches, e)
			}
		}
		if r, ok := choose(matches, subpath); ok {
			return r
		}
	}

	// Obsidian's shortest-link behavior: a basename is safe only if unique.
	basename := jstext.Lower(lastSegment(targetWithoutMd))
	matches = nil
	for i := range entries {
		e := &entries[i]
		if jstext.Lower(lastSegment(e.comparison)) == basename {
			matches = append(matches, e)
		}
	}
	if len(matches) == 1 {
		return result(StatusResolved, &matches[0].entry, subpath, nil)
	}
	if len(matches) > 1 {
		var sourceFolders []string
		for _, f := range strings.Split(sourceFolder, "/") {
			if f != "" {
				sourceFolders = append(sourceFolders, f)
			}
		}
		type rankedEntry struct {
			e        *indexedEntry
			common   int
			distance int
		}
		ranked := make([]rankedEntry, len(matches))
		for i, m := range matches {
			base := m.entry.Path
			if m.normOK {
				base = m.norm
			}
			var folders []string
			parts := strings.Split(base, "/")
			folders = parts[:len(parts)-1]
			common := 0
			for common < len(sourceFolders) && common < len(folders) && sourceFolders[common] == folders[common] {
				common++
			}
			ranked[i] = rankedEntry{m, common, len(sourceFolders) + len(folders) - 2*common}
		}
		sort.SliceStable(ranked, func(i, j int) bool {
			l, r := ranked[i], ranked[j]
			if l.common != r.common {
				return r.common < l.common
			}
			if l.distance != r.distance {
				return l.distance < r.distance
			}
			return jstext.LocaleCompare(l.e.entry.Path, r.e.entry.Path) < 0
		})
		if len(ranked) >= 2 && (ranked[0].common != ranked[1].common || ranked[0].distance != ranked[1].distance) {
			return result(StatusResolved, &ranked[0].e.entry, subpath, nil)
		}
		cands := make([]string, len(ranked))
		for i, r := range ranked {
			cands[i] = r.e.entry.Path
		}
		return result(StatusAmbiguous, nil, subpath, cands)
	}
	return result(StatusUnresolved, nil, subpath, nil)
}
