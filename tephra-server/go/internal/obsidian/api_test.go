package obsidian

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"github.com/championswimmer/tephra/tephra-server/go/internal/api"
	"github.com/championswimmer/tephra/tephra-server/go/internal/blobstore"
	"github.com/championswimmer/tephra/tephra-server/go/internal/db"
	"github.com/championswimmer/tephra/tephra-server/go/internal/httpx"
	"github.com/championswimmer/tephra/tephra-server/go/internal/protocol"
	"github.com/championswimmer/tephra/tephra-server/go/internal/testutil"
	vm "github.com/championswimmer/tephra/tephra-server/go/internal/vaultmodel"
)

func (n *native) do(method, path string, h testutil.Headers, body string) testutil.Response {
	if body == "" {
		return testutil.Do(n.App, method, path, h, nil)
	}
	return testutil.DoJSON(n.App, method, path, h, body)
}

func decode(t *testing.T, r testutil.Response) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(r.Body, &m); err != nil {
		t.Fatalf("decode %q: %v", r.Text(), err)
	}
	return m
}

func sub(m map[string]any, keys ...string) map[string]any {
	for _, k := range keys {
		m, _ = m[k].(map[string]any)
	}
	return m
}

func expectStatus(t *testing.T, r testutil.Response, status int) {
	t.Helper()
	if r.Status != status {
		t.Fatalf("status %d want %d: %s", r.Status, status, r.Text())
	}
}

// routeObsidianStub implements only the settings calls the PUT route uses, so
// validation tests stay independent of the native supervisor.
type routeObsidianStub struct {
	httpx.ObsidianSyncService
	settings vm.ObsidianSyncSettings
	updates  []httpx.ObsidianSettingsUpdate
}

func (s *routeObsidianStub) AccountStatus(context.Context, string) (httpx.ObsidianAccount, error) {
	return httpx.ObsidianAccount{}, nil
}

func (s *routeObsidianStub) Status(context.Context, vm.Vault) (vm.ObsidianSyncSettings, error) {
	return s.settings, nil
}

func (s *routeObsidianStub) UpdateSettings(_ context.Context, _ vm.Vault, in httpx.ObsidianSettingsUpdate) error {
	s.updates = append(s.updates, in)
	if in.Enabled != nil {
		s.settings.Enabled = *in.Enabled
		if !*in.Enabled {
			s.settings.Phase = vm.PhaseStopped
		}
	}
	if in.Frequency != nil {
		s.settings.Frequency = *in.Frequency
	}
	return nil
}

// settingsRoute boots a fixture with the stub service and creates an Obsidian
// vault through the public API.
func settingsRoute(t *testing.T, stub *routeObsidianStub) (*testutil.Session, string) {
	t.Helper()
	s := testutil.Setup(t, func(d httpx.Dependencies) http.Handler { return api.NewApp(d) },
		testutil.WithDeps(func(d *httpx.Dependencies) { d.ObsidianSync = stub }))
	r := testutil.DoJSON(s.App, "POST", "/api/v1/vaults", s.BrowserHeaders, `{"name":"Native settings","syncMode":"obsidian"}`)
	expectStatus(t, r, 201)
	id := sub(decode(t, r), "vault")["id"].(string)
	stub.settings = httpx.InitialObsidianSettings(id)
	return s, id
}

