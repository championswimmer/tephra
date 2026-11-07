package testutil

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/championswimmer/tephra/tephra-server/go/internal/db"
	"github.com/championswimmer/tephra/tephra-server/go/internal/db/sqlite"
)

// UseSQLite reports whether tests should run against SQLite instead of the
// in-memory database: set TEPHRA_TEST_DB=sqlite.
func UseSQLite() bool { return os.Getenv("TEPHRA_TEST_DB") == "sqlite" }

// OpenSQLite opens a fresh SQLite database in a per-test temp dir.
func OpenSQLite(t testing.TB) db.Database { return openSQLite(t) }

func openSQLite(t testing.TB) db.Database {
	t.Helper()
	d, err := sqlite.Open(filepath.Join(t.TempDir(), "tephra.db"))
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() { _ = d.Close() })
	return d
}
