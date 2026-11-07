package indexer

// DecodeUTF8 is Response.text()/TextDecoder semantics (BOM stripped, maximal
// invalid subparts replaced by U+FFFD), shared with the HTTP layer.
func DecodeUTF8(b []byte) string { return decodeUTF8(b) }

// EncodeURIComponent is the JS function of the same name.
func EncodeURIComponent(s string) string { return encodeURIComponent(s) }