func TestOwnerSettingsUpdateAcceptsFrequencyPartials(t *testing.T) {
	stub := &routeObsidianStub{}
	s, id := settingsRoute(t, stub)
	prefix := "/api/v1/vaults/" + id + "/obsidian-sync"
	for _, frequency := range []string{"continuous", "6h", "1h", "30m", "10m"} {
		r := testutil.DoJSON(s.App, "PUT", prefix, s.BrowserHeaders, `{"frequency":"`+frequency+`"}`)
		expectStatus(t, r, 200)
		settings := sub(decode(t, r), "settings")
		if settings["frequency"] != frequency {
			t.Fatalf("frequency response %s", r.Text())
		}
		if settings["enabled"] != false || settings["phase"] != "pending-login" {
			t.Fatalf("frequency-only update changed state %s", r.Text())
		}
	}

	// Legacy enable-only requests still work and leave frequency alone.
	r := testutil.DoJSON(s.App, "PUT", prefix, s.BrowserHeaders, `{"enabled":false}`)
	expectStatus(t, r, 200)
	last := stub.updates[len(stub.updates)-1]
	if last.Enabled == nil || *last.Enabled || last.Frequency != nil {
		t.Fatalf("enable update %+v", last)
	}
	if sub(decode(t, r), "settings")["frequency"] != "10m" {
		t.Fatalf("enable cleared frequency %s", r.Text())
	}

	// Combined updates apply both fields.
	r = testutil.DoJSON(s.App, "PUT", prefix, s.BrowserHeaders, `{"enabled":true,"frequency":"6h"}`)
	expectStatus(t, r, 200)
	last = stub.updates[len(stub.updates)-1]
	if last.Enabled == nil || !*last.Enabled || last.Frequency == nil || *last.Frequency != vm.Frequency6Hours {
		t.Fatalf("combined update %+v", last)
	}
	settings := sub(decode(t, r), "settings")
	if settings["enabled"] != true || settings["frequency"] != "6h" {
		t.Fatalf("combined response %s", r.Text())
	}
}

func TestOwnerSettingsUpdateRejectsInvalidPartialsWithoutMutation(t *testing.T) {
	stub := &routeObsidianStub{}
	s, id := settingsRoute(t, stub)
	prefix := "/api/v1/vaults/" + id + "/obsidian-sync"
	for _, body := range []string{
		`{}`,
		`null`,
		`[]`,
		`{"enabled":null}`,
		`{"frequency":null}`,
		`{"enabled":"yes"}`,
		`{"frequency":2}`,
		`{"frequency":"bogus"}`,
		`{"frequency":""}`,
		`{"unknown":true}`,
		`{"enabled":true,"frequency":"1h","x":1}`,
	} {
		r := testutil.DoJSON(s.App, "PUT", prefix, s.BrowserHeaders, body)
		expectStatus(t, r, 400)
	}
	if len(stub.updates) != 0 {
		t.Fatalf("invalid bodies mutated settings: %+v", stub.updates)
	}
	if stub.settings.Frequency != vm.FrequencyContinuous || stub.settings.Enabled {
		t.Fatalf("invalid bodies mutated state: %+v", stub.settings)
	}
}

func TestOwnerSettingsUpdateValidatesBeforeServiceAvailability(t *testing.T) {
	stub := &routeObsidianStub{}
	s, id := settingsRoute(t, stub)
	prefix := "/api/v1/vaults/" + id + "/obsidian-sync"
	s.Deps.ObsidianSync = nil
	s.App = api.NewApp(s.Deps)
	for _, body := range []string{`{}`, `{"frequency":"bogus"}`, `{"enabled":null}`} {
		expectStatus(t, testutil.DoJSON(s.App, "PUT", prefix, s.BrowserHeaders, body), 400)
	}
	expectStatus(t, testutil.DoJSON(s.App, "PUT", prefix, s.BrowserHeaders, `{"frequency":"10m"}`), 503)
}

