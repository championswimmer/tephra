package api_test

import (
	"strings"

	"context"
	"github.com/championswimmer/tephra/tephra-server/go/internal/blobstore"

	"github.com/championswimmer/tephra/tephra-server/go/internal/auth"
	"github.com/championswimmer/tephra/tephra-server/go/internal/db"
	"github.com/championswimmer/tephra/tephra-server/go/internal/protocol"
	"github.com/championswimmer/tephra/tephra-server/go/internal/testutil"
	vm "github.com/championswimmer/tephra/tephra-server/go/internal/vaultmodel"
)

func userRow(id string) vm.User {
	return vm.User{ID: id, Email: "owner@example.com", CreatedAt: 1, UpdatedAt: 1}
}

func vaultRow(id, owner string) vm.Vault {
	return vm.Vault{ID: id, OwnerUserID: owner, Name: "Test Vault", SyncMode: vm.SyncModeTephra, CreatedAt: 1, UpdatedAt: 1}
}

func tokenRow(raw, vaultID, userID string) vm.ApiToken {
	return vm.ApiToken{ID: "token-1", UserID: userID, VaultID: &vaultID, TokenHash: auth.HashOpaqueToken(raw), Name: "test",
		Scopes: []vm.ApiTokenScope{vm.ScopeVaultReadMetadata, vm.ScopeVaultUpload}, CreatedAt: 1}
}

// brokenDB fails Users().Count to exercise readiness and the 500 path.
type brokenDB struct{ db.Database }

func (b brokenDB) Users() db.UserRepository { return brokenUsers{b.Database.Users()} }

type brokenUsers struct{ db.UserRepository }

func (brokenUsers) Count(context.Context) (int64, error) { return 0, errBoom }

// emptyPlanBody is a valid sync plan/commit body with no files.
func emptyPlanBody() []byte {
	h, err := protocol.HashManifest(nil)
	if err != nil {
		panic(err)
	}
	return []byte(`{"deviceId":"device-1","manifestHash":"` + h + `","files":[]}`)
}

// withJSON adds a JSON content type to a header set.
func withJSON(h testutil.Headers) testutil.Headers {
	out := testutil.Headers{"content-type": "application/json"}
	for k, v := range h {
		out[k] = v
	}
	return out
}

func putInput(hash, content string) blobstore.PutInput {
	return blobstore.PutInput{Hash: hash, Body: strings.NewReader(content), Size: int64(len(content))}
}
