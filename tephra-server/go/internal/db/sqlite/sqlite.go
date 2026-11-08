// Package sqlite is the pure-Go (modernc.org/sqlite, no CGO) implementation of
// the db interfaces. It is a port of tephra-server/packages/database/sqlite and
// reads/writes the very same database file format (PRAGMA user_version 8).
//
// Concurrency model: one write connection (so writers are serialised, like the
// TS SerialExecutor) opened with BEGIN IMMEDIATE transactions, plus a small
// read-only connection pool. WAL journalling lets readers proceed while the
// writer is busy. Repositories obtained from DB directly are auto-commit;
// Transaction hands out repositories bound to one BEGIN IMMEDIATE transaction.
package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/championswimmer/tephra/tephra-server/go/internal/db"
	_ "modernc.org/sqlite" // registers the "sqlite" database/sql driver
)

const (
	memoryPath = ":memory:"
	// Small caches keep resident memory low: negative cache_size is KiB.
	writeCacheKiB = 4096
	readCacheKiB  = 1024
	readPoolSize  = 4
	// Memory mapping is capped; pages are only resident once touched.
	mmapBytes = 16 << 20
)

// DB is the SQLite-backed db.Database.
type DB struct {
	*repos
	read, write *sql.DB
	closeOnce   sync.Once
	closeErr    error
}

var _ db.Database = (*DB)(nil)

// Open opens (creating if needed) the database file at path, migrates it to
// the latest schema, and returns a ready DB. ":memory:" opens a private
// single-connection in-memory database (for tests); there reads and writes
// share the one connection, so repositories of the DB itself must not be used
// from inside a Transaction callback.
func Open(path string) (*DB, error) {
	if path == "" {
		return nil, errors.New("sqlite: empty database path")
	}
	if path == memoryPath {
		return openMemory()
	}
	if err := migrateFile(path); err != nil {
		return nil, err
	}
	write, err := sql.Open("sqlite", dsn(path, writePragmas(), "immediate"))
	if err != nil {
		return nil, err
	}
	write.SetMaxOpenConns(1)
	write.SetMaxIdleConns(1)
	read, err := sql.Open("sqlite", dsn(path, readPragmas(), ""))
	if err != nil {
		_ = write.Close()
		return nil, err
	}
	read.SetMaxOpenConns(readPoolSize)
	read.SetMaxIdleConns(2)
	read.SetConnMaxIdleTime(time.Minute)
	d := &DB{read: read, write: write}
	d.repos = newRepos(read, write)
	// Fail fast on an unusable file.
	if err := d.ReadyCheck(context.Background()); err != nil {
		_ = d.Close()
		return nil, err
	}
	return d, nil
}

func openMemory() (*DB, error) {
	conn, err := sql.Open("sqlite", dsn(memoryPath, writePragmas(), "immediate"))
	if err != nil {
		return nil, err
	}
	conn.SetMaxOpenConns(1)
	conn.SetMaxIdleConns(1)
	conn.SetConnMaxLifetime(0)
	conn.SetConnMaxIdleTime(0)
	if err := migrate(context.Background(), conn); err != nil {
		_ = conn.Close()
		return nil, err
	}
	d := &DB{read: conn, write: conn}
	d.repos = newRepos(conn, conn)
	return d, nil
}

func writePragmas() []string {
	return []string{
		"foreign_keys(1)", "busy_timeout(5000)", "journal_mode(WAL)",
		fmt.Sprintf("cache_size(-%d)", writeCacheKiB), fmt.Sprintf("mmap_size(%d)", mmapBytes),
	}
}

func readPragmas() []string {
	return []string{
		"foreign_keys(1)", "busy_timeout(5000)", "query_only(1)",
		fmt.Sprintf("cache_size(-%d)", readCacheKiB), fmt.Sprintf("mmap_size(%d)", mmapBytes),
	}
}

// dsn builds a modernc DSN. txlock may be "" or "immediate".
func dsn(path string, pragmas []string, txlock string) string {
	escaped := strings.NewReplacer("%", "%25", "?", "%3F", "#", "%23").Replace(path)
	if path == memoryPath {
		escaped = ":memory:"
	}
	var q []string
	for _, p := range pragmas {
		q = append(q, "_pragma="+p)
	}
	if txlock != "" {
		q = append(q, "_txlock="+txlock)
	}
	return "file:" + escaped + "?" + strings.Join(q, "&")
}

// ReadyCheck verifies the database answers a query (backs GET /readyz).
func (d *DB) ReadyCheck(ctx context.Context) error {
	var n int64
	return d.read.QueryRowContext(ctx, "SELECT count(*) FROM users").Scan(&n)
}

// Close releases all connections. It is idempotent.
func (d *DB) Close() error {
	d.closeOnce.Do(func() {
		err := d.read.Close()
		if d.write != d.read {
			if werr := d.write.Close(); err == nil {
				err = werr
			}
		}
		d.closeErr = err
	})
	return d.closeErr
}

// Transaction runs fn inside one BEGIN IMMEDIATE transaction on the single
// write connection, so transactions (and auto-commit writes) are fully
// serialised. An error or panic from fn rolls back.
func (d *DB) Transaction(ctx context.Context, fn func(db.TransactionRepositories) error) (err error) {
	tx, err := d.write.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() {
		if p := recover(); p != nil {
			_ = tx.Rollback()
			panic(p)
		}
	}()
	if err := fn(&txRepos{repos: newRepos(tx, tx)}); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

type txRepos struct{ *repos }

// LockVault verifies the vault exists. The surrounding transaction is already
// BEGIN IMMEDIATE (single writer), so no further locking is required.
func (t *txRepos) LockVault(ctx context.Context, vaultID string) error {
	var id string
	err := t.w.QueryRowContext(ctx, "SELECT id FROM vaults WHERE id=?", vaultID).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("Vault not found: %s", vaultID)
	}
	return err
}
