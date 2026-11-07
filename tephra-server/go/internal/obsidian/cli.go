package obsidian

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/championswimmer/tephra/tephra-server/go/internal/httpx"
	"github.com/championswimmer/tephra/tephra-server/go/internal/protocol"
)

// HeadlessVersion is the pinned official `obsidian-headless` npm version.
const HeadlessVersion = "0.0.14"

// secretLauncher launches the unmodified official client in its own process.
// Secret flags are constructed in child memory, never in the OS command line
// or environment. Byte-identical to SECRET_LAUNCHER in cli.ts.
const secretLauncher = `
const fs = require('node:fs');
const { createRequire } = require('node:module');
const cli = process.argv[1];
const secrets = JSON.parse(fs.readFileSync(0, 'utf8'));
process.argv = [process.execPath, cli, ...process.argv.slice(2),
  ...Object.entries(secrets).flatMap(([key, value]) => ['--' + key, value])];
// Match normal script invocation for Commander's automatic argument parsing.
// Leaving --eval here makes it treat the CLI path in argv[1] as a command.
process.execArgv = [];
// obsidian-headless 0.0.14 sign-in can receive HTTP 504 with fetch's default
// Accept-Language: *. Keep the official request and supply a real language.
// https://github.com/obsidianmd/obsidian-headless/issues/58
if (process.argv[2] === 'login') {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => {
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has('Accept-Language')) headers.set('Accept-Language', 'en-US');
    return originalFetch(input, { ...init, headers });
  };
}
createRequire(cli)(cli);
`

// randomHex returns 2*n random hex characters.
func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// ---------------------------------------------------------------- paths

// VaultPaths are the private per-vault directories.
type VaultPaths struct {
	Root   string
	Config string
	Vault  string
	Tmp    string
}

var vaultIDRE = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

// NewVaultPaths enforces confinement even for adapter callers.
func NewVaultPaths(root, vaultID string) (VaultPaths, error) {
	if !vaultIDRE.MatchString(vaultID) {
		return VaultPaths{}, NativeFailure(protocol.CodeObsidianSetupFailed)
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return VaultPaths{}, NativeFailure(protocol.CodeObsidianSetupFailed)
	}
	p := filepath.Join(abs, vaultID)
	return VaultPaths{Root: p, Config: filepath.Join(p, "config"), Vault: filepath.Join(p, "vault"), Tmp: filepath.Join(p, "tmp")}, nil
}

// mustVaultPaths is NewVaultPaths for ids that are known valid (tests).
func mustVaultPaths(root, id string) VaultPaths {
	p, err := NewVaultPaths(root, id)
	if err != nil {
		panic(err)
	}
	return p
}

// ClientStateRoot is where the official client keeps its auth and Sync state.
func ClientStateRoot(p VaultPaths) string {
	if runtime.GOOS == "linux" {
		return filepath.Join(p.Config, "obsidian-headless")
	}
	return filepath.Join(p.Config, ".obsidian-headless")
}

func mkdir0700(path string) error {
	if err := os.MkdirAll(path, 0o700); err != nil {
		return err
	}
	return nil
}

// PreparePaths creates the private directories (0700). It never recreates the
// checkout directory: startup must detect lost files.
func PreparePaths(p VaultPaths) error {
	parent := filepath.Dir(p.Root)
	if err := mkdir0700(parent); err != nil {
		return err
	}
	for _, path := range []string{p.Root, p.Config, p.Tmp} {
		if err := mkdir0700(path); err != nil {
			return err
		}
		if err := os.Chmod(path, 0o700); err != nil {
			return err
		}
	}
	return nil
}

// ---------------------------------------------------------------- installer

// Installer provides the path of the installed official CLI entry point.
type Installer interface {
	Ensure(ctx context.Context) (string, error)
	Available(ctx context.Context) bool
	Close()
}

type installCall struct {
	done chan struct{}
	path string
	err  error
}

// RuntimeInstaller installs obsidian-headless@HeadlessVersion into a private,
// disposable cache prefix with `npm install`, coalescing concurrent installs.
type RuntimeInstaller struct {
	// Prefix is <cacheRoot>/obsidian-headless-<version>.
	Prefix string
	// Npm is the npm executable (default: resolved from PATH on first use).
	Npm string
	run ProcessRunner

	ctx    context.Context
	cancel context.CancelFunc
	mu     sync.Mutex
	call   *installCall
}

