package protocol

import "encoding/json"

// GraphNodeKind: "note" | "attachment" | "tag" | "unresolved".
type GraphNodeKind = string

// GraphNodeDto is a graph node. Title nil marshals as null.
type GraphNodeDto struct {
	ID        string   `json:"id"`
	Path      string   `json:"path"`
	Title     *string  `json:"title"`
	Kind      string   `json:"kind"`
	Tags      []string `json:"tags"`
	CreatedAt int64    `json:"createdAt"`
}

// MarshalJSON renders nil Tags as [].
func (n GraphNodeDto) MarshalJSON() ([]byte, error) {
	type alias GraphNodeDto
	if n.Tags == nil {
		n.Tags = []string{}
	}
	return json.Marshal(alias(n))
}

// GraphEdgeDto: S and T are indices into the nodes array.
type GraphEdgeDto struct {
	S      int64 `json:"s"`
	T      int64 `json:"t"`
	Count  int64 `json:"count"`
	Embeds int64 `json:"embeds"`
}

// GraphResponse is the graph payload. IndexPending nil = omitted.
type GraphResponse struct {
	Revision     int64          `json:"revision"`
	Truncated    bool           `json:"truncated"`
	IndexPending *bool          `json:"indexPending,omitempty"`
	Nodes        []GraphNodeDto `json:"nodes"`
	Edges        []GraphEdgeDto `json:"edges"`
}

// MarshalJSON renders nil Nodes/Edges as [].
func (g GraphResponse) MarshalJSON() ([]byte, error) {
	type alias GraphResponse
	if g.Nodes == nil {
		g.Nodes = []GraphNodeDto{}
	}
	if g.Edges == nil {
		g.Edges = []GraphEdgeDto{}
	}
	return json.Marshal(alias(g))
}

// ParseGraphResponse validates a graph response, including that every edge
// endpoint index is within the nodes array.
func ParseGraphResponse(data []byte) (GraphResponse, error) {
	var out GraphResponse
	v, err := decodeJSON(data)
	if err != nil {
		return out, err
	}
	var c checker
	m := c.obj(v, "", "revision", "truncated", "indexPending", "nodes", "edges")
	out.Revision, _ = c.safeInt(m, "revision", "", true, false)
	out.Truncated, _ = c.boolean(m, "truncated", "", true)
	if b, ok := c.boolean(m, "indexPending", "", false); ok {
		out.IndexPending = &b
	}
	out.Nodes = []GraphNodeDto{}
	if a, ok := c.arr(m, "nodes", "", true); ok {
		for i, item := range a {
			p := idx("nodes", i)
			nm := c.obj(item, p, "id", "path", "title", "kind", "tags", "createdAt")
			var n GraphNodeDto
			n.ID, _ = c.str(nm, "id", p, true, 1, 1024)
			n.Path, _ = c.str(nm, "path", p, true, 1, 1024)
			if tv, ok := c.get(nm, "title", p, true); ok {
				switch t := tv.(type) {
				case nil:
				case string:
					n.Title = &t
				default:
					c.add(join(p, "title"), "Expected string or null.")
				}
			}
			n.Kind, _ = c.enum(nm, "kind", p, true, "note", "attachment", "tag", "unresolved")
			n.Tags = []string{}
			if tags, ok := c.arr(nm, "tags", p, true); ok {
				if len(tags) > 100 {
					c.add(join(p, "tags"), "Array must contain at most 100 elements.")
				}
				for j, tv := range tags {
					s, isStr := tv.(string)
					if !isStr {
						c.add(idx(join(p, "tags"), j), "Expected string.")
						continue
					}
					if l := utf16Len(s); l < 1 || l > 200 {
						c.add(idx(join(p, "tags"), j), "String length out of range.")
					}
					n.Tags = append(n.Tags, s)
				}
			}
			n.CreatedAt, _ = c.safeInt(nm, "createdAt", p, true, false)
			out.Nodes = append(out.Nodes, n)
		}
	}
	out.Edges = []GraphEdgeDto{}
	if a, ok := c.arr(m, "edges", "", true); ok {
		for i, item := range a {
			p := idx("edges", i)
			em := c.obj(item, p, "s", "t", "count", "embeds")
			var e GraphEdgeDto
			e.S, _ = c.safeInt(em, "s", p, true, false)
			e.T, _ = c.safeInt(em, "t", p, true, false)
			e.Count, _ = c.safeInt(em, "count", p, true, true)
			e.Embeds, _ = c.safeInt(em, "embeds", p, true, false)
			out.Edges = append(out.Edges, e)
		}
	}
	if len(c.issues) == 0 {
		for i, e := range out.Edges {
			if e.S >= int64(len(out.Nodes)) || e.T >= int64(len(out.Nodes)) {
				c.add(idx("edges", i), "Graph edge endpoint index is out of range.")
			}
		}
	}
	if err := c.err(); err != nil {
		return GraphResponse{}, err
	}
	return out, nil
}