func TestAccountSignInIsUserScopedCopiesOnlyAuthAndPreservesLegacyState(t *testing.T) {
	n := nativeFixture(t, nil, nil)
	legacy := ClientStateRoot(n.paths)
	write(t, filepath.Join(legacy, "auth_token"), "legacy-token")
	write(t, filepath.Join(legacy, "sync", "legacy", "config.json"), "legacy-ledger")
	other := n.vault
	other.ID, other.OwnerUserID, other.Name = "other-native", "other-user", "Other native"
	n.ensureUser(t, "other-user")
	n.DB.Vaults().Insert(bg, other)
	n.DB.ObsidianSync().Upsert(bg, httpx.InitialObsidianSettings(other.ID))
	otherPaths := mustVaultPaths(n.root, other.ID)
	write(t, filepath.Join(ClientStateRoot(otherPaths), "auth_token"), "other-token")

	const account = "/api/v1/obsidian-sync/account"
	expectStatus(t, n.do("GET", account, nil, ""), 401)
	expectStatus(t, n.do("GET", account, testutil.Bearer(n.Token), ""), 403)
	got := decode(t, n.do("GET", account, n.BrowserHeaders, ""))
	if !reflect.DeepEqual(got["account"], map[string]any{"authenticated": false, "email": nil, "lastErrorCode": nil}) {
		t.Fatalf("account %v", got)
	}
	if read(t, filepath.Join(legacy, "auth_token")) != "legacy-token" {
		t.Fatal("legacy token changed by a status read")
	}
	noCSRF := testutil.Headers{"cookie": n.BrowserHeaders["cookie"], "content-type": "application/json"}
	expectStatus(t, n.do("POST", account+"/login", noCSRF, "{}"), 403)
	login := n.do("POST", account+"/login", n.BrowserHeaders, `{"email":"account@example.com","password":"unique-password","mfa":"123456"}`)
	expectStatus(t, login, 200)
	if !reflect.DeepEqual(decode(t, login)["account"], map[string]any{"authenticated": true, "email": "account@example.com", "lastErrorCode": nil}) {
		t.Fatalf("login %s", login.Text())
	}
	if regexp.MustCompile(`unique-password|123456|saved-token`).MatchString(login.Text()) {
		t.Fatal("login response echoes secrets")
	}
	if read(t, filepath.Join(legacy, "auth_token")) != "saved-token:account@example.com" {
		t.Fatal("owned vault did not receive the account token")
	}
	if read(t, filepath.Join(legacy, "sync", "legacy", "config.json")) != "legacy-ledger" {
		t.Fatal("legacy Sync state changed")
	}
	if read(t, filepath.Join(ClientStateRoot(otherPaths), "auth_token")) != "other-token" {
		t.Fatal("another user's vault was touched")
	}
	if st, _ := n.svc.AccountStatus(bg, "other-user"); st.Authenticated {
		t.Fatal("other user is authenticated")
	}
	create := n.do("POST", "/api/v1/vaults", n.BrowserHeaders, `{"name":"New headless account vault","syncMode":"obsidian"}`)
	created := sub(decode(t, create), "vault")
	if sub(created, "obsidianSync")["phase"] != "pending-remote" {
		t.Fatalf("created %v", created)
	}
	id := created["id"].(string)
	expectStatus(t, n.do("GET", "/api/v1/vaults/"+id+"/obsidian-sync/remotes", n.BrowserHeaders, ""), 200)
	if read(t, filepath.Join(ClientStateRoot(mustVaultPaths(n.root, id)), "auth_token")) != "saved-token:account@example.com" {
		t.Fatal("new vault did not receive the account token")
	}
	restarted := n.newService(t, nil)
	acct, err := restarted.AccountStatus(bg, n.vault.OwnerUserID)
	if err != nil || !acct.Authenticated || acct.Email != nil || acct.LastErrorCode != nil {
		t.Fatalf("restarted %+v %v", acct, err)
	}
	if err := n.svc.Remove(bg, n.vault); err != nil {
		t.Fatal(err)
	}
	if n.client.count("logout") != 0 {
		t.Fatal("logout called when removing a vault")
	}
	if st, _ := n.svc.AccountStatus(bg, n.vault.OwnerUserID); !st.Authenticated {
		t.Fatal("account lost when a vault was removed")
	}
}

func TestReportsKnownExpiredAccountAndResumesOnReauthentication(t *testing.T) {
	n := nativeFixture(t, nil, nil)
	n.connect(t, "bidirectional")
	n.svc.Enable(bg, n.vault, false)
	n.client.setFailure(NativeFailure(protocol.CodeObsidianAuthExpired))
	n.svc.Enable(bg, n.vault, true)
	eventually(t, "AUTH_EXPIRED", func() bool {
		c := n.status(t).LastErrorCode
		return c != nil && *c == "OBSIDIAN_AUTH_EXPIRED"
	})
	acct, _ := n.svc.AccountStatus(bg, n.vault.OwnerUserID)
	if acct.Authenticated || acct.LastErrorCode == nil || *acct.LastErrorCode != "OBSIDIAN_AUTH_EXPIRED" {
		t.Fatalf("account %+v", acct)
	}
	n.client.setFailure(nil)
	if _, err := n.svc.AccountLogin(bg, n.vault.OwnerUserID, httpx.ObsidianLogin{Email: "new@example.com", Password: "secret"}); err != nil {
		t.Fatal(err)
	}
	eventually(t, "running", func() bool { return n.status(t).Phase == vm.PhaseRunning })
	acct, _ = n.svc.AccountStatus(bg, n.vault.OwnerUserID)
	if !acct.Authenticated || acct.LastErrorCode != nil {
		t.Fatalf("account %+v", acct)
	}
}

