package main

import (
	"errors"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Config mirrors the environment handling in apps/api/src/main.ts.
type Config struct {
	Host           string
	Port           int
	SecureCookies  bool
	SQLitePath     string
	BlobPath       string
	BootstrapToken string
	PublicURL      string
	MaxBlobBytes   int64
	WebRoot        string

	ObsidianEnabled      bool
	ObsidianRoot         string
	ObsidianCachePath    string
	ObsidianMaxVaults    int
	ObsidianScanInterval time.Duration
}

// LoadConfig reads the configuration through lookup (os.LookupEnv in main).
// Like process.env.X ?? fallback, a variable that is set but empty is kept.
func LoadConfig(lookup func(string) (string, bool), tmpDir string) (Config, error) {
	get := func(name, fallback string) string {
		if v, ok := lookup(name); ok {
			return v
		}
		return fallback
	}
	integer := func(name string, fallback int64) (int64, error) {
		v, ok := lookup(name)
		if !ok {
			return fallback, nil
		}
		n, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64)
		if err != nil || n <= 0 || n > 1<<53-1 {
			return 0, fmt.Errorf("%s must be a positive integer", name)
		}
		return n, nil
	}

	if get("TEPHRA_DATABASE_DRIVER", "sqlite") != "sqlite" {
		return Config{}, errors.New("Tephra is disk-only: TEPHRA_DATABASE_DRIVER must be sqlite")
	}
	if get("TEPHRA_BLOB_DRIVER", "filesystem") != "filesystem" {
		return Config{}, errors.New("Tephra is disk-only: TEPHRA_BLOB_DRIVER must be filesystem")
	}

	c := Config{
		Host:           get("HOST", "127.0.0.1"),
		SecureCookies:  get("NODE_ENV", "") == "production",
		SQLitePath:     get("TEPHRA_SQLITE_PATH", "./data/tephra.db"),
		BlobPath:       get("TEPHRA_BLOB_PATH", "./data/blobs"),
		BootstrapToken: get("TEPHRA_BOOTSTRAP_TOKEN", ""),
		PublicURL:      get("TEPHRA_PUBLIC_URL", ""),
		WebRoot:        get("TEPHRA_WEB_ROOT", "./tephra-server/apps/web/dist"),
	}
	var err error
	// Evaluation order follows main.ts (max blob bytes, then sync, then PORT).
	if c.MaxBlobBytes, err = integer("TEPHRA_MAX_BLOB_BYTES", 100*1024*1024); err != nil {
		return Config{}, err
	}
	c.ObsidianEnabled = get("TEPHRA_OBSIDIAN_SYNC_ENABLED", "") != "false"
	if c.ObsidianEnabled {
		c.ObsidianRoot = get("TEPHRA_OBSIDIAN_SYNC_PATH", filepath.Join(filepath.Dir(c.SQLitePath), "obsidian-sync"))
		c.ObsidianCachePath = get("TEPHRA_OBSIDIAN_CACHE_PATH", filepath.Join(tmpDir, "tephra-obsidian-client"))
		n, err := integer("TEPHRA_OBSIDIAN_MAX_VAULTS", 5)
		if err != nil {
			return Config{}, err
		}
		c.ObsidianMaxVaults = int(n)
		secs, err := integer("TEPHRA_OBSIDIAN_SCAN_INTERVAL_SECS", 2)
		if err != nil {
			return Config{}, err
		}
		c.ObsidianScanInterval = time.Duration(secs) * time.Second
	}
	port, err := integer("PORT", 8080)
	if err != nil {
		return Config{}, err
	}
	c.Port = int(port)
	return c, nil
}
