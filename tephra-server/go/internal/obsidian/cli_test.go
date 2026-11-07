package obsidian

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/championswimmer/tephra/tephra-server/go/internal/httpx"
	"github.com/championswimmer/tephra/tephra-server/go/internal/protocol"
)

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func read(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func mode(t *testing.T, path string) os.FileMode {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info.Mode().Perm()
}

type fakeInstaller struct{ cli string }

func (f fakeInstaller) Ensure(context.Context) (string, error) { return f.cli, nil }
func (f fakeInstaller) Available(context.Context) bool         { return true }
func (f fakeInstaller) Close()                                 {}

func TestCopyAuthCopiesOnlyPrivateAuthenticationStateAndRejectsSymlinks(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	source, destination := mustVaultPaths(root, "source"), mustVaultPaths(root, "destination")
	write(t, filepath.Join(ClientStateRoot(source), "auth_token"), "source-token")
	write(t, filepath.Join(ClientStateRoot(source), "sync", "remote", "config.json"), "source-key")
	write(t, filepath.Join(ClientStateRoot(destination), "sync", "remote", "config.json"), "destination-key")
	client := NewHeadlessClient(NewRuntimeInstaller(root, nil), nil)
	if err := client.CopyAuth(bg, source, destination); err != nil {
		t.Fatal(err)
	}
	if got := read(t, filepath.Join(ClientStateRoot(destination), "auth_token")); got != "source-token" {
		t.Fatalf("token %q", got)
	}
	if got := read(t, filepath.Join(ClientStateRoot(destination), "sync", "remote", "config.json")); got != "destination-key" {
		t.Fatalf("config %q", got)
	}
	if m := mode(t, filepath.Join(ClientStateRoot(destination), "auth_token")); m != 0o600 {
		t.Fatalf("token mode %o", m)
	}
	for _, p := range []string{destination.Root, destination.Config, ClientStateRoot(destination)} {
		if m := mode(t, p); m != 0o700 {
			t.Fatalf("%s mode %o", p, m)
		}
	}
	srcToken := filepath.Join(ClientStateRoot(source), "auth_token")
	os.Remove(srcToken)
	if err := os.Symlink(filepath.Join(ClientStateRoot(destination), "auth_token"), srcToken); err != nil {
		t.Fatal(err)
	}
	wantCode(t, client.CopyAuth(bg, source, destination), protocol.CodeObsidianAuthExpired)
	os.Remove(srcToken)
	write(t, srcToken, "new-token")
	malicious := mustVaultPaths(root, "malicious")
	if err := os.Symlink(outside, malicious.Root); err != nil {
		t.Fatal(err)
	}
	wantCode(t, client.CopyAuth(bg, source, malicious), protocol.CodeObsidianSetupFailed)
	if _, err := os.Stat(filepath.Join(outside, "config")); err == nil {
		t.Fatal("wrote through a symlinked destination")
	}
}

func installerRun(t *testing.T, calls *atomic.Int32) ProcessRunner {
	return func(_ context.Context, in ProcessInput) (ProcessOutput, error) {
		calls.Add(1)
		args := strings.Join(in.Args, " ")
		if !strings.Contains(args, "obsidian-headless@"+HeadlessVersion) || !strings.Contains(args, "--registry=https://registry.npmjs.org") {
			t.Errorf("unpinned install: %v", in.Args)
		}
		prefix := ""
		for i, a := range in.Args {
			if a == "--prefix" {
				prefix = in.Args[i+1]
			}
		}
		dir := filepath.Join(prefix, "node_modules/obsidian-headless")
		write(t, filepath.Join(dir, "package.json"), `{"name":"obsidian-headless","version":"`+HeadlessVersion+`"}`)
		write(t, filepath.Join(dir, "cli.js"), "")
		return ProcessOutput{}, nil
	}
}

func TestInstallerCoalescesPinsAndReinstallsLostExecutable(t *testing.T) {
	cache := t.TempDir()
	var calls atomic.Int32
	inst := NewRuntimeInstaller(cache, installerRun(t, &calls))
	inst.Npm = "npm"
	var wg sync.WaitGroup
	paths := make([]string, 2)
	for i := range paths {
		wg.Add(1)
		go func() {
			defer wg.Done()
			p, err := inst.Ensure(bg)
			if err != nil {
				t.Error(err)
			}
			paths[i] = p
		}()
	}
	wg.Wait()
	if calls.Load() != 1 || paths[0] != paths[1] {
		t.Fatalf("calls %d paths %v", calls.Load(), paths)
	}
	cli, err := inst.Ensure(bg)
	if err != nil || cli != paths[0] || calls.Load() != 1 {
		t.Fatalf("second ensure: %v %q calls=%d", err, cli, calls.Load())
	}
	os.Remove(cli)
	if _, err := inst.Ensure(bg); err != nil || calls.Load() != 2 {
		t.Fatalf("reinstall: %v calls=%d", err, calls.Load())
	}
}

func TestInstallerRefusesSymlinkedCache(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "target")
	os.Mkdir(target, 0o755)
	os.Symlink(target, filepath.Join(root, "cache"))
	var calls atomic.Int32
	inst := NewRuntimeInstaller(filepath.Join(root, "cache"), installerRun(t, &calls))
	inst.Npm = "npm"
	_, err := inst.Ensure(bg)
	wantCode(t, err, protocol.CodeObsidianUnavailable)
	if calls.Load() != 0 {
		t.Fatal("ran the installer in a symlinked cache")
	}
}