func TestRefusesAccountStorageSymlink(t *testing.T) {
	n := nativeFixture(t, nil, nil)
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(n.root, ".accounts")); err != nil {
		t.Fatal(err)
	}
	_, err := n.svc.AccountLogin(bg, n.vault.OwnerUserID, httpx.ObsidianLogin{Email: "x@example.com", Password: "secret"})
	wantCode(t, err, protocol.CodeObsidianSyncFailed)
	if _, err := os.Stat(filepath.Join(outside, n.vault.OwnerUserID)); err == nil {
		t.Fatal("wrote through the symlink")
	}
}

func TestPublicStatusFieldsForHeadlessVaults(t *testing.T) {
	hide := &settingsHidingDB{}
	n := nativeFixture(t, nil, func(d db.Database) db.Database { hide.Database = d; return hide })
	initial := map[string]any{"enabled": false, "phase": "pending-login", "lastErrorCode": nil, "lastSyncedAt": nil}
	create := func(name, mode string) testutil.Response {
		return n.do("POST", "/api/v1/vaults", n.BrowserHeaders, `{"name":"`+name+`","syncMode":"`+mode+`"}`)
	}
	created := create("New headless", "obsidian")
	expectStatus(t, created, 201)
	if !reflect.DeepEqual(sub(decode(t, created), "vault")["obsidianSync"], any(initial)) {
		t.Fatalf("created %s", created.Text())
	}
	if _, has := sub(decode(t, create("Direct", "tephra")), "vault")["obsidianSync"]; has {
		t.Fatal("direct vault exposes obsidianSync")
	}
	remote := "private-remote-id"
	code := "OBSIDIAN_SYNC_FAILED"
	ts := int64(123)
	st := httpx.InitialObsidianSettings(n.vault.ID)
	st.Enabled, st.Phase, st.LastErrorCode, st.LastSyncedAt, st.RemoteVaultID = true, vm.PhaseError, &code, &ts, &remote
	n.DB.ObsidianSync().Upsert(bg, st)
	hidden := n.vault
	hidden.ID, hidden.OwnerUserID, hidden.Name = "other-vault", "other-user", "Private vault"
	n.ensureUser(t, "other-user")
	n.DB.Vaults().Insert(bg, hidden)
	expected := map[string]any{"enabled": true, "phase": "error", "lastErrorCode": "OBSIDIAN_SYNC_FAILED", "lastSyncedAt": float64(123)}
	list := n.do("GET", "/api/v1/vaults", n.BrowserHeaders, "")
	var found map[string]any
	for _, v := range decode(t, list)["vaults"].([]any) {
		if v.(map[string]any)["id"] == n.vault.ID {
			found = v.(map[string]any)
		}
	}
	if !reflect.DeepEqual(found["obsidianSync"], any(expected)) {
		t.Fatalf("list %v", found)
	}
	if regexp.MustCompile(`private-remote-id|Private vault|saved-token`).MatchString(list.Text()) {
		t.Fatal("list leaks private data")
	}
	detail := n.do("GET", "/api/v1/vaults/"+n.vault.ID, n.BrowserHeaders, "")
	if !reflect.DeepEqual(sub(decode(t, detail), "vault")["obsidianSync"], any(expected)) {
		t.Fatalf("detail %s", detail.Text())
	}
	expectStatus(t, n.do("GET", "/api/v1/vaults/other-vault", n.BrowserHeaders, ""), 403)

	withPhase := func(m map[string]any, phase string) map[string]any {
		c := map[string]any{}
		for k, v := range m {
			c[k] = v
		}
		c["phase"] = phase
		return c
	}
	n.Deps.ObsidianSync = nil
	n.rebuild()
	r := n.do("GET", "/api/v1/vaults/"+n.vault.ID, n.BrowserHeaders, "")
	if !reflect.DeepEqual(sub(decode(t, r), "vault")["obsidianSync"], any(withPhase(expected, "unavailable"))) {
		t.Fatalf("unavailable stored %s", r.Text())
	}
	hide.hidden = true
	n.Deps.ObsidianSync = n.svc
	n.rebuild()
	r = n.do("GET", "/api/v1/vaults/"+n.vault.ID, n.BrowserHeaders, "")
	if !reflect.DeepEqual(sub(decode(t, r), "vault")["obsidianSync"], any(initial)) {
		t.Fatalf("fallback %s", r.Text())
	}
	n.Deps.ObsidianSync = nil
	n.rebuild()
	r = n.do("GET", "/api/v1/vaults/"+n.vault.ID, n.BrowserHeaders, "")
	if !reflect.DeepEqual(sub(decode(t, r), "vault")["obsidianSync"], any(withPhase(initial, "unavailable"))) {
		t.Fatalf("unavailable %s", r.Text())
	}
}

