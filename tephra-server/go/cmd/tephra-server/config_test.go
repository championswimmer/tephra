package main

import (
	"testing"
	"time"
)

func env(m map[string]string) func(string) (string, bool) {
	return func(k string) (string, bool) { v, ok := m[k]; return v, ok }
}

func TestDefaults(t *testing.T) {
	c, err := LoadConfig(env(nil), "/tmp")
	if err != nil {
		t.Fatal(err)
	}
	if c.Host != "127.0.0.1" || c.Port != 8080 || c.SecureCookies || c.SQLitePath != "./data/tephra.db" ||
		c.BlobPath != "./data/blobs" || c.MaxBlobBytes != 100<<20 || c.WebRoot != "./tephra-server/apps/web/dist" ||
		!c.ObsidianEnabled || c.ObsidianRoot != "data/obsidian-sync" || c.ObsidianCachePath != "/tmp/tephra-obsidian-client" ||
		c.ObsidianMaxVaults != 5 || c.ObsidianScanInterval != 2*time.Second || c.PublicURL != "" {
		t.Fatalf("unexpected defaults: %+v", c)
	}
}

func TestOverrides(t *testing.T) {
	c, err := LoadConfig(env(map[string]string{
		"HOST": "0.0.0.0", "PORT": "9", "NODE_ENV": "production", "TEPHRA_SQLITE_PATH": "/d/x.db",
		"TEPHRA_OBSIDIAN_SYNC_ENABLED": "false", "TEPHRA_MAX_BLOB_BYTES": "42", "TEPHRA_BOOTSTRAP_TOKEN": "t",
	}), "/tmp")
	if err != nil {
		t.Fatal(err)
	}
	if c.Host != "0.0.0.0" || c.Port != 9 || !c.SecureCookies || c.SQLitePath != "/d/x.db" || c.ObsidianEnabled ||
		c.MaxBlobBytes != 42 || c.BootstrapToken != "t" {
		t.Fatalf("unexpected: %+v", c)
	}
	c, _ = LoadConfig(env(map[string]string{"TEPHRA_SQLITE_PATH": "/d/x.db"}), "/tmp")
	if c.ObsidianRoot != "/d/obsidian-sync" {
		t.Fatalf("root %q", c.ObsidianRoot)
	}
}

func TestErrors(t *testing.T) {
	cases := map[string]string{
		"TEPHRA_DATABASE_DRIVER":             "Tephra is disk-only: TEPHRA_DATABASE_DRIVER must be sqlite",
		"TEPHRA_BLOB_DRIVER":                 "Tephra is disk-only: TEPHRA_BLOB_DRIVER must be filesystem",
		"PORT":                               "PORT must be a positive integer",
		"TEPHRA_MAX_BLOB_BYTES":              "TEPHRA_MAX_BLOB_BYTES must be a positive integer",
		"TEPHRA_OBSIDIAN_MAX_VAULTS":         "TEPHRA_OBSIDIAN_MAX_VAULTS must be a positive integer",
		"TEPHRA_OBSIDIAN_SCAN_INTERVAL_SECS": "TEPHRA_OBSIDIAN_SCAN_INTERVAL_SECS must be a positive integer",
	}
	for k, want := range cases {
		for _, bad := range []string{"postgres", "0", "-1", "abc", ""} {
			_, err := LoadConfig(env(map[string]string{k: bad}), "/tmp")
			if err == nil || err.Error() != want {
				t.Errorf("%s=%q: got %v want %q", k, bad, err, want)
			}
		}
	}
	if _, err := LoadConfig(env(map[string]string{"TEPHRA_MAX_BLOB_BYTES": "1.5"}), ""); err == nil {
		t.Error("fractional accepted")
	}
}
