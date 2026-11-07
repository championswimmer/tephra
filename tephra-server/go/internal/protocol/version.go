package protocol

import (
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

const (
	ProtocolVersion       = "2"
	MinimumPluginVersion  = "0.2.0"
	ProtocolVersionHeader = "X-Tephra-Protocol-Version"
	PluginVersionHeader   = "X-Tephra-Plugin-Version"
)

// JS `.` excludes \n \r U+2028 U+2029; `\d` is ASCII only.
var versionPattern = regexp.MustCompile(`^(\d+)\.(\d+)\.(\d+)(?:[-+][^\n\r\x{2028}\x{2029}]*)?$`)

// jsTrim emulates String.prototype.trim (whitespace + line terminators + BOM).
func jsTrim(s string) string {
	return strings.TrimFunc(s, func(r rune) bool {
		if r == 0x85 {
			return false // NEL is not JS whitespace
		}
		return unicode.IsSpace(r) || r == 0xfeff || unicode.Is(unicode.Zs, r) || r == 0x2028 || r == 0x2029
	})
}

func parseVersionTuple(version string) ([3]float64, bool) {
	m := versionPattern.FindStringSubmatch(jsTrim(version))
	if m == nil {
		return [3]float64{}, false
	}
	var out [3]float64
	for i := 0; i < 3; i++ {
		f, _ := strconv.ParseFloat(m[i+1], 64) // like JS Number(); huge values become +Inf
		out[i] = f
	}
	return out, true
}

// IsSupportedPluginVersion reports whether a plugin version header value
// satisfies MinimumPluginVersion. Absent (callers pass "") or blank versions
// are supported, malformed ones are not.
func IsSupportedPluginVersion(version string) bool {
	if jsTrim(version) == "" {
		return true
	}
	actual, ok := parseVersionTuple(version)
	minimum, ok2 := parseVersionTuple(MinimumPluginVersion)
	if !ok || !ok2 {
		return false
	}
	for i := 0; i < 3; i++ {
		if actual[i] != minimum[i] {
			return actual[i] > minimum[i]
		}
	}
	return true
}
