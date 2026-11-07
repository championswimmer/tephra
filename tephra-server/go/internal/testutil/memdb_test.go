package testutil_test

import (
	"context"
	"errors"
	"testing"

	"github.com/championswimmer/tephra/tephra-server/go/internal/db"
	"github.com/championswimmer/tephra/tephra-server/go/internal/testutil"
	vm "github.com/championswimmer/tephra/tephra-server/go/internal/vaultmodel"
)

func TestTransactionRollsBackOnError(t *testing.T) {
	m := testutil.NewMemoryDatabase()
	ctx := context.Background()
	boom := errors.New("boom")
	err := m.Transaction(ctx, func(r db.TransactionRepositories) error {
		_ = r.Users().Insert(ctx, vm.User{ID: "u1", Email: "a@b.co"})
		return boom
	})
	if !errors.Is(err, boom) {
		t.Fatal(err)
	}
	if n, _ := m.Users().Count(ctx); n != 0 {
		t.Fatal("rollback expected")
	}
	if err := m.Transaction(ctx, func(r db.TransactionRepositories) error {
		return r.Users().Insert(ctx, vm.User{ID: "u1", Email: "a@b.co"})
	}); err != nil {
		t.Fatal(err)
	}
	if n, _ := m.Users().Count(ctx); n != 1 {
		t.Fatal("commit expected")
	}
}

func TestVaultNameUniqueAndCascade(t *testing.T) {
	m := testutil.NewMemoryDatabase()
	ctx := context.Background()
	_ = m.Vaults().Insert(ctx, vm.Vault{ID: "v1", Name: "N"})
	if err := m.Vaults().Insert(ctx, vm.Vault{ID: "v2", Name: "N"}); err == nil {
		t.Fatal("unique name expected")
	}
	vid := "v1"
	_ = m.ApiTokens().Insert(ctx, vm.ApiToken{ID: "t", VaultID: &vid})
	_ = m.VaultFiles().Upsert(ctx, vm.CurrentVaultFile{FileID: "f", VaultID: "v1"})
	_ = m.Vaults().Delete(ctx, "v1")
	if ts, _ := m.ApiTokens().ListByVault(ctx, "v1"); len(ts) != 0 {
		t.Fatal("tokens cascade")
	}
	if fs, _ := m.VaultFiles().ListByVault(ctx, "v1"); len(fs) != 0 {
		t.Fatal("files cascade")
	}
}