// NewRuntimeInstaller returns an installer; run == nil uses RunProcess.
func NewRuntimeInstaller(cacheRoot string, run ProcessRunner) *RuntimeInstaller {
	if run == nil {
		run = RunProcess
	}
	abs, err := filepath.Abs(cacheRoot)
	if err != nil {
		abs = cacheRoot
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &RuntimeInstaller{
		Prefix: filepath.Join(abs, "obsidian-headless-"+HeadlessVersion),
		run:    run, ctx: ctx, cancel: cancel,
	}
}

// Close aborts a running install and rejects further ones.
func (r *RuntimeInstaller) Close() { r.cancel() }

func (r *RuntimeInstaller) cliPath(prefix string) string {
	return filepath.Join(prefix, "node_modules", "obsidian-headless", "cli.js")
}

// Available reports whether a valid installation exists (no install is run).
func (r *RuntimeInstaller) Available(context.Context) bool {
	if err := r.secureCacheRoot(); err != nil {
		return false
	}
	return r.valid(r.Prefix)
}

func (r *RuntimeInstaller) secureCacheRoot() error {
	root := filepath.Dir(r.Prefix)
	if err := os.MkdirAll(root, 0o700); err != nil {
		return err
	}
	info, err := os.Lstat(root)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || !ownedByUs(info) {
		return NativeFailure(protocol.CodeObsidianUnavailable)
	}
	return os.Chmod(root, 0o700)
}

// Ensure returns the CLI path, installing it first when missing. Concurrent
// callers share one install; ctx only bounds this caller's wait.
func (r *RuntimeInstaller) Ensure(ctx context.Context) (string, error) {
	if r.ctx.Err() != nil {
		return "", NativeFailure(protocol.CodeObsidianUnavailable)
	}
	r.mu.Lock()
	c := r.call
	if c == nil {
		c = &installCall{done: make(chan struct{})}
		r.call = c
		go func() {
			c.path, c.err = r.install()
			r.mu.Lock()
			r.call = nil
			r.mu.Unlock()
			close(c.done)
		}()
	}
	r.mu.Unlock()
	select {
	case <-c.done:
		return c.path, c.err
	case <-ctx.Done():
		return "", NativeFailure(protocol.CodeObsidianSyncFailed)
	}
}

func (r *RuntimeInstaller) valid(prefix string) bool {
	info, err := os.Lstat(prefix)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return false
	}
	f, err := os.Open(filepath.Join(prefix, "node_modules", "obsidian-headless", "package.json"))
	if err != nil {
		return false
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, 1<<20))
	if err != nil {
		return false
	}
	var manifest struct {
		Name    string `json:"name"`
		Version string `json:"version"`
	}
	if json.Unmarshal(raw, &manifest) != nil || manifest.Name != "obsidian-headless" || manifest.Version != HeadlessVersion {
		return false
	}
	cli, err := os.Lstat(r.cliPath(prefix))
	return err == nil && cli.Mode().IsRegular()
}

func (r *RuntimeInstaller) install() (cli string, err error) {
	cli = r.cliPath(r.Prefix)
	if err := r.secureCacheRoot(); err != nil {
		return "", NativeFailure(protocol.CodeObsidianUnavailable)
	}
	if r.valid(r.Prefix) {
		return cli, nil
	}
	staging := r.Prefix + "-" + randomHex(16) + ".install"
	defer os.RemoveAll(staging)
	fail := func() (string, error) { return "", NativeFailure(protocol.CodeObsidianUnavailable) }
	if err := os.MkdirAll(staging, 0o700); err != nil {
		return fail()
	}
	config := filepath.Join(staging, "home")
	if err := os.Mkdir(config, 0o700); err != nil {
		return fail()
	}
	npm := r.Npm
	if npm == "" {
		name := "npm"
		if runtime.GOOS == "windows" {
			name = "npm.cmd"
		}
		if npm, err = exec.LookPath(name); err != nil {
			return fail()
		}
	}
	env := ClientEnvironment(config)
	env["npm_config_cache"] = filepath.Join(staging, "npm-cache")
	env["npm_config_userconfig"] = filepath.Join(staging, "empty-npmrc")
	env["npm_config_globalconfig"] = filepath.Join(staging, "empty-global-npmrc")
	out, err := r.run(r.ctx, ProcessInput{
		Command: npm,
		Args: []string{"install", "--prefix", staging, "--no-save", "--no-package-lock", "--omit=dev",
			"--no-audit", "--no-fund", "--registry=https://registry.npmjs.org", "obsidian-headless@" + HeadlessVersion},
		Cwd: staging, Env: env, Timeout: 300 * time.Second, Continuous: true,
	})
	if err != nil || out.Code != 0 || !r.valid(staging) {
		return fail()
	}
	if err := os.RemoveAll(r.Prefix); err != nil {
		return fail()
	}
	if err := os.Rename(staging, r.Prefix); err != nil {
		return fail()
	}
	return cli, nil
}

