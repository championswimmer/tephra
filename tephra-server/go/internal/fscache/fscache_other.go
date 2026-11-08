//go:build !linux

package fscache

import "os"

// Drop is a no-op on platforms without posix_fadvise.
func Drop(*os.File) {}
