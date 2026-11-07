package sqlite

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"strings"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

type migration struct {
	version int
	file    string
}

var migrations = []migration{
	{1, "001_initial.sql"},
	{2, "002_vault_name_unique.sql"},
	{3, "003_vault_files_path_fold.sql"},
	{4, "004_graph_cache.sql"},
	{5, "005_revision_manifest_hash_index.sql"},
	{6, "006_oauth_codes.sql"},
	{7, "007_obsidian_sync.sql"},
}

// migrateFile opens a private single-connection handle on a file database,
// migrates it, and closes it. (In-memory databases are migrated in openMemory.)
func migrateFile(path string) error {
	conn, err := sql.Open("sqlite", dsn(path, []string{"busy_timeout(5000)", "journal_mode(WAL)"}, ""))
	if err != nil {
		return err
	}
	defer conn.Close()
	conn.SetMaxOpenConns(1)
	return migrate(context.Background(), conn)
}

// migrate mirrors migrate.ts: user_version chain 1..7, foreign keys disabled
// for the whole run (005 drops a table that file_versions references; with
// enforcement on, DROP TABLE would cascade-delete child rows, and the pragma
// is a no-op inside a transaction), foreign_key_check before the stamp.
func migrate(ctx context.Context, handle *sql.DB) (err error) {
	conn, err := handle.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	var version int
	if err := conn.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	latest := migrations[len(migrations)-1].version
	if version > latest {
		return fmt.Errorf("SQLite schema version %d is newer than supported version %d", version, latest)
	}
	if version == latest {
		return nil
	}
	if _, err := conn.ExecContext(ctx, "PRAGMA foreign_keys = OFF"); err != nil {
		return err
	}
	defer func() {
		// Re-enable on this connection even on failure; the file path also
		// closes the connection straight after.
		if _, ferr := conn.ExecContext(context.Background(), "PRAGMA foreign_keys = ON"); ferr != nil && err == nil {
			err = ferr
		}
	}()
	if _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			_, _ = conn.ExecContext(context.Background(), "ROLLBACK")
		}
	}()
	for _, m := range migrations {
		if m.version <= version {
			continue
		}
		body, rerr := migrationFS.ReadFile("migrations/" + m.file)
		if rerr != nil {
			return rerr
		}
		if _, err := conn.ExecContext(ctx, string(body)); err != nil {
			return fmt.Errorf("migration %s: %w", m.file, err)
		}
	}
	rows, err := conn.QueryContext(ctx, "PRAGMA foreign_key_check")
	if err != nil {
		return err
	}
	var violations []string
	for rows.Next() {
		var table string
		var rowid sql.NullInt64
		var parent string
		var fkid int64
		if err := rows.Scan(&table, &rowid, &parent, &fkid); err != nil {
			_ = rows.Close()
			return err
		}
		violations = append(violations, fmt.Sprintf("{table:%s,rowid:%d,parent:%s,fkid:%d}", table, rowid.Int64, parent, fkid))
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return err
	}
	_ = rows.Close()
	if len(violations) > 0 {
		return fmt.Errorf("SQLite foreign_key_check failed: [%s]", strings.Join(violations, ","))
	}
	if _, err := conn.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version = %d", latest)); err != nil {
		return err
	}
	if _, err := conn.ExecContext(ctx, "COMMIT"); err != nil {
		return err
	}
	committed = true
	return nil
}