func TestDoesNotAllowSwitchingSyncMethods(t *testing.T) {
	n := nativeFixture(t, nil, nil)
	created := n.do("POST", "/api/v1/vaults", n.BrowserHeaders, `{"name":"Direct","syncMode":"tephra"}`)
	direct := sub(decode(t, created), "vault")
	for _, v := range []struct{ id, mode, other string }{
		{direct["id"].(string), "tephra", "obsidian"}, {n.vault.ID, "obsidian", "tephra"},
	} {
		for _, method := range []string{"PUT", "PATCH"} {
			expectStatus(t, n.do(method, "/api/v1/vaults/"+v.id, n.BrowserHeaders, `{"syncMode":"`+v.other+`"}`), 404)
		}
		got, _ := n.DB.Vaults().FindByID(bg, v.id)
		if string(got.SyncMode) != v.mode {
			t.Fatalf("sync mode changed to %s", got.SyncMode)
		}
	}
	r := n.do("POST", "/api/v1/vaults/"+direct["id"].(string)+"/obsidian-sync/setup", n.BrowserHeaders, `{"remoteVaultId":"remote-1","mode":"bidirectional"}`)
	expectStatus(t, r, 409)
	if sub(decode(t, r), "error")["code"] != "VAULT_SYNC_MODE_MISMATCH" {
		t.Fatal(r.Text())
	}
	if row, _ := n.DB.ObsidianSync().Find(bg, direct["id"].(string)); row != nil {
		t.Fatal("headless settings created on a direct vault")
	}
}

