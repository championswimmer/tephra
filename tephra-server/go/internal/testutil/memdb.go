// Package testutil provides test doubles and helpers shared by the Go server
// tests: an in-memory db.Database, an in-memory blobstore.Store, a fixture
// that builds httpx.Dependencies, and HTTP request helpers.
package testutil

import (
	"context"
	"fmt"
	"sort"
	"sync"

	"github.com/championswimmer/tephra/tephra-server/go/internal/db"
	"github.com/championswimmer/tephra/tephra-server/go/internal/jstext"
	vm "github.com/championswimmer/tephra/tephra-server/go/internal/vaultmodel"
)

// omap is an insertion-ordered string-keyed map.
type omap[V any] struct {
	m    map[string]V
	keys []string
}

func newOmap[V any]() *omap[V] { return &omap[V]{m: map[string]V{}} }

func (o *omap[V]) get(k string) (V, bool) { v, ok := o.m[k]; return v, ok }
func (o *omap[V]) set(k string, v V) {
	if _, ok := o.m[k]; !ok {
		o.keys = append(o.keys, k)
	}
	o.m[k] = v
}
func (o *omap[V]) del(k string) {
	if _, ok := o.m[k]; !ok {
		return
	}
	delete(o.m, k)
	for i, kk := range o.keys {
		if kk == k {
			o.keys = append(o.keys[:i:i], o.keys[i+1:]...)
			break
		}
	}
}
func (o *omap[V]) values() []V {
	out := make([]V, 0, len(o.keys))
	for _, k := range o.keys {
		out = append(out, o.m[k])
	}
	return out
}
func (o *omap[V]) clone() *omap[V] {
	c := &omap[V]{m: make(map[string]V, len(o.m)), keys: append([]string(nil), o.keys...)}
	for k, v := range o.m {
		c.m[k] = v
	}
	return c
}

type state struct {
	users     *omap[vm.User]
	sessions  *omap[vm.Session]
	vaults    *omap[vm.Vault]
	tokens    *omap[vm.ApiToken]
	devices   *omap[vm.Device]
	blobs     *omap[vm.BlobMetadata]
	files     *omap[vm.CurrentVaultFile]
	revisions []vm.VaultRevision
	versions  []vm.FileVersion
	meta      *omap[vm.NoteMetadata]
	links     []vm.NoteLink
	index     *omap[vm.VaultIndexState]
	graph     *omap[db.GraphCacheEntry]
	oauth     *omap[db.OAuthCode]
	obsidian  *omap[vm.ObsidianSyncSettings]
}

func newState() *state {
	return &state{users: newOmap[vm.User](), sessions: newOmap[vm.Session](), vaults: newOmap[vm.Vault](),
		tokens: newOmap[vm.ApiToken](), devices: newOmap[vm.Device](), blobs: newOmap[vm.BlobMetadata](),
		files: newOmap[vm.CurrentVaultFile](), meta: newOmap[vm.NoteMetadata](), index: newOmap[vm.VaultIndexState](),
		graph: newOmap[db.GraphCacheEntry](), oauth: newOmap[db.OAuthCode](), obsidian: newOmap[vm.ObsidianSyncSettings]()}
}

func (s *state) clone() *state {
	return &state{users: s.users.clone(), sessions: s.sessions.clone(), vaults: s.vaults.clone(),
		tokens: s.tokens.clone(), devices: s.devices.clone(), blobs: s.blobs.clone(), files: s.files.clone(),
		revisions: append([]vm.VaultRevision(nil), s.revisions...), versions: append([]vm.FileVersion(nil), s.versions...),
		meta: s.meta.clone(), links: append([]vm.NoteLink(nil), s.links...), index: s.index.clone(),
		graph: s.graph.clone(), oauth: s.oauth.clone(), obsidian: s.obsidian.clone()}
}

