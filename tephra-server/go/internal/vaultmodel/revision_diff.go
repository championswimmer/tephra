package vaultmodel

import "github.com/championswimmer/tephra/tephra-server/go/internal/core"

// RevisionDiff is the result of DiffRevision. Slices are never nil.
type RevisionDiff struct {
	Versions        []FileVersion
	CreatedFileIDs  []string
	ModifiedFileIDs []string
	RenamedFileIDs  []string
	DeletedFileIDs  []string
	IsNoOp          bool
}

// DiffRevisionInput are the inputs to DiffRevision.
type DiffRevisionInput struct {
	VaultID   string
	Revision  int64
	CreatedAt int64
	Current   []CurrentVaultFile
	Incoming  []IncomingVaultFile
	IDs       core.IdGenerator
}

// DiffRevision diffs a complete incoming manifest by stable file ID. A
// simultaneous rename and content change emits both append-only events at the
// same revision. Event order: incoming order (rename before modify), then
// deletions in current order.
func DiffRevision(in DiffRevisionInput) RevisionDiff {
	currentByID := make(map[string]CurrentVaultFile, len(in.Current))
	for _, f := range in.Current {
		currentByID[f.FileID] = f
	}
	incomingIDs := make(map[string]struct{}, len(in.Incoming))
	for _, f := range in.Incoming {
		incomingIDs[f.FileID] = struct{}{}
	}
	out := RevisionDiff{
		Versions:        []FileVersion{},
		CreatedFileIDs:  []string{},
		ModifiedFileIDs: []string{},
		RenamedFileIDs:  []string{},
		DeletedFileIDs:  []string{},
	}

	appendVersion := func(f IncomingVaultFile, ct FileChangeType) {
		hash := f.BlobHash
		size := f.Size
		mtime := f.Mtime
		out.Versions = append(out.Versions, FileVersion{
			ID:         in.IDs.Generate(),
			VaultID:    in.VaultID,
			FileID:     f.FileID,
			Revision:   in.Revision,
			Path:       f.Path,
			BlobHash:   &hash,
			Size:       &size,
			Mtime:      &mtime,
			ChangeType: ct,
			CreatedAt:  in.CreatedAt,
		})
	}

	for _, f := range in.Incoming {
		prev, ok := currentByID[f.FileID]
		if !ok {
			out.CreatedFileIDs = append(out.CreatedFileIDs, f.FileID)
			appendVersion(f, ChangeCreate)
			continue
		}
		if prev.Path != f.Path {
			out.RenamedFileIDs = append(out.RenamedFileIDs, f.FileID)
			appendVersion(f, ChangeRename)
		}
		if prev.BlobHash != f.BlobHash {
			out.ModifiedFileIDs = append(out.ModifiedFileIDs, f.FileID)
			appendVersion(f, ChangeModify)
		}
	}

	for _, f := range in.Current {
		if _, ok := incomingIDs[f.FileID]; ok {
			continue
		}
		out.DeletedFileIDs = append(out.DeletedFileIDs, f.FileID)
		out.Versions = append(out.Versions, FileVersion{
			ID:         in.IDs.Generate(),
			VaultID:    in.VaultID,
			FileID:     f.FileID,
			Revision:   in.Revision,
			Path:       f.Path,
			ChangeType: ChangeDelete,
			CreatedAt:  in.CreatedAt,
		})
	}
	out.IsNoOp = len(out.Versions) == 0
	return out
}