func TestOwnerSetupAPIEnforcesSessionCSRFAndNeverEchoesSecrets(t *testing.T) {
	n := nativeFixture(t, nil, nil)
	prefix := "/api/v1/vaults/" + n.vault.ID + "/obsidian-sync"
	expectStatus(t, n.do("GET", prefix, nil, ""), 401)
	expectStatus(t, n.do("GET", prefix, testutil.Bearer(n.Token), ""), 403)
	noCSRF := testutil.Headers{"cookie": n.BrowserHeaders["cookie"], "content-type": "application/json"}
	expectStatus(t, n.do("POST", prefix+"/login", noCSRF, `{"email":"x@example.com","password":"secret"}`), 403)
	login := n.do("POST", prefix+"/login", n.BrowserHeaders, `{"email":"x@example.com","password":"distinct-account-password","mfa":"987654"}`)
	expectStatus(t, login, 200)
	secrets := regexp.MustCompile(`distinct-account-password|987654|saved-token|distinct-encryption-password`)
	if secrets.MatchString(login.Text()) || secrets.MatchString(n.Logs.String()) {
		t.Fatal("secrets echoed or logged")
	}
	expectStatus(t, n.do("GET", prefix+"/remotes", n.BrowserHeaders, ""), 200)
	connected := n.do("POST", prefix+"/setup", n.BrowserHeaders, `{"remoteVaultId":"remote-1","encryptionPassword":"distinct-encryption-password","mode":"pull-only"}`)
	expectStatus(t, connected, 202)
	if secrets.MatchString(connected.Text()) || secrets.MatchString(n.Logs.String()) {
		t.Fatal("secrets echoed or logged")
	}
	eventually(t, "child active", func() bool { return n.client.Active() == 1 })
	vault := sub(decode(t, n.do("GET", "/api/v1/vaults/"+n.vault.ID, n.BrowserHeaders, "")), "vault")
	if vault["syncMode"] != "obsidian" || vault["readOnly"] != true {
		t.Fatalf("vault %v", vault)
	}
	r := n.do("POST", "/api/v1/vaults", n.BrowserHeaders, `{"name":"Native 2","syncMode":"obsidian"}`)
	expectStatus(t, r, 201)
	if sub(decode(t, r), "vault")["syncMode"] != "obsidian" {
		t.Fatal(r.Text())
	}
	// Pause / resume through the PUT route.
	r = n.do("PUT", prefix, n.BrowserHeaders, `{"enabled":false}`)
	expectStatus(t, r, 200)
	if sub(decode(t, r), "settings")["enabled"] != false || sub(decode(t, r), "settings")["phase"] != "stopped" {
		t.Fatal(r.Text())
	}
	// Validation: strict objects, types, ordering of errors.
	for _, body := range []string{`{"enabled":"yes"}`, `{}`, `{"enabled":true,"x":1}`} {
		r = n.do("PUT", prefix, n.BrowserHeaders, body)
		expectStatus(t, r, 400)
	}
	for _, body := range []string{`{"email":"nope","password":"x"}`, `{"email":"a@b.co","password":""}`, `{"email":"a@b.co","password":"x","mfa":"12345"}`, `{"email":"a@b.co","password":"x","extra":1}`} {
		expectStatus(t, n.do("POST", prefix+"/login", n.BrowserHeaders, body), 400)
	}
	for _, body := range []string{`{}`, `{"remoteVaultId":"r","mode":"push"}`, `{"remoteVaultId":""}`} {
		expectStatus(t, n.do("POST", prefix+"/setup", n.BrowserHeaders, body), 400)
	}
}

func TestRoutesAnswer503WhenServiceDisabledAndCapabilityIsReported(t *testing.T) {
	n := nativeFixture(t, nil, nil)
	r := n.do("GET", "/api/v1/obsidian-sync", n.BrowserHeaders, "")
	if !reflect.DeepEqual(decode(t, r), map[string]any{"available": true}) {
		t.Fatal(r.Text())
	}
	n.Deps.ObsidianSync = nil
	n.rebuild()
	r = n.do("GET", "/api/v1/obsidian-sync", n.BrowserHeaders, "")
	if !reflect.DeepEqual(decode(t, r), map[string]any{"available": false}) {
		t.Fatal(r.Text())
	}
	expectStatus(t, n.do("GET", "/api/v1/obsidian-sync", nil, ""), 401)
	r = n.do("GET", "/api/v1/obsidian-sync/account", n.BrowserHeaders, "")
	expectStatus(t, r, 503)
	if sub(decode(t, r), "error")["code"] != "OBSIDIAN_UNAVAILABLE" {
		t.Fatal(r.Text())
	}
	// 503 precedes body validation on login/setup.
	expectStatus(t, n.do("POST", "/api/v1/obsidian-sync/account/login", n.BrowserHeaders, `{}`), 503)
}

