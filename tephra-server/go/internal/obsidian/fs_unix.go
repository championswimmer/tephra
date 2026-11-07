//go:build !windows

package obsidian

import (
	"os"
	"os/exec"
	"syscall"
	"time"
)

const oNoFollow = syscall.O_NOFOLLOW

// ownedByUs reports whether the file is owned by the effective user.
func ownedByUs(info os.FileInfo) bool {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return true
	}
	return int(st.Uid) == os.Getuid()
}

// syncDir fsyncs a directory so a rename into it is durable.
func syncDir(path string) error {
	d, err := os.Open(path)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

// ownProcessGroup puts the child in its own process group so cancellation can
// also reach its descendants (npm spawns helpers).
func ownProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// terminateGroup sends SIGTERM to the child's group and SIGKILL 2s later.
func terminateGroup(cmd *exec.Cmd) error {
	pid := cmd.Process.Pid
	if err := syscall.Kill(-pid, syscall.SIGTERM); err != nil {
		return cmd.Process.Signal(syscall.SIGTERM)
	}
	time.AfterFunc(2*time.Second, func() { _ = syscall.Kill(-pid, syscall.SIGKILL) })
	return nil
}