// MemoryDatabase is a simple map+mutex db.Database for tests. Transactions
// are serialised and rolled back by restoring a snapshot. It enforces the
// unique constraints tests rely on (users.email, vaults.name, devices/tokens ids)
// and cascades vault deletion like the SQLite foreign keys.
type MemoryDatabase struct {
	mu   sync.Mutex // guards st
	txMu sync.Mutex // serialises transactions
	st   *state
}

var _ db.Database = (*MemoryDatabase)(nil)

// NewMemoryDatabase returns an empty database.
func NewMemoryDatabase() *MemoryDatabase { return &MemoryDatabase{st: newState()} }

type txRepos struct{ *MemoryDatabase }

func (txRepos) LockVault(context.Context, string) error { return nil }

// Transaction runs fn atomically (snapshot/restore on error or panic).
func (m *MemoryDatabase) Transaction(ctx context.Context, fn func(db.TransactionRepositories) error) (err error) {
	m.txMu.Lock()
	defer m.txMu.Unlock()
	m.mu.Lock()
	snap := m.st.clone()
	m.mu.Unlock()
	done := false
	defer func() {
		if !done || err != nil {
			m.mu.Lock()
			m.st = snap
			m.mu.Unlock()
		}
	}()
	err = fn(txRepos{m})
	done = true
	return err
}

func (m *MemoryDatabase) ObsidianSync() db.ObsidianSyncRepository { return obsidianRepo{m} }
func (m *MemoryDatabase) Users() db.UserRepository                { return userRepo{m} }
func (m *MemoryDatabase) Sessions() db.SessionRepository          { return sessionRepo{m} }
func (m *MemoryDatabase) Vaults() db.VaultRepository              { return vaultRepo{m} }
func (m *MemoryDatabase) Devices() db.DeviceRepository            { return deviceRepo{m} }
func (m *MemoryDatabase) ApiTokens() db.ApiTokenRepository        { return tokenRepo{m} }
func (m *MemoryDatabase) OAuthCodes() db.OAuthCodeRepository      { return oauthRepo{m} }
func (m *MemoryDatabase) Blobs() db.BlobRepository                { return blobRepo{m} }
func (m *MemoryDatabase) VaultFiles() db.VaultFileRepository      { return fileRepo{m} }
func (m *MemoryDatabase) VaultRevisions() db.VaultRevisionRepository {
	return revisionRepo{m}
}
func (m *MemoryDatabase) FileVersions() db.FileVersionRepository { return versionRepo{m} }
func (m *MemoryDatabase) NoteIndex() db.NoteIndexRepository      { return noteRepo{m} }
func (m *MemoryDatabase) GraphCache() db.GraphCacheRepository    { return graphRepo{m} }

func ptr[T any](v T) *T { return &v }

var errUnique = func(what string) error { return fmt.Errorf("UNIQUE constraint failed: %s", what) }

// ---- users ----
type userRepo struct{ *MemoryDatabase }

func (r userRepo) Count(context.Context) (int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return int64(len(r.st.users.keys)), nil
}
func (r userRepo) FindByID(_ context.Context, id string) (*vm.User, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if u, ok := r.st.users.get(id); ok {
		return &u, nil
	}
	return nil, nil
}
func (r userRepo) FindByEmail(_ context.Context, email string) (*vm.User, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, u := range r.st.users.values() {
		if u.Email == email {
			return ptr(u), nil
		}
	}
	return nil, nil
}
func (r userRepo) Insert(_ context.Context, u vm.User) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.st.users.get(u.ID); ok {
		return errUnique("users.id")
	}
	for _, o := range r.st.users.values() {
		if o.Email == u.Email {
			return errUnique("users.email")
		}
	}
	r.st.users.set(u.ID, u)
	return nil
}
func (r userRepo) Update(_ context.Context, u vm.User) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.st.users.set(u.ID, u)
	return nil
}

// ---- sessions ----
type sessionRepo struct{ *MemoryDatabase }