// ---------------------------------------------------------------- client

// OfficialClient abstracts the official `obsidian-headless` CLI (cli.ts
// OfficialClient). Tests substitute a fake; HeadlessClient is the real one.
// Methods must stop promptly when ctx is cancelled.
type OfficialClient interface {
	HasAuth(ctx context.Context, p VaultPaths) (bool, error)
	CopyAuth(ctx context.Context, source, destination VaultPaths) error
	Ensure(ctx context.Context) error
	Login(ctx context.Context, p VaultPaths, in httpx.ObsidianLogin) error
	Remotes(ctx context.Context, p VaultPaths) ([]httpx.ObsidianRemote, error)
	Setup(ctx context.Context, p VaultPaths, in httpx.ObsidianSetup) error
	Configure(ctx context.Context, p VaultPaths, mode string) error
	// Sync runs one sync (continuous=false) or a long-running sync until ctx ends.
	Sync(ctx context.Context, p VaultPaths, continuous bool) error
	Unlink(ctx context.Context, p VaultPaths) error
	Logout(ctx context.Context, p VaultPaths) error
	// Close aborts all running subprocesses and installs.
	Close()
}

// HeadlessClient runs the official CLI as a Node subprocess.
type HeadlessClient struct {
	installer Installer
	run       ProcessRunner
	// Node is the node executable (default: resolved from PATH on first use).
	Node string

	ctx    context.Context
	cancel context.CancelFunc
}

// NewHeadlessClient wires the installer; run == nil uses RunProcess.
func NewHeadlessClient(installer Installer, run ProcessRunner) *HeadlessClient {
	if run == nil {
		run = RunProcess
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &HeadlessClient{installer: installer, run: run, ctx: ctx, cancel: cancel}
}

// Close aborts every running child and the installer.
func (c *HeadlessClient) Close() {
	c.cancel()
	c.installer.Close()
}

// Ensure makes sure the official client is installed.
func (c *HeadlessClient) Ensure(ctx context.Context) error {
	_, err := c.installer.Ensure(ctx)
	return err
}

func (c *HeadlessClient) node() (string, error) {
	if c.Node != "" {
		return c.Node, nil
	}
	p, err := exec.LookPath("node")
	if err != nil {
		return "", NativeFailure(protocol.CodeObsidianUnavailable)
	}
	return p, nil
}

func pathIsPrivateDir(path string) (bool, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return false, err
	}
	return info.IsDir() && info.Mode()&os.ModeSymlink == 0, nil
}

// HasAuth reports whether a private auth_token exists. Symlinks anywhere on
// the path make it false.
func (c *HeadlessClient) HasAuth(_ context.Context, p VaultPaths) (bool, error) {
	for _, path := range []string{filepath.Dir(p.Root), p.Root, p.Config, ClientStateRoot(p)} {
		ok, err := pathIsPrivateDir(path)
		if errors.Is(err, fs.ErrNotExist) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		if !ok {
			return false, nil
		}
	}
	token, err := os.Lstat(filepath.Join(ClientStateRoot(p), "auth_token"))
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return token.Mode().IsRegular() && token.Size() > 0 && token.Size() <= 65536, nil
}

// CopyAuth copies only the private auth token between locations, refusing
// symlinks and fixing modes (dirs 0700, token 0600).
func (c *HeadlessClient) CopyAuth(ctx context.Context, source, destination VaultPaths) error {
	if ok, err := c.HasAuth(ctx, source); err != nil {
		return err
	} else if !ok {
		return NativeFailure(protocol.CodeObsidianAuthExpired)
	}
	parent := filepath.Dir(destination.Root)
	for _, path := range []string{parent, destination.Root, destination.Config, destination.Tmp} {
		if path != parent {
			if err := os.Mkdir(path, 0o700); err != nil && !errors.Is(err, fs.ErrExist) {
				return err
			}
		}
		ok, err := pathIsPrivateDir(path)
		if err != nil {
			return err
		}
		if !ok {
			return NativeFailure(protocol.CodeObsidianSetupFailed)
		}
		if path != parent {
			if err := os.Chmod(path, 0o700); err != nil {
				return err
			}
		}
	}
	stateRoot := ClientStateRoot(destination)
	if err := os.MkdirAll(stateRoot, 0o700); err != nil {
		return err
	}
	if ok, err := pathIsPrivateDir(stateRoot); err != nil {
		return err
	} else if !ok {
		return NativeFailure(protocol.CodeObsidianSetupFailed)
	}
	if err := os.Chmod(stateRoot, 0o700); err != nil {
		return err
	}
	token, err := readSmallRegular(filepath.Join(ClientStateRoot(source), "auth_token"), 65536)
	if err != nil {
		return err
	}
	tmp := filepath.Join(stateRoot, ".auth-"+randomHex(16))
	defer os.Remove(tmp)
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	_, werr := f.Write(token)
	cerr := f.Close()
	if werr != nil {
		return werr
	}
	if cerr != nil {
		return cerr
	}
	if err := os.Chmod(tmp, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(stateRoot, "auth_token"))
}

