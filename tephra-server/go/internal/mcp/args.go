package mcp

import (
	"encoding/json"
	"math"
	"strings"
	"unicode/utf16"

	"github.com/championswimmer/tephra/tephra-server/go/internal/jstext"
)

// This file reproduces the zod 4 parsing (and its issue messages) of the TS
// tool input schemas.

type issue struct{ path, message string }

type fieldKind int

const (
	kindString fieldKind = iota
	kindInt
)

type field struct {
	name     string
	kind     fieldKind
	required bool
	trim     bool
	min, max int // max < 0: unbounded
}

// toolFields mirrors the z.object shapes (key order matters for issue order).
var toolFields = map[string][]field{
	"list_vaults": {},
	"search_notes": {
		{name: "vault", kind: kindString},
		{name: "query", kind: kindString, required: true, trim: true, min: 1, max: 200},
		{name: "limit", kind: kindInt, min: 1, max: 100},
	},
	"read_note": {
		{name: "vault", kind: kindString},
		{name: "path", kind: kindString, required: true, min: 1, max: -1},
	},
	"create_note": {
		{name: "vault", kind: kindString},
		{name: "path", kind: kindString, required: true, min: 1, max: -1},
		{name: "content", kind: kindString, required: true, max: -1},
	},
	"update_note": {
		{name: "vault", kind: kindString},
		{name: "path", kind: kindString, required: true, min: 1, max: -1},
		{name: "patch", kind: kindString, min: 1, max: -1},
		{name: "content", kind: kindString, max: -1},
		{name: "baseHash", kind: kindString, max: -1},
	},
}

// toolArgs holds the parsed arguments; nil pointers are absent keys.
type toolArgs struct {
	vault, path, query, patch, content, baseHash *string
	limit                                        *int
}

// jsType is the zod "received" label.
func jsType(v any) string {
	switch t := v.(type) {
	case nil:
		return "null"
	case string:
		return "string"
	case bool:
		return "boolean"
	case json.Number:
		if f, err := t.Float64(); err == nil && math.IsInf(f, 0) {
			return "Infinity"
		}
		return "number"
	case []any:
		return "array"
	}
	return "object"
}

func utf16Len(s string) int { return len(utf16.Encode([]rune(s))) }

func parseToolArgs(name string, raw any) (toolArgs, []issue) {
	var out toolArgs
	if raw == nil {
		raw = map[string]any{}
	}
	obj, ok := raw.(map[string]any)
	if !ok {
		return out, []issue{{"", "Invalid input: expected object, received " + jsType(raw)}}
	}
	var issues []issue
	for _, f := range toolFields[name] {
		v, present := obj[f.name]
		if !present {
			if f.required {
				issues = append(issues, issue{f.name, "Invalid input: expected " + kindName(f.kind) + ", received undefined"})
			}
			continue
		}
		switch f.kind {
		case kindString:
			s, isStr := v.(string)
			if !isStr {
				issues = append(issues, issue{f.name, "Invalid input: expected string, received " + jsType(v)})
				continue
			}
			if f.trim {
				s = jstext.Trim(s)
			}
			n := utf16Len(s)
			bad := false
			if n < f.min {
				issues = append(issues, issue{f.name, "Too small: expected string to have >=" + itoa(f.min) + " characters"})
				bad = true
			}
			if f.max > 0 && n > f.max {
				issues = append(issues, issue{f.name, "Too big: expected string to have <=" + itoa(f.max) + " characters"})
				bad = true
			}
			if bad {
				continue
			}
			switch f.name {
			case "vault":
				out.vault = &s
			case "path":
				out.path = &s
			case "query":
				out.query = &s
			case "patch":
				out.patch = &s
			case "content":
				out.content = &s
			case "baseHash":
				out.baseHash = &s
			}
		case kindInt:
			num, isNum := v.(json.Number)
			var fl float64
			if isNum {
				var err error
				fl, err = num.Float64()
				if err != nil || math.IsInf(fl, 0) {
					isNum = false
				}
			}
			if !isNum {
				issues = append(issues, issue{f.name, "Invalid input: expected number, received " + jsType(v)})
				continue
			}
			if fl != math.Trunc(fl) {
				issues = append(issues, issue{f.name, "Invalid input: expected int, received number"})
				continue
			}
			bad := false
			if fl > 9007199254740991 {
				issues = append(issues, issue{f.name, "Too big: expected int to be <=9007199254740991"})
				bad = true
			}
			if fl < -9007199254740991 {
				issues = append(issues, issue{f.name, "Too small: expected int to be >=-9007199254740991"})
				bad = true
			}
			if fl < float64(f.min) {
				issues = append(issues, issue{f.name, "Too small: expected number to be >=" + itoa(f.min)})
				bad = true
			}
			if fl > float64(f.max) {
				issues = append(issues, issue{f.name, "Too big: expected number to be <=" + itoa(f.max)})
				bad = true
			}
			if !bad {
				n := int(fl)
				out.limit = &n
			}
		}
	}
	return out, issues
}

func kindName(k fieldKind) string {
	if k == kindInt {
		return "number"
	}
	return "string"
}

func itoa(n int) string { return json.Number(jsonInt(n)).String() }

func jsonInt(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}

func invalidArgumentsMessage(issues []issue) string {
	parts := make([]string, len(issues))
	for i, is := range issues {
		p := is.path
		if p == "" {
			p = "arguments"
		}
		parts[i] = p + ": " + is.message
	}
	return "Invalid arguments: " + strings.Join(parts, "; ")
}