func (r sessionRepo) FindByID(_ context.Context, id string) (*vm.Session, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if s, ok := r.st.sessions.get(id); ok {
		return &s, nil
	}
	return nil, nil
}
func (r sessionRepo) Insert(_ context.Context, s vm.Session) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.st.sessions.set(s.ID, s)
	return nil
}
func (r sessionRepo) Delete(_ context.Context, id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.st.sessions.del(id)
	return nil
}
func (r sessionRepo) DeleteExpired(_ context.Context, now int64) (int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var n int64
	for _, s := range r.st.sessions.values() {
		if s.ExpiresAt <= now {
			r.st.sessions.del(s.ID)
			n++
		}
	}
	return n, nil
}

// ---- vaults ----
type vaultRepo struct{ *MemoryDatabase }

func (r vaultRepo) FindByID(_ context.Context, id string) (*vm.Vault, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if v, ok := r.st.vaults.get(id); ok {
		return &v, nil
	}
	return nil, nil
}
func (r vaultRepo) FindByName(_ context.Context, name string) (*vm.Vault, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, v := range r.st.vaults.values() {
		if v.Name == name {
			return ptr(v), nil
		}
	}
	return nil, nil
}
func (r vaultRepo) ListByOwner(_ context.Context, owner string) ([]vm.Vault, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []vm.Vault
	for _, v := range r.st.vaults.values() {
		if v.OwnerUserID == owner {
			out = append(out, v)
		}
	}
	return out, nil
}
func (r vaultRepo) Insert(_ context.Context, v vm.Vault) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.st.vaults.get(v.ID); ok {
		return errUnique("vaults.id")
	}
	for _, o := range r.st.vaults.values() {
		if o.Name == v.Name {
			return errUnique("vaults.name")
		}
	}
	r.st.vaults.set(v.ID, v)
	return nil
}
func (r vaultRepo) Update(_ context.Context, v vm.Vault) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.st.vaults.set(v.ID, v)
	return nil
}
func (r vaultRepo) Delete(_ context.Context, id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	s := r.st
	s.vaults.del(id)
	for _, t := range s.tokens.values() {
		if t.VaultID != nil && *t.VaultID == id {
			s.tokens.del(t.ID)
		}
	}
	for _, f := range s.files.values() {
		if f.VaultID == id {
			s.files.del(id + "\x00" + f.FileID)
			s.meta.del(f.FileID)
		}
	}
	s.revisions = filter(s.revisions, func(x vm.VaultRevision) bool { return x.VaultID != id })
	s.versions = filter(s.versions, func(x vm.FileVersion) bool { return x.VaultID != id })
	s.links = filter(s.links, func(x vm.NoteLink) bool { return x.VaultID != id })
	for _, m := range s.meta.values() {
		if m.VaultID == id {
			s.meta.del(m.FileID)
		}
	}
	s.index.del(id)
	s.graph.del(id)
	s.obsidian.del(id)
	for _, c := range s.oauth.values() {
		if c.VaultID == id {
			s.oauth.del(c.CodeHash)
		}
	}
	return nil
}

func filter[T any](in []T, keep func(T) bool) []T {
	var out []T
	for _, x := range in {
		if keep(x) {
			out = append(out, x)
		}
	}
	return out
}

// ---- devices ----
type deviceRepo struct{ *MemoryDatabase }

func (r deviceRepo) FindByID(_ context.Context, id string) (*vm.Device, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if d, ok := r.st.devices.get(id); ok {
		return &d, nil
	}
	return nil, nil
}
func (r deviceRepo) ListByUser(_ context.Context, userID string) ([]vm.Device, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return filter(r.st.devices.values(), func(d vm.Device) bool { return d.UserID == userID }), nil
}
func (r deviceRepo) Insert(_ context.Context, d vm.Device) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.st.devices.get(d.ID); ok {
		return errUnique("devices.id")
	}
	r.st.devices.set(d.ID, d)
	return nil
}
func (r deviceRepo) Update(_ context.Context, d vm.Device) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.st.devices.set(d.ID, d)
	return nil
}

// ---- api tokens ----
type tokenRepo struct{ *MemoryDatabase }