func TestInstallerNeverRetainsFailedStateOrExposesOutput(t *testing.T) {
	cache := t.TempDir()
	var calls atomic.Int32
	inst := NewRuntimeInstaller(cache, func(context.Context, ProcessInput) (ProcessOutput, error) {
		calls.Add(1)
		return ProcessOutput{Code: 1, Stdout: "private-data", Stderr: "secret-password"}, nil
	})
	inst.Npm = "npm"
	_, err := inst.Ensure(bg)
	wantCode(t, err, protocol.CodeObsidianUnavailable)
	if _, serr := os.Stat(inst.Prefix); serr == nil {
		t.Fatal("failed install state retained")
	}
	if entries, _ := os.ReadDir(filepath.Dir(inst.Prefix)); len(entries) != 0 {
		t.Fatalf("staging left behind: %v", entries)
	}
	_, err = inst.Ensure(bg)
	if strings.Contains(err.Error(), "secret-password") || calls.Load() != 2 {
		t.Fatalf("err %v calls %d", err, calls.Load())
	}
}

func TestClientSendsSecretsOnStdinIsolatesEnvironmentAndClassifiesMFA(t *testing.T) {
	root := t.TempDir()
	paths := mustVaultPaths(root, "vault-1")
	t.Setenv("TEPHRA_SESSION_SECRET", "server-secret")
	t.Setenv("OBSIDIAN_AUTH_TOKEN", "other-user-token")
	t.Setenv("NODE_OPTIONS", "--inspect")
	var calls []ProcessInput
	output := ProcessOutput{}
	client := NewHeadlessClient(fakeInstaller{"/tmp/official/cli.js"}, func(_ context.Context, in ProcessInput) (ProcessOutput, error) {
		calls = append(calls, in)
		return output, nil
	})
	client.Node = "/fake/node"
	if err := client.Login(bg, paths, httpx.ObsidianLogin{Email: "user@example.com", Password: "private-password"}); err != nil {
		t.Fatal(err)
	}
	var stdin map[string]string
	if err := json.Unmarshal([]byte(calls[0].Stdin), &stdin); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(stdin, map[string]string{"email": "user@example.com", "password": "private-password", "mfa": "000000"}) {
		t.Fatalf("stdin %v", stdin)
	}
	if calls[0].Stdin != `{"email":"user@example.com","password":"private-password","mfa":"000000"}` {
		t.Fatalf("secret flag order changed: %s", calls[0].Stdin)
	}
	joined := strings.Join(calls[0].Args, "\x00")
	for _, s := range []string{"private-password", "000000", "user@example.com"} {
		if strings.Contains(strings.ReplaceAll(joined, secretLauncher, ""), s) {
			t.Fatalf("argv leaks %q", s)
		}
	}
	if !reflect.DeepEqual(calls[0].Env, ClientEnvironment(paths.Config)) {
		t.Fatalf("env %v", calls[0].Env)
	}
	for _, k := range []string{"TEPHRA_SESSION_SECRET", "OBSIDIAN_AUTH_TOKEN", "NODE_OPTIONS"} {
		if _, ok := calls[0].Env[k]; ok {
			t.Fatalf("env leaks %s", k)
		}
	}
	output = ProcessOutput{Stdout: `{"vaults":[{"id":"a","name":"A"}],"shared":[{"id":"b","name":"B","region":"eu"}]}`}
	remotes, err := client.Remotes(bg, paths)
	if err != nil || len(remotes) != 2 || remotes[0].ID != "a" || remotes[1].ID != "b" || remotes[1].Region != "eu" {
		t.Fatalf("remotes %v %v", remotes, err)
	}
	output = ProcessOutput{Code: 2, Stderr: "2FA code is incorrect: private-password"}
	err = client.Login(bg, paths, httpx.ObsidianLogin{Email: "user@example.com", Password: "private-password"})
	wantCode(t, err, protocol.CodeObsidianMFARequired)
	if strings.Contains(err.Error(), "private-password") {
		t.Fatal("error leaks subprocess output")
	}
	output = ProcessOutput{}
	if err := client.Setup(bg, paths, httpx.ObsidianSetup{RemoteVaultID: "a", EncryptionPassword: "vault-password", Mode: "pull-only"}); err != nil {
		t.Fatal(err)
	}
	find := func(sub string) ProcessInput {
		for _, c := range calls {
			for _, a := range c.Args {
				if a == sub {
					return c
				}
			}
		}
		t.Fatalf("no %s call", sub)
		return ProcessInput{}
	}
	setup := find("sync-setup")
	if setup.Stdin != `{"password":"vault-password"}` {
		t.Fatalf("setup stdin %s", setup.Stdin)
	}
	for _, a := range setup.Args {
		if a == "vault-password" {
			t.Fatal("password on argv")
		}
	}
	configure := find("sync-config")
	args := configure.Args
	idx := func(s string) int {
		for i, a := range args {
			if a == s {
				return i
			}
		}
		return -1
	}
	if idx("pull-only") < 0 || args[idx("--configs")+1] != "" || strings.Contains(strings.Join(args, " "), "community-plugin") {
		t.Fatalf("config args %v", args)
	}
}