func TestRejectsDirectSyncWithTheReasonInEveryState(t *testing.T) {
	for _, state := range []string{"not-connected", "bidirectional", "pull-only", "paused", "error"} {
		t.Run(state, func(t *testing.T) {
			n := nativeFixture(t, nil, nil)
			if state != "not-connected" {
				m := "bidirectional"
				if state == "pull-only" {
					m = "pull-only"
				}
				n.connect(t, m)
				if state == "paused" || state == "error" {
					n.svc.Enable(bg, n.vault, false)
				}
				if state == "error" {
					st := n.status(t)
					code := "OBSIDIAN_SYNC_FAILED"
					st.Phase, st.LastErrorCode = vm.PhaseError, &code
					n.DB.ObsidianSync().Upsert(bg, st)
				}
			}
			headers := testutil.Headers{"authorization": "Bearer " + n.Token, "content-type": "application/json"}
			beforeFiles, beforeRevs := n.files(t), n.revisions(t)
			beforeBlobs := n.Blobs.Count()
			beforeTokens, _ := n.DB.ApiTokens().ListByVault(bg, n.vault.ID)
			manifestHash, _ := protocol.HashManifest(nil)
			bytes := []byte("Direct device upload")
			hash := protocol.SHA256Hex(bytes)
			reason := regexp.MustCompile(`Official Obsidian Sync is enabled.*Direct device sync.*disabled`)
			expect := func(r testutil.Response) {
				t.Helper()
				expectStatus(t, r, 409)
				e := sub(decode(t, r), "error")
				if e["code"] != "VAULT_SYNC_MODE_MISMATCH" || !reason.MatchString(e["message"].(string)) {
					t.Fatalf("body %s", r.Text())
				}
			}
			for _, ref := range []string{n.vault.ID, n.vault.Name} {
				prefix := "/api/v1/vaults/" + url.PathEscape(ref)
				for _, endpoint := range []string{"plan", "commit"} {
					for _, body := range []string{`{"deviceId":"plugin","manifestHash":"` + manifestHash + `","files":[]}`, `{}`} {
						expect(n.do("POST", prefix+"/sync/"+endpoint, headers, body))
					}
				}
				h := testutil.Headers{"authorization": headers["authorization"], "content-type": "application/json", "x-tephra-blob-size": "20"}
				expect(testutil.Do(n.App, "PUT", prefix+"/blobs/"+hash, h, bytes))
				expect(n.do("POST", prefix+"/tokens", n.BrowserHeaders, `{"name":"bad plugin"}`))
			}
			afterTokens, _ := n.DB.ApiTokens().ListByVault(bg, n.vault.ID)
			if !reflect.DeepEqual(n.files(t), beforeFiles) || !reflect.DeepEqual(n.revisions(t), beforeRevs) ||
				n.Blobs.Count() != beforeBlobs || !reflect.DeepEqual(afterTokens, beforeTokens) {
				t.Fatal("rejected direct sync changed state")
			}
		})
	}
}

func TestPluginReadAPIsStayAvailableForVaultNamesAndFileIDsNamedSyncOrBlobs(t *testing.T) {
	for _, name := range []string{"sync", "blobs"} {
		t.Run(name, func(t *testing.T) {
			n := nativeFixture(t, nil, nil)
			n.vault.Name = name
			if err := n.DB.Vaults().Update(bg, n.vault); err != nil {
				t.Fatal(err)
			}
			data := []byte("# Readable\n")
			hash := protocol.SHA256Hex(data)
			if err := n.Blobs.Put(bg, blobstore.PutInput{Hash: hash, Body: bytes.NewReader(data), Size: int64(len(data))}); err != nil {
				t.Fatal(err)
			}
			mime := "text/markdown"
			n.DB.Blobs().Insert(bg, vm.BlobMetadata{Hash: hash, Size: int64(len(data)), MimeType: &mime, CreatedAt: 1})
			if err := n.DB.VaultFiles().Upsert(bg, vm.CurrentVaultFile{VaultID: n.vault.ID, FileID: name, Path: "Readable.md",
				BlobHash: hash, Size: int64(len(data)), Mtime: 1, Kind: vm.KindMarkdown, UpdatedRevision: 0}); err != nil {
				t.Fatal(err)
			}
			prefix := "/api/v1/vaults/" + name
			issued := n.do("POST", prefix+"/tokens", n.BrowserHeaders, `{"name":"reader","scopes":["vault:read-metadata"]}`)
			expectStatus(t, issued, 201)
			body := decode(t, issued)
			readToken, tokenID := body["value"].(string), sub(body, "token")["id"].(string)
			for _, credential := range []string{n.Token, readToken} {
				h := testutil.Bearer(credential)
				for _, suffix := range []string{"", "/files", "/tree", "/resolve?path=Readable.md", "/search?q=Readable",
					"/changes?sinceRevision=0", "/links", "/files/" + name, "/files/" + name + "/links", "/files/" + name + "/backlinks"} {
					if r := n.do("GET", prefix+suffix, h, ""); r.Status != 200 {
						t.Fatalf("%s: status %d %s", suffix, r.Status, r.Text())
					}
				}
				for _, suffix := range []string{"/files/" + name + "/content", "/files/" + name + "/raw", "/attachments/" + name} {
					r := n.do("GET", prefix+suffix, h, "")
					if r.Status != 200 || r.Text() != "# Readable\n" {
						t.Fatalf("%s: status %d %q", suffix, r.Status, r.Text())
					}
				}
			}
			expectStatus(t, n.do("GET", prefix+"/tokens", n.BrowserHeaders, ""), 200)
			expectStatus(t, n.do("DELETE", prefix+"/tokens/"+tokenID, n.BrowserHeaders, ""), 204)
		})
	}
}

