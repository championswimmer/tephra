package httpx

import (
	"bytes"
	"encoding"
	"encoding/json"
	"net/http"
	"reflect"
	"sort"
	"strings"
)

// MarshalJSON encodes v like JSON.stringify would for the TS shapes: no HTML
// escaping, no trailing newline, and nil slices encoded as [] (never null).
// Pointer fields and nil maps/interfaces still encode as null.
func MarshalJSON(v any) ([]byte, error) {
	var buf bytes.Buffer
	if err := encodeValue(&buf, reflect.ValueOf(v)); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// WriteJSON writes v with the given status as application/json (Hono c.json).
func WriteJSON(w http.ResponseWriter, status int, v any) {
	b, err := MarshalJSON(v)
	if err != nil {
		b = []byte(`{"error":{"code":"INTERNAL_ERROR","message":"An internal error occurred."}}`)
		status = http.StatusInternalServerError
	}
	h := w.Header()
	h.Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(b)
}

// WriteNoContent writes an empty response (Hono c.body(null, 204)).
func WriteNoContent(w http.ResponseWriter) { w.WriteHeader(http.StatusNoContent) }

func leaf(buf *bytes.Buffer, v any) error {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return err
	}
	buf.Write(bytes.TrimSuffix(b.Bytes(), []byte("\n")))
	return nil
}

var (
	marshalerType     = reflect.TypeOf((*json.Marshaler)(nil)).Elem()
	textMarshalerType = reflect.TypeOf((*encoding.TextMarshaler)(nil)).Elem()
)

func encodeValue(buf *bytes.Buffer, v reflect.Value) error {
	if !v.IsValid() {
		buf.WriteString("null")
		return nil
	}
	t := v.Type()
	if t.Implements(marshalerType) || t.Implements(textMarshalerType) ||
		(v.CanAddr() && reflect.PointerTo(t).Implements(marshalerType)) {
		if (v.Kind() == reflect.Pointer || v.Kind() == reflect.Interface) && v.IsNil() {
			buf.WriteString("null")
			return nil
		}
		return leaf(buf, v.Interface())
	}
	switch v.Kind() {
	case reflect.Pointer, reflect.Interface:
		if v.IsNil() {
			buf.WriteString("null")
			return nil
		}
		return encodeValue(buf, v.Elem())
	case reflect.Slice:
		if t.Elem().Kind() == reflect.Uint8 {
			if v.IsNil() {
				buf.WriteString("[]")
				return nil
			}
			return leaf(buf, v.Interface())
		}
		fallthrough
	case reflect.Array:
		buf.WriteByte('[')
		for i := 0; i < v.Len(); i++ {
			if i > 0 {
				buf.WriteByte(',')
			}
			if err := encodeValue(buf, v.Index(i)); err != nil {
				return err
			}
		}
		buf.WriteByte(']')
		return nil
	case reflect.Map:
		if v.IsNil() {
			buf.WriteString("null")
			return nil
		}
		keys := v.MapKeys()
		sort.Slice(keys, func(i, j int) bool { return keys[i].String() < keys[j].String() })
		buf.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				buf.WriteByte(',')
			}
			if err := leaf(buf, k.String()); err != nil {
				return err
			}
			buf.WriteByte(':')
			if err := encodeValue(buf, v.MapIndex(k)); err != nil {
				return err
			}
		}
		buf.WriteByte('}')
		return nil
	case reflect.Struct:
		buf.WriteByte('{')
		first := true
		if err := encodeFields(buf, v, &first); err != nil {
			return err
		}
		buf.WriteByte('}')
		return nil
	}
	return leaf(buf, v.Interface())
}

func isEmpty(v reflect.Value) bool {
	switch v.Kind() {
	case reflect.Array, reflect.Map, reflect.Slice, reflect.String:
		return v.Len() == 0
	case reflect.Bool:
		return !v.Bool()
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return v.Int() == 0
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uintptr:
		return v.Uint() == 0
	case reflect.Float32, reflect.Float64:
		return v.Float() == 0
	case reflect.Interface, reflect.Pointer:
		return v.IsNil()
	}
	return false
}

func encodeFields(buf *bytes.Buffer, v reflect.Value, first *bool) error {
	t := v.Type()
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		tag, hasTag := f.Tag.Lookup("json")
		if tag == "-" {
			continue
		}
		name, opts, _ := strings.Cut(tag, ",")
		fv := v.Field(i)
		if f.Anonymous && name == "" {
			ft := f.Type
			if ft.Kind() == reflect.Pointer {
				if fv.IsNil() {
					continue
				}
				fv = fv.Elem()
				ft = ft.Elem()
			}
			if ft.Kind() == reflect.Struct {
				if err := encodeFields(buf, fv, first); err != nil {
					return err
				}
				continue
			}
		}
		if !f.IsExported() {
			continue
		}
		if !hasTag || name == "" {
			name = f.Name
		}
		if strings.Contains(opts, "omitempty") && isEmpty(fv) {
			continue
		}
		if !*first {
			buf.WriteByte(',')
		}
		*first = false
		if err := leaf(buf, name); err != nil {
			return err
		}
		buf.WriteByte(':')
		if err := encodeValue(buf, fv); err != nil {
			return err
		}
	}
	return nil
}