func TestLauncherKeepsSecretsOutOfTheCommandLineAndPreservesWhitespace(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("reads /proc")
	}
	node := nodeBinary(t)
	root := t.TempDir()
	cli := filepath.Join(root, "fake-official.cjs")
	capture := filepath.Join(root, "capture.json")
	cq, _ := json.Marshal(capture)
	write(t, cli, `const fs = require('node:fs'); fs.writeFileSync(`+string(cq)+`, JSON.stringify({ argv: process.argv, execArgv: process.execArgv, osCommand: fs.readFileSync('/proc/self/cmdline', 'utf8') }));`)
	client := NewHeadlessClient(fakeInstaller{cli}, nil)
	client.Node = node
	if err := client.Login(bg, mustVaultPaths(root, "vault-1"), httpx.ObsidianLogin{Email: "user@example.com", Password: " password with spaces  ", MFA: "123456"}); err != nil {
		t.Fatal(err)
	}
	var res struct {
		Argv, ExecArgv []string
		OsCommand      string
	}
	if err := json.Unmarshal([]byte(read(t, capture)), &res); err != nil {
		t.Fatal(err)
	}
	// Commander auto-detects eval mode from execArgv and would treat argv[1] as the command.
	for _, a := range res.ExecArgv {
		if a == "--eval" || a == "-e" {
			t.Fatalf("execArgv %v", res.ExecArgv)
		}
	}
	if res.Argv[1] != cli || res.Argv[2] != "login" {
		t.Fatalf("argv %v", res.Argv)
	}
	has := func(s string) bool {
		for _, a := range res.Argv {
			if a == s {
				return true
			}
		}
		return false
	}
	if !has(" password with spaces  ") || !has("123456") {
		t.Fatalf("argv %v", res.Argv)
	}
	for _, s := range []string{"password with spaces", "user@example.com", "123456"} {
		if strings.Contains(res.OsCommand, s) {
			t.Fatalf("OS command line leaks %q", s)
		}
	}
}