func (r tokenRepo) FindByID(_ context.Context, id string) (*vm.ApiToken, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if t, ok := r.st.tokens.get(id); ok {
		return &t, nil
	}
	return nil, nil
}
func (r tokenRepo) FindByTokenHash(_ context.Context, h string) (*vm.ApiToken, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, t := range r.st.tokens.values() {
		if t.TokenHash == h {
			return ptr(t), nil
		}
	}
	return nil, nil
}
func (r tokenRepo) ListByVault(_ context.Context, vaultID string) ([]vm.ApiToken, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return filter(r.st.tokens.values(), func(t vm.ApiToken) bool { return t.VaultID != nil && *t.VaultID == vaultID }), nil
}
func (r tokenRepo) Insert(_ context.Context, t vm.ApiToken) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.st.tokens.set(t.ID, t)
	return nil
}
func (r tokenRepo) Update(_ context.Context, t vm.ApiToken) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.st.tokens.set(t.ID, t)
	return nil
}
func (r tokenRepo) Delete(_ context.Context, id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.st.tokens.del(id)
	return nil
}

// ---- oauth codes ----
type oauthRepo struct{ *MemoryDatabase }

func (r oauthRepo) Insert(_ context.Context, c db.OAuthCode) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.st.oauth.set(c.CodeHash, c)
	return nil
}
func (r oauthRepo) Consume(_ context.Context, h string) (*db.OAuthCode, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	c, ok := r.st.oauth.get(h)
	if !ok {
		return nil, nil
	}
	r.st.oauth.del(h)
	return &c, nil
}
func (r oauthRepo) DeleteExpired(_ context.Context, now int64) (int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var n int64
	for _, c := range r.st.oauth.values() {
		if c.ExpiresAt <= now {
			r.st.oauth.del(c.CodeHash)
			n++
		}
	}
	return n, nil
}

// ---- blobs ----
type blobRepo struct{ *MemoryDatabase }

func (r blobRepo) FindByHash(_ context.Context, h string) (*vm.BlobMetadata, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if b, ok := r.st.blobs.get(h); ok {
		return &b, nil
	}
	return nil, nil
}
func (r blobRepo) FindByHashes(_ context.Context, hs []string) ([]vm.BlobMetadata, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []vm.BlobMetadata
	for _, h := range hs {
		if b, ok := r.st.blobs.get(h); ok {
			out = append(out, b)
		}
	}
	return out, nil
}
func (r blobRepo) FindUnreferencedOlderThan(_ context.Context, cutoff int64, limit int) ([]vm.BlobMetadata, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	ref := map[string]bool{}
	for _, f := range r.st.files.values() {
		ref[f.BlobHash] = true
	}
	for _, v := range r.st.versions {
		if v.BlobHash != nil {
			ref[*v.BlobHash] = true
		}
	}
	var out []vm.BlobMetadata
	for _, b := range r.st.blobs.values() {
		if !ref[b.Hash] && b.CreatedAt < cutoff {
			out = append(out, b)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].CreatedAt < out[j].CreatedAt })
	if limit >= 0 && len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}
func (r blobRepo) Insert(_ context.Context, b vm.BlobMetadata) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.st.blobs.get(b.Hash); ok {
		return errUnique("blobs.hash")
	}
	r.st.blobs.set(b.Hash, b)
	return nil
}
func (r blobRepo) Delete(_ context.Context, h string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.st.blobs.del(h)
	return nil
}

// ---- vault files ----
type fileRepo struct{ *MemoryDatabase }

func fileKey(vaultID, fileID string) string { return vaultID + "\x00" + fileID }

