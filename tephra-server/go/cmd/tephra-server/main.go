// Command tephra-server is the Go port of apps/api/src/main.ts.
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"runtime/debug"
	"strconv"
	"syscall"
	"time"

	"github.com/championswimmer/tephra/tephra-server/go/internal/api"
	"github.com/championswimmer/tephra/tephra-server/go/internal/blobstore/fs"
	"github.com/championswimmer/tephra/tephra-server/go/internal/core"
	"github.com/championswimmer/tephra/tephra-server/go/internal/db/sqlite"
	"github.com/championswimmer/tephra/tephra-server/go/internal/indexer"
	"github.com/championswimmer/tephra/tephra-server/go/internal/obsidian"
)

// tuneRuntime lowers the idle footprint. GOGC / GOMEMLIMIT, when set by the
// operator, always win (the runtime reads them before main).
func tuneRuntime() {
	if _, ok := os.LookupEnv("GOGC"); !ok {
		debug.SetGCPercent(50)
	}
}

// newHTTPServer applies the connection limits. Node's http server enforces
// requestTimeout=300s (whole request, body included) and a header timeout;
// without ReadTimeout a slow-body client could hold a connection and goroutine
// forever on the unauthenticated endpoints. There is deliberately no
// WriteTimeout, so large blob downloads on slow links keep working.
func newHTTPServer(handler http.Handler) *http.Server {
	return &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 15 * time.Second,
		ReadTimeout:       300 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(runHealthcheck(os.LookupEnv, defaultHealthClient(), os.Stderr))
	}
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	tuneRuntime()
	cfg, err := LoadConfig(os.LookupEnv, os.TempDir())
	if err != nil {
		return err
	}

	clock := core.SystemClock{}
	ids := core.NewUuidV7Generator(clock)
	database, err := sqlite.Open(cfg.SQLitePath)
	if err != nil {
		return err
	}
	blobStore, err := fs.New(cfg.BlobPath)
	if err != nil {
		_ = database.Close()
		return err
	}
	deps := api.Dependencies{
		Database:       database,
		BlobStore:      blobStore,
		Clock:          clock,
		IDs:            ids,
		PasswordHasher: api.NewScryptHasher(),
		BootstrapToken: cfg.BootstrapToken,
		IndexService:   indexer.NewRuntimeIndexService(indexer.RuntimeDeps{Database: database, BlobStore: blobStore, Clock: clock, IDs: ids}),
		PublicURL:      cfg.PublicURL,
		SecureCookies:  cfg.SecureCookies,
		MaxBlobBytes:   cfg.MaxBlobBytes,
	}
	var nativeSync *obsidian.NativeSyncService
	if cfg.ObsidianEnabled {
		installer := obsidian.NewRuntimeInstaller(cfg.ObsidianCachePath, nil)
		nativeSync = obsidian.NewNativeSyncService(deps, obsidian.Options{
			Root:         cfg.ObsidianRoot,
			Client:       obsidian.NewHeadlessClient(installer, nil),
			MaxVaults:    cfg.ObsidianMaxVaults,
			ScanInterval: cfg.ObsidianScanInterval,
		})
		deps.ObsidianSync = nativeSync // only when enabled: nil interface means disabled
	}
	web := staticFiles{root: cfg.WebRoot}
	handler := api.NewApp(deps, func(mux *http.ServeMux, _ api.Dependencies) { web.register(mux) })

	ln, err := net.Listen("tcp", net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port)))
	if err != nil {
		_ = database.Close()
		return err
	}
	srv := newHTTPServer(handler)

	// Startup is asynchronous: installation/network failures must not prevent normal vault access.
	if nativeSync != nil {
		go func() {
			if err := nativeSync.Boot(context.Background()); err != nil {
				log.SetFlags(0)
				fmt.Fprintln(os.Stderr, "Obsidian Sync startup failed. Retry from Settings.")
			}
		}()
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	serveErr := make(chan error, 1)
	go func() { serveErr <- srv.Serve(ln) }()

	select {
	case err := <-serveErr:
		if nativeSync != nil {
			nativeSync.Close()
		}
		_ = database.Close()
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	case <-sig:
	}

	// Force exit after 10 s, like the Node timer.
	force := time.AfterFunc(10*time.Second, func() {
		_ = database.Close()
		os.Exit(1)
	})
	defer force.Stop()
	done := make(chan struct{})
	go func() {
		if nativeSync != nil {
			nativeSync.Close()
		}
		close(done)
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
	<-done
	_ = database.Close()
	return nil
}
