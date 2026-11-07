//go:build windows

package obsidian

import (
	"os"
	"os/exec"
)

const oNoFollow = 0

func ownedByUs(os.FileInfo) bool { return true }

func syncDir(string) error { return nil }

func ownProcessGroup(*exec.Cmd) {}

func terminateGroup(cmd *exec.Cmd) error { return cmd.Process.Kill() }