func (r fileRepo) FindByID(_ context.Context, vaultID, fileID string) (*vm.CurrentVaultFile, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if f, ok := r.st.files.get(fileKey(vaultID, fileID)); ok {
		return &f, nil
	}
	return nil, nil
}
func (r fileRepo) FindByPath(_ context.Context, vaultID, path string) (*vm.CurrentVaultFile, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, f := range r.st.files.values() {
		if f.VaultID == vaultID && f.Path == path {
			return ptr(f), nil
		}
	}
	return nil, nil
}
func (r fileRepo) FindByPathFold(_ context.Context, vaultID, fold string) ([]vm.CurrentVaultFile, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return filter(r.st.files.values(), func(f vm.CurrentVaultFile) bool {
		return f.VaultID == vaultID && jstext.Lower(jstext.NFC(f.Path)) == fold
	}), nil
}
func (r fileRepo) ListByVault(_ context.Context, vaultID string) ([]vm.CurrentVaultFile, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return filter(r.st.files.values(), func(f vm.CurrentVaultFile) bool { return f.VaultID == vaultID }), nil
}
func (r fileRepo) Upsert(_ context.Context, f vm.CurrentVaultFile) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.st.files.set(fileKey(f.VaultID, f.FileID), f)
	return nil
}
func (r fileRepo) Delete(_ context.Context, vaultID, fileID string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.st.files.del(fileKey(vaultID, fileID))
	return nil
}

// ---- revisions ----
type revisionRepo struct{ *MemoryDatabase }

func (r revisionRepo) Find(_ context.Context, vaultID string, rev int64) (*vm.VaultRevision, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, x := range r.st.revisions {
		if x.VaultID == vaultID && x.Revision == rev {
			return ptr(x), nil
		}
	}
	return nil, nil
}
func (r revisionRepo) FindLatest(_ context.Context, vaultID string) (*vm.VaultRevision, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var best *vm.VaultRevision
	for _, x := range r.st.revisions {
		if x.VaultID == vaultID && (best == nil || x.Revision > best.Revision) {
			best = ptr(x)
		}
	}
	return best, nil
}
func (r revisionRepo) FindByManifestHash(_ context.Context, vaultID, h string) (*vm.VaultRevision, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var best *vm.VaultRevision
	for _, x := range r.st.revisions {
		if x.VaultID == vaultID && x.ManifestHash == h && (best == nil || x.Revision > best.Revision) {
			best = ptr(x)
		}
	}
	return best, nil
}
func (r revisionRepo) List(_ context.Context, vaultID string) ([]vm.VaultRevision, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := filter(r.st.revisions, func(x vm.VaultRevision) bool { return x.VaultID == vaultID })
	sort.SliceStable(out, func(i, j int) bool { return out[i].Revision < out[j].Revision })
	return out, nil
}
func (r revisionRepo) Insert(_ context.Context, rev vm.VaultRevision) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, x := range r.st.revisions {
		if x.VaultID == rev.VaultID && x.Revision == rev.Revision {
			return errUnique("vault_revisions.vault_id, vault_revisions.revision")
		}
	}
	r.st.revisions = append(r.st.revisions, rev)
	return nil
}

// ---- file versions ----
type versionRepo struct{ *MemoryDatabase }

func (r versionRepo) ListByRevision(_ context.Context, vaultID string, rev int64) ([]vm.FileVersion, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return filter(r.st.versions, func(v vm.FileVersion) bool { return v.VaultID == vaultID && v.Revision == rev }), nil
}
func (r versionRepo) ListByFile(_ context.Context, vaultID, fileID string) ([]vm.FileVersion, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := filter(r.st.versions, func(v vm.FileVersion) bool { return v.VaultID == vaultID && v.FileID == fileID })
	sort.SliceStable(out, func(i, j int) bool { return out[i].Revision < out[j].Revision })
	return out, nil
}
func (r versionRepo) FindLatestByPath(_ context.Context, vaultID, path string) (*vm.FileVersion, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var best *vm.FileVersion
	for _, v := range r.st.versions {
		if v.VaultID == vaultID && v.Path == path && (best == nil || v.Revision >= best.Revision) {
			best = ptr(v)
		}
	}
	return best, nil
}
func (r versionRepo) ListSince(_ context.Context, vaultID string, since int64, limit int) ([]vm.FileVersion, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := filter(r.st.versions, func(v vm.FileVersion) bool { return v.VaultID == vaultID && v.Revision > since })
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Revision != out[j].Revision {
			return out[i].Revision < out[j].Revision
		}
		return out[i].ID < out[j].ID
	})
	if limit >= 0 && len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}
