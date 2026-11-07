package oauth

import (
	"net/netip"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"
)

// parsedURL is the subset of a WHATWG URL object that the redirect checks
// need (protocol, hostname, host, pathname, search, hash, credentials).
type parsedURL struct {
	scheme       string // lowercase, no colon
	hostname     string // normalised; IPv6 keeps its brackets (like URL.hostname)
	host         string // hostname[:port], default port dropped (like URL.host)
	hasAuthority bool
	opaque       string
	path         string // http: never empty, dot segments resolved
	rawQuery     string
}

func (u *parsedURL) protocol() string { return u.scheme + ":" }

// search is URL.search: "" or "?"+query.
func (u *parsedURL) search() string {
	if u.rawQuery == "" {
		return ""
	}
	return "?" + u.rawQuery
}

func defaultPort(scheme string) string {
	switch scheme {
	case "http":
		return "80"
	case "https":
		return "443"
	}
	return ""
}

var numericLabel = regexp.MustCompile(`^(0[xX][0-9a-fA-F]*|[0-9]+)$`)

func parseIPv4Number(s string) (uint64, bool) {
	if s == "" {
		return 0, false
	}
	base := 10
	switch {
	case len(s) >= 2 && (s[:2] == "0x" || s[:2] == "0X"):
		s, base = s[2:], 16
	case len(s) >= 2 && s[0] == '0':
		s, base = s[1:], 8
	}
	if s == "" {
		return 0, true
	}
	n, err := strconv.ParseUint(s, base, 64)
	return n, err == nil
}

// normaliseHost applies the WHATWG host parsing that matters for loopback
// detection (lowercasing, IPv4 number forms, IPv6 compression). ok is false
// when the URL would be invalid.
func normaliseHost(scheme, host string) (string, bool) {
	if strings.HasPrefix(host, "[") {
		if !strings.HasSuffix(host, "]") {
			return "", false
		}
		addr, err := netip.ParseAddr(host[1 : len(host)-1])
		if err != nil || !addr.Is6() || addr.Zone() != "" {
			return "", false
		}
		return "[" + addr.String() + "]", true
	}
	if scheme != "http" && scheme != "https" {
		return host, true
	}
	host = strings.ToLower(host)
	if host == "" {
		return "", false
	}
	parts := strings.Split(host, ".")
	if len(parts) > 1 && parts[len(parts)-1] == "" {
		parts = parts[:len(parts)-1]
	}
	if !numericLabel.MatchString(parts[len(parts)-1]) {
		return host, true
	}
	if len(parts) > 4 {
		return "", false
	}
	nums := make([]uint64, len(parts))
	for i, p := range parts {
		n, ok := parseIPv4Number(p)
		if !ok {
			return "", false
		}
		nums[i] = n
	}
	for _, n := range nums[:len(nums)-1] {
		if n > 255 {
			return "", false
		}
	}
	last := nums[len(nums)-1]
	limit := uint64(1) << (8 * uint(5-len(nums)))
	if last >= limit {
		return "", false
	}
	ip := last
	for i, n := range nums[:len(nums)-1] {
		ip += n << (8 * uint(3-i))
	}
	return strconv.Itoa(int(ip>>24&255)) + "." + strconv.Itoa(int(ip>>16&255)) + "." +
		strconv.Itoa(int(ip>>8&255)) + "." + strconv.Itoa(int(ip&255)), true
}

func resolveDots(p string) string {
	out := []string{}
	segs := strings.Split(p, "/")
	for i, s := range segs {
		last := i == len(segs)-1
		switch strings.ToLower(s) {
		case ".", "%2e":
			if last {
				out = append(out, "")
			}
		case "..", ".%2e", "%2e.", "%2e%2e":
			if len(out) > 1 {
				out = out[:len(out)-1]
			}
			if last {
				out = append(out, "")
			}
		default:
			out = append(out, s)
		}
	}
	return strings.Join(out, "/")
}

