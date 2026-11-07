// Package core holds the clock, ID generation and password-hasher contracts
// shared by every other package. It mirrors tephra-server/packages/core.
package core

import (
	"crypto/rand"
	"fmt"
	"sync"
	"time"
)

// Clock returns the current time as Unix epoch milliseconds (JS Date.now()).
type Clock interface {
	Now() int64
}

// IdGenerator produces unique identifiers.
type IdGenerator interface {
	Generate() string
}

// PasswordHasher hashes and verifies passwords (implemented by internal/auth).
type PasswordHasher interface {
	Hash(password string) (string, error)
	Verify(password, passwordHash string) (bool, error)
}

// SystemClock reads the wall clock.
type SystemClock struct{}

// Now returns Unix milliseconds.
func (SystemClock) Now() int64 { return time.Now().UnixMilli() }

// FakeClock is a controllable Clock for tests. Safe for concurrent use.
type FakeClock struct {
	mu  sync.Mutex
	now int64
}

// NewFakeClock returns a FakeClock starting at the given epoch milliseconds.
func NewFakeClock(now int64) *FakeClock { return &FakeClock{now: now} }

// Now returns the current fake time.
func (c *FakeClock) Now() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

// Set sets the fake time.
func (c *FakeClock) Set(now int64) {
	c.mu.Lock()
	c.now = now
	c.mu.Unlock()
}

// Advance moves the fake time forward by ms milliseconds.
func (c *FakeClock) Advance(ms int64) {
	c.mu.Lock()
	c.now += ms
	c.mu.Unlock()
}

// maxTimestamp is the largest 48-bit value.
const maxTimestamp = 0xffffffffffff

// UuidV7Generator generates UUIDv7 strings (lowercase, hyphenated) whose
// 48-bit timestamp prefix makes IDs sortable by creation time. The layout is
// byte-identical in structure to the TS generator.
type UuidV7Generator struct {
	clock Clock
}

// NewUuidV7Generator returns a generator; a nil clock means SystemClock.
func NewUuidV7Generator(clock Clock) *UuidV7Generator {
	if clock == nil {
		clock = SystemClock{}
	}
	return &UuidV7Generator{clock: clock}
}

// Generate returns a new UUIDv7. It panics if the clock is outside the 48-bit
// range (the TS version throws RangeError) or the system RNG fails.
func (g *UuidV7Generator) Generate() string {
	ts := g.clock.Now()
	if ts < 0 || ts > maxTimestamp {
		panic("core: clock returned a timestamp outside the UUIDv7 48-bit range")
	}
	var b [16]byte
	for i := 5; i >= 0; i-- {
		b[i] = byte(ts % 256)
		ts /= 256
	}
	var random [10]byte
	if _, err := rand.Read(random[:]); err != nil {
		panic(fmt.Sprintf("core: random source failed: %v", err))
	}
	b[6] = 0x70 | (random[0] & 0x0f)
	b[7] = random[1]
	b[8] = 0x80 | (random[2] & 0x3f)
	copy(b[9:], random[3:])
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}
