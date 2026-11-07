package api

import (
	"net/http"
	"strings"

	"github.com/championswimmer/tephra/tephra-server/go/internal/httpx"
	"github.com/championswimmer/tephra/tephra-server/go/internal/protocol"
	vm "github.com/championswimmer/tephra/tephra-server/go/internal/vaultmodel"
)

func init() { Register(RegisterChangesRoutes) }

// changesKindForPath: an `.md` extension (case-insensitive) is markdown,
// everything else an attachment (file_versions rows carry no kind).
func changesKindForPath(path string) string {
	base := path
	if i := strings.LastIndex(path, "/"); i >= 0 {
		base = path[i+1:]
	}
	if dot := strings.LastIndex(base, "."); dot >= 0 && strings.ToLower(base[dot+1:]) == "md" {
		return "markdown"
	}
	return "attachment"
}

type changeGroup struct {
	fileID   string
	revision int64
	rows     []vm.FileVersion
}

// RegisterChangesRoutes registers the pull feed GET /vaults/{vaultId}/changes.
func RegisterChangesRoutes(mux *http.ServeMux, d Dependencies) {
	mux.Handle("GET /api/v1/vaults/{vaultId}/changes", httpx.Handle(func(w http.ResponseWriter, r *http.Request) error {
		vault, err := httpx.OwnedVault(r, d, vm.ScopeVaultReadMetadata)
		if err != nil {
			return err
		}
		ctx := r.Context()
		latest := vault.LatestRevision
		q := r.URL.Query()
		rawSince, rawLimit := q.Get("sinceRevision"), q.Get("limit")
		if rawSince == "" {
			return httpx.Fail(http.StatusBadRequest, protocol.CodeInvalidManifest, "A sinceRevision query parameter is required.")
		}
		since, ok := jsSafeInteger(jsNumber(rawSince))
		if !ok || since < 0 {
			return httpx.Fail(http.StatusBadRequest, protocol.CodeInvalidManifest, "sinceRevision must be a non-negative integer.")
		}
		limit := int64(200)
		if rawLimit != "" {
			parsed, ok := jsSafeInteger(jsNumber(rawLimit))
			if !ok || parsed <= 0 {
				return httpx.Fail(http.StatusBadRequest, protocol.CodeInvalidManifest, "limit must be a positive integer.")
			}
			limit = min(parsed, 500)
		}
		lf := httpx.LogFields(r)
		lf.Set("vault_id", vault.ID)
		lf.Set("from_revision", since)
		// Client ahead of the server: the only safe answer is a full resync.
		if since > latest {
			httpx.WriteJSON(w, http.StatusOK, protocol.NewChangesFullResync(latest))
			return nil
		}
		// One emitted entry covers at most two rows (rename + modify at the
		// same revision), so 2*limit+1 rows prove whether more entries remain.
		rows, err := d.Database.FileVersions().ListSince(ctx, vault.ID, since, int(2*limit+1))
		if err != nil {
			return err
		}
		var groups []*changeGroup
		for _, row := range rows {
			if n := len(groups); n > 0 && groups[n-1].fileID == row.FileID && groups[n-1].revision == row.Revision {
				groups[n-1].rows = append(groups[n-1].rows, row)
			} else {
				groups = append(groups, &changeGroup{fileID: row.FileID, revision: row.Revision, rows: []vm.FileVersion{row}})
			}
		}
		truncated := int64(len(groups)) > limit
		page := groups
		if truncated {
			page = groups[:limit]
		}
		// Rename entries need the path the file had before this revision.
		previousPaths := map[string]string{}
		for _, g := range page {
			renamed := false
			for _, row := range g.rows {
				if row.ChangeType == vm.ChangeRename {
					renamed = true
				}
			}
			if !renamed {
				continue
			}
			history, err := d.Database.FileVersions().ListByFile(ctx, vault.ID, g.fileID)
			if err != nil {
				return err
			}
			var prev *vm.FileVersion
			for i := range history {
				if history[i].Revision < g.revision && (prev == nil || history[i].Revision > prev.Revision) {
					prev = &history[i]
				}
			}
			if prev != nil && prev.Path != g.rows[len(g.rows)-1].Path {
				previousPaths[g.fileID] = prev.Path
			}
		}
		changes := make([]protocol.ChangeEntry, 0, len(page))
		for _, g := range page {
			last := g.rows[len(g.rows)-1]
			has := map[vm.FileChangeType]bool{}
			for _, row := range g.rows {
				has[row.ChangeType] = true
			}
			changeType := "modify"
			switch {
			case has[vm.ChangeDelete]:
				changeType = "delete"
			case has[vm.ChangeCreate]:
				changeType = "create"
			case has[vm.ChangeRename]:
				changeType = "rename"
			}
			e := protocol.ChangeEntry{FileID: g.fileID, ChangeType: changeType, Path: last.Path, Kind: changesKindForPath(last.Path), Revision: g.revision}
			if p, ok := previousPaths[g.fileID]; ok {
				e.PreviousPath = strPtr(p)
			}
			// Tombstones carry no blob: blobHash/size/mtime stay absent.
			if changeType != "delete" && last.BlobHash != nil {
				e.BlobHash = last.BlobHash
				e.Size = last.Size
				e.Mtime = last.Mtime
			}
			changes = append(changes, e)
		}
		to := latest
		if len(page) > 0 {
			to = page[len(page)-1].revision
		}
		lf.Set("to_revision", to)
		lf.Set("change_count", len(changes))
		lf.Set("truncated", truncated)
		httpx.WriteJSON(w, http.StatusOK, protocol.NewChangesOK(since, to, latest, truncated, changes))
		return nil
	}))
}
