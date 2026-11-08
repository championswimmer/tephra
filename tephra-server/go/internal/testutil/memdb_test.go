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

func TestObsidianSyncFrequencyNormalisation(t *testing.T) {
	m := testutil.NewMemoryDatabase()
	ctx := context.Background()
	settings := vm.ObsidianSyncSettings{VaultID: "v1", Mode: vm.ObsidianModeBidirectional, Phase: vm.PhasePendingLogin}
	if err := m.ObsidianSync().Upsert(ctx, settings); err != nil {
		t.Fatal(err)
	}
	got, err := m.ObsidianSync().Find(ctx, "v1")
	if err != nil || got.Frequency != vm.FrequencyContinuous {
		t.Fatalf("zero value = %q, %v", got.Frequency, err)
	}
	settings.Frequency = vm.Frequency30Minutes
	if err := m.ObsidianSync().Upsert(ctx, settings); err != nil {
		t.Fatal(err)
	}
	got, _ = m.ObsidianSync().Find(ctx, "v1")
	if got.Frequency != vm.Frequency30Minutes {
		t.Fatalf("frequency = %q", got.Frequency)
	}
}

func TestObsidianSyncRejectsInvalidFrequency(t *testing.T) {
	m := testutil.NewMemoryDatabase()
	ctx := context.Background()
	settings := vm.ObsidianSyncSettings{VaultID: "v1", Mode: vm.ObsidianModeBidirectional,
		Phase: vm.PhasePendingLogin, Frequency: vm.Frequency10Minutes}
	if err := m.ObsidianSync().Upsert(ctx, settings); err != nil {
		t.Fatal(err)
	}
	// A non-empty unsupported value is rejected like the SQLite CHECK constraint.
	invalid := settings
	invalid.Frequency = "15m"
	if err := m.ObsidianSync().Upsert(ctx, invalid); err == nil {
		t.Fatal("invalid frequency must be rejected")
	}
	got, err := m.ObsidianSync().Find(ctx, "v1")
	if err != nil {
		t.Fatal(err)
	}
	if got.Frequency != vm.Frequency10Minutes {
		t.Fatalf("frequency = %q", got.Frequency)
	}
}
