package api

import (
	"github.com/championswimmer/tephra/tephra-server/go/internal/mcp"
	"github.com/championswimmer/tephra/tephra-server/go/internal/oauth"
)

// The OAuth/discovery routes and the MCP endpoint live in their own packages
// (which depend on httpx only, never on api) and are hooked in here. OAuth is
// registered before MCP, as in app.ts.
func init() {
	Register(oauth.Register)
	Register(mcp.Register)
}