func TestMCPToolsAndScopedContentEditsWorkThroughOfficialSync(t *testing.T) {
	n := nativeFixture(t, nil, nil)
	n.vault.Name = "sync"
	if err := n.DB.Vaults().Update(bg, n.vault); err != nil {
		t.Fatal(err)
	}
	n.connect(t, "bidirectional")
	const prefix = "/api/v1/vaults/sync"
	issued := n.do("POST", prefix+"/tokens", n.BrowserHeaders, `{"name":"agent","scopes":["vault:read-metadata","vault:write"]}`)
	expectStatus(t, issued, 201)
	token := decode(t, issued)["value"].(string)
	headers := testutil.Headers{"authorization": "Bearer " + token, "content-type": "application/json"}
	call := func(name string, args map[string]any) map[string]any {
		t.Helper()
		body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": map[string]any{"name": name, "arguments": args}})
		r := n.do("POST", "/mcp", headers, string(body))
		expectStatus(t, r, 200)
		res := decode(t, r)
		if res["error"] != nil || sub(res, "result")["isError"] != nil {
			t.Fatalf("%s failed: %s", name, r.Text())
		}
		return sub(res, "result", "structuredContent")
	}
	// Each write restarts the child; the next write needs sync running again.
	running := func() { eventually(t, "child active", func() bool { return n.client.Active() == 1 }) }
	vaults, _ := call("list_vaults", nil)["vaults"].([]any)
	listed := false
	for _, v := range vaults {
		listed = listed || v.(map[string]any)["id"] == n.vault.ID
	}
	if !listed {
		t.Fatal("list_vaults omitted the vault")
	}
	if !strings.Contains(call("read_note", map[string]any{"path": "Note.md"})["content"].(string), "# Original") {
		t.Fatal("read_note")
	}
	if call("create_note", map[string]any{"path": "Agent.md", "content": "# Agent\n"})["status"] != "committed" {
		t.Fatal("create_note")
	}
	running()
	read := call("read_note", map[string]any{"path": "Agent.md"})
	if call("update_note", map[string]any{"path": "Agent.md", "baseHash": read["blobHash"], "content": "# Updated by MCP\n"})["status"] != "committed" {
		t.Fatal("update_note")
	}
	if got, _ := call("search_notes", map[string]any{"query": "Agent"})["results"].([]any); len(got) != 1 {
		t.Fatalf("search results %v", got)
	}
	if read := func() string { b, _ := os.ReadFile(filepath.Join(n.paths.Vault, "Agent.md")); return string(b) }(); read != "# Updated by MCP\n" {
		t.Fatalf("checkout %q", read)
	}
	eventually(t, "running", func() bool { return n.status(t).Phase == vm.PhaseRunning })
	running()
	file, _ := n.DB.VaultFiles().FindByPath(bg, n.vault.ID, "Agent.md")
	content := "# Updated by API\n"
	saved := n.do("PUT", prefix+"/files/"+file.FileID+"/content", testutil.Headers{
		"authorization": headers["authorization"], "content-type": "application/json", "if-match": file.BlobHash,
		"x-tephra-content-size": "17",
	}, content)
	expectStatus(t, saved, 200)
	got := decode(t, saved)
	if got["status"] != "committed" || got["revision"] != float64(4) {
		t.Fatalf("saved %s", saved.Text())
	}
	if b, _ := os.ReadFile(filepath.Join(n.paths.Vault, "Agent.md")); string(b) != content {
		t.Fatalf("checkout %q", b)
	}
	running()
}