func TestRunProcessReapsCancelledChildrenAndBoundsOutput(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("needs /bin/sh")
	}
	root := t.TempDir()
	env := ClientEnvironment(root)
	ctx, cancel := context.WithCancel(bg)
	done := make(chan error, 1)
	go func() {
		_, err := RunProcess(ctx, ProcessInput{Command: "/bin/sh", Args: []string{"-c", "sleep 30"}, Cwd: root, Env: env})
		done <- err
	}()
	time.Sleep(50 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		wantCode(t, err, protocol.CodeObsidianSyncFailed)
	case <-time.After(10 * time.Second):
		t.Fatal("cancelled child was not reaped")
	}
	_, err := RunProcess(bg, ProcessInput{Command: "/bin/sh", Args: []string{"-c", "head -c 300000 /dev/zero | tr '\\0' x"}, Cwd: root, Env: env})
	wantCode(t, err, protocol.CodeObsidianSyncFailed)
	// Normal output is returned; the environment is exactly what was passed.
	out, err := RunProcess(bg, ProcessInput{Command: "/bin/sh", Args: []string{"-c", "env; echo oops >&2; exit 3"}, Cwd: root, Env: env})
	if err != nil || out.Code != 3 || !strings.Contains(out.Stderr, "oops") || strings.Contains(out.Stdout, "TEPHRA_") || !strings.Contains(out.Stdout, "XDG_CONFIG_HOME="+root) {
		t.Fatalf("out %+v err %v", out, err)
	}
	// A missing executable is reported as unavailable, without the path.
	_, err = RunProcess(bg, ProcessInput{Command: "/nonexistent/node", Cwd: root, Env: env})
	wantCode(t, err, protocol.CodeObsidianUnavailable)
	if strings.Contains(err.Error(), "nonexistent") {
		t.Fatal("start error leaks the command path")
	}
	// Continuous mode discards stdout instead of failing on volume.
	out, err = RunProcess(bg, ProcessInput{Command: "/bin/sh", Args: []string{"-c", "head -c 300000 /dev/zero | tr '\\0' x"}, Cwd: root, Env: env, Continuous: true})
	if err != nil || out.Code != 0 || out.Stdout != "" {
		t.Fatalf("continuous: %+v %v", out, err)
	}
}

func TestLoginSetsExplicitLanguageWhilePreservingOfficialRequest(t *testing.T) {
	node := nodeBinary(t)
	root := t.TempDir()
	cli, preload, capture := filepath.Join(root, "fake-official.cjs"), filepath.Join(root, "fetch-stub.cjs"), filepath.Join(root, "requests.json")
	cq, _ := json.Marshal(capture)
	write(t, preload, `
const fs = require('node:fs');
const requests = [];
globalThis.fetch = async (input, init) => {
  const headers = Object.fromEntries(new Headers(init.headers));
  requests.push({ input, ...init, headers });
  fs.writeFileSync(`+string(cq)+`, JSON.stringify(requests));
  return new Response(null, { status: headers['accept-language'] ? 200 : 504 });
};`)
	write(t, cli, `
async function main() {
  for (const language of [undefined, 'fr-FR']) {
    const response = await fetch('https://api.obsidian.md/user/signin', {
      method: 'POST',
      headers: { Origin: 'https://obsidian.md', 'Content-Type': 'application/json', ...(language ? { 'Accept-Language': language } : {}) },
      body: 'original-request-body',
    });
    if (!response.ok) process.exitCode = 2;
  }
}
main().catch(() => { process.exitCode = 2; });`)
	client := NewHeadlessClient(fakeInstaller{cli}, func(ctx context.Context, in ProcessInput) (ProcessOutput, error) {
		in.Args = append([]string{"--require", preload}, in.Args...)
		return RunProcess(ctx, in)
	})
	client.Node = node
	if err := client.Login(bg, mustVaultPaths(root, "vault-1"), httpx.ObsidianLogin{Email: "user@example.com", Password: "test-password"}); err != nil {
		t.Fatal(err)
	}
	var got any
	if err := json.Unmarshal([]byte(read(t, capture)), &got); err != nil {
		t.Fatal(err)
	}
	var want []any
	for _, lang := range []string{"en-US", "fr-FR"} {
		want = append(want, map[string]any{
			"input": "https://api.obsidian.md/user/signin", "method": "POST", "body": "original-request-body",
			"headers": map[string]any{"origin": "https://obsidian.md", "content-type": "application/json", "accept-language": lang},
		})
	}
	if !reflect.DeepEqual(got, any(want)) {
		t.Fatalf("requests %v", got)
	}
}
