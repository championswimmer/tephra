package obsidian

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/championswimmer/tephra/tephra-server/go/internal/protocol"
)

// OutputLimit bounds captured subprocess output (256 KiB).
const OutputLimit = 256 * 1024

// ClientEnvironment deliberately excludes application secrets, npm
// credentials, NODE_OPTIONS and auth-token overrides.
func ClientEnvironment(configRoot string) map[string]string {
	path := os.Getenv("PATH")
	if path == "" {
		path = "/usr/local/bin:/usr/bin:/bin"
	}
	return map[string]string{
		"PATH":            path,
		"HOME":            configRoot,
		"XDG_CONFIG_HOME": configRoot,
		"NODE_ENV":        "production",
		"LANG":            "C.UTF-8",
	}
}

// ProcessInput describes one subprocess invocation.
type ProcessInput struct {
	Command string
	Args    []string
	Cwd     string
	Env     map[string]string
	Stdin   string
	// Timeout of 0 means none.
	Timeout time.Duration
	// Continuous discards stdout (only a bounded stderr tail is kept).
	Continuous bool
}

// ProcessOutput is a finished subprocess. Stdout is empty in Continuous mode.
type ProcessOutput struct {
	Code   int
	Stdout string
	Stderr string
}

// ProcessRunner runs a subprocess. Cancelling ctx terminates it.
type ProcessRunner func(ctx context.Context, in ProcessInput) (ProcessOutput, error)

// cappedBuffer collects up to limit bytes; one more byte trips onExceed.
type cappedBuffer struct {
	mu       sync.Mutex
	buf      []byte
	limit    int
	exceeded bool
	onExceed func()
}

func (c *cappedBuffer) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.exceeded {
		return len(p), nil
	}
	if len(c.buf)+len(p) > c.limit {
		c.exceeded = true
		c.buf = nil
		if c.onExceed != nil {
			c.onExceed()
		}
		return len(p), nil
	}
	c.buf = append(c.buf, p...)
	return len(p), nil
}

// tailBuffer keeps the last `limit` bytes written (memory bounded at 2*limit).
type tailBuffer struct {
	mu    sync.Mutex
	buf   []byte
	limit int
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, p...)
	if len(t.buf) > 2*t.limit {
		n := copy(t.buf, t.buf[len(t.buf)-t.limit:])
		t.buf = t.buf[:n]
	}
	return len(p), nil
}

func (t *tailBuffer) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	b := t.buf
	if len(b) > t.limit {
		b = b[len(b)-t.limit:]
	}
	return string(b)
}

func envSlice(env map[string]string) []string {
	out := make([]string, 0, len(env)) // never nil: nil would inherit the server environment
	for k, v := range env {
		out = append(out, k+"="+v)
	}
	sort.Strings(out)
	return out
}

// RunProcess is the real ProcessRunner. Failures never carry subprocess
// output: cancellation, timeout and output overflow map to
// OBSIDIAN_SYNC_FAILED, a failure to start maps to OBSIDIAN_UNAVAILABLE.
func RunProcess(ctx context.Context, in ProcessInput) (ProcessOutput, error) {
	if ctx.Err() != nil {
		return ProcessOutput{}, NativeFailure(protocol.CodeObsidianSyncFailed)
	}
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	if in.Timeout > 0 {
		var c2 context.CancelFunc
		runCtx, c2 = context.WithTimeout(runCtx, in.Timeout)
		defer c2()
	}
	cmd := exec.CommandContext(runCtx, in.Command, in.Args...)
	cmd.Dir = in.Cwd
	cmd.Env = envSlice(in.Env)
	cmd.Stdin = strings.NewReader(in.Stdin)
	ownProcessGroup(cmd)
	cmd.Cancel = func() error { return terminateGroup(cmd) }
	cmd.WaitDelay = 2 * time.Second // SIGKILL after 2s; also unblocks pipes held by grandchildren
	stderr := &tailBuffer{limit: OutputLimit}
	cmd.Stderr = stderr
	var stdout *cappedBuffer
	if !in.Continuous {
		stdout = &cappedBuffer{limit: OutputLimit, onExceed: cancel}
		cmd.Stdout = stdout
	}
	if err := cmd.Start(); err != nil {
		return ProcessOutput{}, NativeFailure(protocol.CodeObsidianUnavailable)
	}
	err := cmd.Wait()
	if cmd.ProcessState == nil && err != nil && !errors.Is(err, exec.ErrWaitDelay) {
		return ProcessOutput{}, NativeFailure(protocol.CodeObsidianUnavailable)
	}
	if runCtx.Err() != nil || (stdout != nil && stdout.exceeded) {
		return ProcessOutput{}, NativeFailure(protocol.CodeObsidianSyncFailed)
	}
	code := 1
	if cmd.ProcessState != nil {
		if c := cmd.ProcessState.ExitCode(); c >= 0 {
			code = c
		}
	}
	out := ProcessOutput{Code: code, Stderr: stderr.String()}
	if stdout != nil {
		out.Stdout = string(stdout.buf)
	}
	return out, nil
}