func (r versionRepo) InsertMany(_ context.Context, vs []vm.FileVersion) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.st.versions = append(r.st.versions, vs...)
	return nil
}

// ---- note index ----
type noteRepo struct{ *MemoryDatabase }

func (r noteRepo) FindMetadata(_ context.Context, fileID string) (*vm.NoteMetadata, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if m, ok := r.st.meta.get(fileID); ok {
		return &m, nil
	}
	return nil, nil
}
func (r noteRepo) ListMetadata(_ context.Context, vaultID string) ([]vm.NoteMetadata, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return filter(r.st.meta.values(), func(m vm.NoteMetadata) bool { return m.VaultID == vaultID }), nil
}
func (r noteRepo) UpsertMetadata(_ context.Context, m vm.NoteMetadata) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.st.meta.set(m.FileID, m)
	return nil
}
func (r noteRepo) DeleteMetadata(_ context.Context, fileID string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.st.meta.del(fileID)
	return nil
}
func (r noteRepo) ListLinksBySource(_ context.Context, vaultID, src string) ([]vm.NoteLink, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return filter(r.st.links, func(l vm.NoteLink) bool { return l.VaultID == vaultID && l.SourceFileID == src }), nil
}
func (r noteRepo) ListLinksByTarget(_ context.Context, vaultID, tgt string) ([]vm.NoteLink, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return filter(r.st.links, func(l vm.NoteLink) bool {
		return l.VaultID == vaultID && l.TargetFileID != nil && *l.TargetFileID == tgt
	}), nil
}
func (r noteRepo) ListLinks(_ context.Context, vaultID string) ([]vm.NoteLink, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return filter(r.st.links, func(l vm.NoteLink) bool { return l.VaultID == vaultID }), nil
}
func (r noteRepo) ReplaceLinksForSource(_ context.Context, vaultID, src string, links []vm.NoteLink) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.st.links = filter(r.st.links, func(l vm.NoteLink) bool { return !(l.VaultID == vaultID && l.SourceFileID == src) })
	r.st.links = append(r.st.links, links...)
	return nil
}
func (r noteRepo) GetState(_ context.Context, vaultID string) (*vm.VaultIndexState, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if s, ok := r.st.index.get(vaultID); ok {
		return &s, nil
	}
	return nil, nil
}
func (r noteRepo) SetState(_ context.Context, s vm.VaultIndexState) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.st.index.set(s.VaultID, s)
	return nil
}

// ---- graph cache ----
type graphRepo struct{ *MemoryDatabase }

func (r graphRepo) Find(_ context.Context, vaultID string) (*db.GraphCacheEntry, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if e, ok := r.st.graph.get(vaultID); ok {
		return &e, nil
	}
	return nil, nil
}
func (r graphRepo) Upsert(_ context.Context, e db.GraphCacheEntry) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.st.graph.set(e.VaultID, e)
	return nil
}
func (r graphRepo) DeleteByVault(_ context.Context, vaultID string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.st.graph.del(vaultID)
	return nil
}

// ---- obsidian sync ----
type obsidianRepo struct{ *MemoryDatabase }

func (r obsidianRepo) Find(_ context.Context, vaultID string) (*vm.ObsidianSyncSettings, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if s, ok := r.st.obsidian.get(vaultID); ok {
		return &s, nil
	}
	return nil, nil
}
func (r obsidianRepo) List(context.Context) ([]vm.ObsidianSyncSettings, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.st.obsidian.values(), nil
}
func (r obsidianRepo) Upsert(_ context.Context, s vm.ObsidianSyncSettings) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.st.obsidian.set(s.VaultID, s)
	return nil
}