func readSmallRegular(path string, max int64) ([]byte, error) {
	f, err := os.OpenFile(path, os.O_RDONLY|oNoFollow, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() == 0 || info.Size() > max {
		return nil, NativeFailure(protocol.CodeObsidianAuthExpired)
	}
	return io.ReadAll(io.LimitReader(f, max))
}

type secret struct{ key, value string }

type invokeOptions struct {
	secrets    []secret
	continuous bool
	timeout    time.Duration
}

func marshalSecrets(secrets []secret) string {
	var sb strings.Builder
	sb.WriteByte('{')
	for i, s := range secrets {
		if i > 0 {
			sb.WriteByte(',')
		}
		k, _ := json.Marshal(s.key)
		v, _ := json.Marshal(s.value)
		sb.Write(k)
		sb.WriteByte(':')
		sb.Write(v)
	}
	sb.WriteByte('}')
	return sb.String()
}

func (c *HeadlessClient) invoke(ctx context.Context, p VaultPaths, args []string, o invokeOptions) (ProcessOutput, error) {
	if c.ctx.Err() != nil {
		return ProcessOutput{}, NativeFailure(protocol.CodeObsidianSyncFailed)
	}
	cli, err := c.installer.Ensure(ctx)
	if err != nil {
		return ProcessOutput{}, err
	}
	if err := PreparePaths(p); err != nil {
		return ProcessOutput{}, NativeFailure(protocol.CodeObsidianSyncFailed)
	}
	node, err := c.node()
	if err != nil {
		return ProcessOutput{}, err
	}
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	stop := context.AfterFunc(c.ctx, cancel)
	defer stop()
	in := ProcessInput{
		Command: node, Cwd: p.Root, Env: ClientEnvironment(p.Config),
		Timeout: 60 * time.Second, Continuous: o.continuous,
	}
	if o.timeout != 0 {
		in.Timeout = o.timeout
	}
	if o.secrets != nil {
		in.Args = append([]string{"--eval", secretLauncher, cli}, args...)
		in.Stdin = marshalSecrets(o.secrets)
	} else {
		in.Args = append([]string{cli}, args...)
	}
	return c.run(runCtx, in)
}

var (
	mfaRE  = regexp.MustCompile(`(?i)2FA|MFA|two.factor`)
	authRE = regexp.MustCompile(`(?i)logged in|auth|token`)
)

// Login signs in with the account credentials; secrets go through stdin.
func (c *HeadlessClient) Login(ctx context.Context, p VaultPaths, in httpx.ObsidianLogin) error {
	mfa := in.MFA
	if mfa == "" {
		mfa = "000000"
	}
	out, err := c.invoke(ctx, p, []string{"login"}, invokeOptions{
		secrets: []secret{{"email", in.Email}, {"password", in.Password}, {"mfa", mfa}}})
	if err != nil {
		return err
	}
	if out.Code != 0 {
		if mfaRE.MatchString(out.Stderr) {
			return NativeFailure(protocol.CodeObsidianMFARequired)
		}
		return NativeFailure(protocol.CodeObsidianLoginFailed)
	}
	return nil
}

type remoteJSON struct {
	ID     *string `json:"id"`
	Name   *string `json:"name"`
	Region *string `json:"region"`
}

type remotesJSON struct {
	Vaults *[]remoteJSON `json:"vaults"`
	Shared *[]remoteJSON `json:"shared"`
}

func parseRemotes(stdout string) ([]httpx.ObsidianRemote, error) {
	var v remotesJSON
	if err := json.Unmarshal([]byte(stdout), &v); err != nil || v.Vaults == nil || v.Shared == nil {
		return nil, NativeFailure(protocol.CodeObsidianSyncFailed)
	}
	var order []string
	byID := map[string]httpx.ObsidianRemote{}
	for _, list := range [][]remoteJSON{*v.Vaults, *v.Shared} {
		for _, r := range list {
			if r.ID == nil || r.Name == nil {
				return nil, NativeFailure(protocol.CodeObsidianSyncFailed)
			}
			if n := httpx.UTF16Len(*r.ID); n < 1 || n > 256 || httpx.UTF16Len(*r.Name) > 500 {
				return nil, NativeFailure(protocol.CodeObsidianSyncFailed)
			}
			remote := httpx.ObsidianRemote{ID: *r.ID, Name: *r.Name}
			if r.Region != nil {
				if httpx.UTF16Len(*r.Region) > 100 {
					return nil, NativeFailure(protocol.CodeObsidianSyncFailed)
				}
				remote.Region = *r.Region
			}
			if _, seen := byID[remote.ID]; !seen {
				order = append(order, remote.ID)
			}
			byID[remote.ID] = remote // later entries replace earlier ones (Map.set semantics)
		}
	}
	out := make([]httpx.ObsidianRemote, 0, len(order))
	for _, id := range order {
		out = append(out, byID[id])
	}
	return out, nil
}

// Remotes lists owned and shared remote vaults.
func (c *HeadlessClient) Remotes(ctx context.Context, p VaultPaths) ([]httpx.ObsidianRemote, error) {
	out, err := c.invoke(ctx, p, []string{"sync-list-remote", "--json"}, invokeOptions{})
	if err != nil {
		return nil, err
	}
	if out.Code != 0 {
		if authRE.MatchString(out.Stderr) {
			return nil, NativeFailure(protocol.CodeObsidianAuthExpired)
		}
		return nil, NativeFailure(protocol.CodeObsidianSyncFailed)
	}
	return parseRemotes(out.Stdout)
}

// Setup links the checkout to a remote vault, then applies the sync config.
func (c *HeadlessClient) Setup(ctx context.Context, p VaultPaths, in httpx.ObsidianSetup) error {
	out, err := c.invoke(ctx, p, []string{"sync-setup", "--vault", in.RemoteVaultID, "--path", p.Vault,
		"--device-name", "Tephra", "--json"}, invokeOptions{secrets: []secret{{"password", in.EncryptionPassword}}})
	if err != nil {
		return err
	}
	if out.Code != 0 {
		return NativeFailure(protocol.CodeObsidianSetupFailed)
	}
	return c.Configure(ctx, p, in.Mode)
}

// Configure applies the Sync mode; community plugins/configs are never synced.
func (c *HeadlessClient) Configure(ctx context.Context, p VaultPaths, mode string) error {
	out, err := c.invoke(ctx, p, []string{"sync-config", "--path", p.Vault, "--mode", mode,
		"--conflict-strategy", "merge", "--configs", "", "--file-types", "image,audio,video,pdf,unsupported", "--json"}, invokeOptions{})
	if err != nil {
		return err
	}
	if out.Code != 0 {
		return NativeFailure(protocol.CodeObsidianSetupFailed)
	}
	return nil
}

// Sync runs the official sync; output is discarded (bounded stderr tail only).
func (c *HeadlessClient) Sync(ctx context.Context, p VaultPaths, continuous bool) error {
	args := []string{"sync", "--path", p.Vault}
	timeout := 900 * time.Second
	if continuous {
		args = append(args, "--continuous")
		timeout = 0x7fffffff * time.Millisecond
	}
	out, err := c.invoke(ctx, p, args, invokeOptions{continuous: true, timeout: timeout})
	if err != nil {
		return err
	}
	if out.Code != 0 {
		if authRE.MatchString(out.Stderr) {
			return NativeFailure(protocol.CodeObsidianAuthExpired)
		}
		return NativeFailure(protocol.CodeObsidianSyncFailed)
	}
	return nil
}

// Unlink removes the Sync registration of this checkout (no-op if the client
// was never installed).
func (c *HeadlessClient) Unlink(ctx context.Context, p VaultPaths) error {
	if !c.installer.Available(ctx) {
		return nil
	}
	out, err := c.invoke(ctx, p, []string{"sync-unlink", "--path", p.Vault}, invokeOptions{})
	if err != nil {
		return err
	}
	if out.Code != 0 {
		return NativeFailure(protocol.CodeObsidianSyncFailed)
	}
	return nil
}

// Logout signs the stored account out (no-op if the client was never installed).
func (c *HeadlessClient) Logout(ctx context.Context, p VaultPaths) error {
	if !c.installer.Available(ctx) {
		return nil
	}
	out, err := c.invoke(ctx, p, []string{"logout"}, invokeOptions{})
	if err != nil {
		return err
	}
	if out.Code != 0 {
		return NativeFailure(protocol.CodeObsidianSyncFailed)
	}
	return nil
}
