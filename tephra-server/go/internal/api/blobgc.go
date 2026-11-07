package api

import (
	"context"
	"log/slog"
	"time"
)

const (
	// DefaultBlobGCAgeMs is the grace period before an unreferenced blob is
	// eligible for collection (7 days).
	DefaultBlobGCAgeMs int64 = 7 * 24 * 60 * 60 * 1000
	// DefaultBlobGCLimit is the maximum number of blobs deleted per run.
	DefaultBlobGCLimit = 1000
	// DefaultBlobGCInterval is the period of the StartBlobGC loop.
	DefaultBlobGCInterval = 24 * time.Hour
)

// CollectBlobsOptions tunes CollectUnreferencedBlobs; zero values mean defaults.
type CollectBlobsOptions struct {
	// Now is the reference time in epoch ms (0: the dependency clock).
	Now int64
	// OlderThanMs is the minimum blob age (0: DefaultBlobGCAgeMs).
	OlderThanMs int64
	// Limit is the maximum deletions per run (0: DefaultBlobGCLimit).
	Limit int
}

// CollectUnreferencedBlobs deletes blobs that no current vault file or
// retained file version references and that are older than the grace period.
// Blobs from in-flight uploads are always newer than the cutoff. It returns
// the hashes that were deleted (never nil).
func CollectUnreferencedBlobs(ctx context.Context, d Dependencies, opts CollectBlobsOptions) ([]string, error) {
	now := opts.Now
	if now == 0 {
		now = d.Clock.Now()
	}
	age := opts.OlderThanMs
	if age == 0 {
		age = DefaultBlobGCAgeMs
	}
	limit := opts.Limit
	if limit == 0 {
		limit = DefaultBlobGCLimit
	}
	candidates, err := d.Database.Blobs().FindUnreferencedOlderThan(ctx, now-age, limit)
	if err != nil {
		return nil, err
	}
	deleted := []string{}
	for _, c := range candidates {
		if err := d.BlobStore.Delete(ctx, c.Hash); err != nil {
			return deleted, err
		}
		if err := d.Database.Blobs().Delete(ctx, c.Hash); err != nil {
			return deleted, err
		}
		deleted = append(deleted, c.Hash)
	}
	return deleted, nil
}

// BlobGCOptions configures StartBlobGC.
type BlobGCOptions struct {
	CollectBlobsOptions
	// Interval between runs (0: DefaultBlobGCInterval). The first run happens
	// one interval after start, never on the startup/sync hot path.
	Interval time.Duration
}

// StartBlobGC runs CollectUnreferencedBlobs periodically until ctx is
// cancelled. The returned channel is closed once the loop has exited. The Node
// server only exposes the routine (README: "run as a periodic maintenance
// job"); the loop is an opt-in convenience with the same semantics.
func StartBlobGC(ctx context.Context, d Dependencies, opts ...BlobGCOptions) <-chan struct{} {
	var o BlobGCOptions
	if len(opts) > 0 {
		o = opts[0]
	}
	if o.Interval <= 0 {
		o.Interval = DefaultBlobGCInterval
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		t := time.NewTicker(o.Interval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				// A fixed Now (tests) is honoured; otherwise each run uses the live clock.
				deleted, err := CollectUnreferencedBlobs(ctx, d, o.CollectBlobsOptions)
				if err != nil {
					if ctx.Err() == nil {
						slog.Error("Blob garbage collection failed", "error", err.Error())
					}
					continue
				}
				if len(deleted) > 0 {
					slog.Info("Blob garbage collection finished", "deleted_blobs", len(deleted))
				}
			}
		}
	}()
	return done
}
