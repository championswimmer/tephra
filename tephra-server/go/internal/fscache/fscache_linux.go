//go:build linux

// Package fscache lets bulk readers and writers release the kernel page cache
// for files they have finished with. Container memory metrics count page
// cache, so hashing a whole vault otherwise leaves the process looking as if
// it holds hundreds of megabytes it does not need.
package fscache

import (
	"os"

	"golang.org/x/sys/unix"
)

// Drop asks the kernel to evict f's cached pages. It is best effort: errors
// are ignored, and dirty pages are only dropped once written back, so callers
// that wrote the file should Sync first.
func Drop(f *os.File) {
	if f == nil {
		return
	}
	_ = unix.Fadvise(int(f.Fd()), 0, 0, unix.FADV_DONTNEED)
}