// parseURL is a deliberately strict stand-in for `new URL(raw)`: inputs that
// contain control characters, spaces or backslashes (which WHATWG would
// silently repair) are rejected rather than reinterpreted.
func parseURL(raw string) *parsedURL {
	for _, r := range raw {
		if r <= 0x20 || r == 0x7f || r == '\\' {
			return nil
		}
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" {
		return nil
	}
	if hasFragment(raw) {
		return nil
	}
	if u.User != nil {
		pw, _ := u.User.Password()
		if u.User.Username() != "" || pw != "" {
			return nil
		}
	}
	p := &parsedURL{scheme: strings.ToLower(u.Scheme), opaque: u.Opaque, rawQuery: u.RawQuery}
	rest := raw[len(u.Scheme)+1:]
	p.hasAuthority = strings.HasPrefix(rest, "//")
	if p.hasAuthority {
		h := u.Hostname()
		if strings.Contains(h, ":") {
			// url.Hostname strips the brackets of IPv6 literals.
			h = "[" + h + "]"
		}
		hostname, ok := normaliseHost(p.scheme, h)
		if !ok {
			return nil
		}
		port := u.Port()
		if port != "" {
			n, err := strconv.Atoi(port)
			if err != nil || n > 65535 {
				return nil
			}
			port = strconv.Itoa(n)
			if port == defaultPort(p.scheme) {
				port = ""
			}
		}
		p.hostname = hostname
		p.host = hostname
		if port != "" {
			p.host += ":" + port
		}
	}
	p.path = u.EscapedPath()
	if p.scheme == "http" || p.scheme == "https" {
		if p.path == "" {
			p.path = "/"
		}
		p.path = resolveDots(p.path)
	}
	return p
}

func hasFragment(raw string) bool {
	i := strings.IndexByte(raw, '#')
	return i >= 0 && i+1 < len(raw)
}

// --- application/x-www-form-urlencoded -------------------------------------

func unhex(c byte) int {
	switch {
	case c >= '0' && c <= '9':
		return int(c - '0')
	case c >= 'a' && c <= 'f':
		return int(c-'a') + 10
	case c >= 'A' && c <= 'F':
		return int(c-'A') + 10
	}
	return -1
}

func formDecode(s string) string {
	b := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		switch c := s[i]; {
		case c == '+':
			b = append(b, ' ')
		case c == '%' && i+2 < len(s) && unhex(s[i+1]) >= 0 && unhex(s[i+2]) >= 0:
			b = append(b, byte(unhex(s[i+1])<<4|unhex(s[i+2])))
			i += 2
		default:
			b = append(b, c)
		}
	}
	return strings.ToValidUTF8(string(b), "�")
}

type pair struct{ k, v string }

// parseForm is the lenient WHATWG urlencoded parser (never fails).
func parseForm(s string) []pair {
	var out []pair
	for _, seg := range strings.Split(s, "&") {
		if seg == "" {
			continue
		}
		k, v, _ := strings.Cut(seg, "=")
		out = append(out, pair{formDecode(k), formDecode(v)})
	}
	return out
}

const hexUpper = "0123456789ABCDEF"

func formEncode(s string) string {
	var sb strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '*', c == '-', c == '.', c == '_':
			sb.WriteByte(c)
		case c == ' ':
			sb.WriteByte('+')
		default:
			sb.WriteByte('%')
			sb.WriteByte(hexUpper[c>>4])
			sb.WriteByte(hexUpper[c&15])
		}
	}
	return sb.String()
}

func serializeForm(pairs []pair) string {
	parts := make([]string, len(pairs))
	for i, p := range pairs {
		parts[i] = formEncode(p.k) + "=" + formEncode(p.v)
	}
	return strings.Join(parts, "&")
}

// setParam is URLSearchParams.set: replace the first pair, drop the others,
// or append.
func setParam(pairs []pair, key, value string) []pair {
	out := make([]pair, 0, len(pairs)+1)
	done := false
	for _, p := range pairs {
		if p.k == key {
			if !done {
				out = append(out, pair{key, value})
				done = true
			}
			continue
		}
		out = append(out, p)
	}
	if !done {
		out = append(out, pair{key, value})
	}
	return out
}

// withParams is withParams() from the TS: sets each defined param on the
// redirect URI's query and returns the URL's href. ok is false when the URI
// does not parse (callers have validated it already).
func withParams(redirectURI string, params []pair) (string, bool) {
	u := parseURL(redirectURI)
	if u == nil {
		return "", false
	}
	query := parseForm(u.rawQuery)
	for _, p := range params {
		query = setParam(query, p.k, p.v)
	}
	var sb strings.Builder
	sb.WriteString(u.scheme + ":")
	if u.hasAuthority {
		sb.WriteString("//" + u.host)
	}
	if u.opaque != "" {
		sb.WriteString(u.opaque)
	} else {
		sb.WriteString(u.path)
	}
	if len(query) > 0 {
		sb.WriteString("?" + serializeForm(query))
	}
	return sb.String(), true
}

// utf16Len is JavaScript string .length.
func utf16Len(s string) int { return len(utf16.Encode([]rune(s))) }

// sliceUTF16 is s.slice(0, n) for JavaScript strings.
func sliceUTF16(s string, n int) string {
	u := utf16.Encode([]rune(s))
	if len(u) <= n {
		return s
	}
	return string(utf16.Decode(u[:n]))
}
