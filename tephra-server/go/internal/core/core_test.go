package core

import (
	"regexp"
	"sync"
	"testing"
)

var uuidV7 = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$`)

func TestUuidV7Format(t *testing.T) {
	id := NewUuidV7Generator(NewFakeClock(1_788_640_000_000)).Generate()
	if !uuidV7.MatchString(id) {
		t.Fatalf("not a v7 uuid: %s", id)
	}
}

func TestUuidV7TimestampPrefix(t *testing.T) {
	// 1_788_640_000_000 = 0x019_...; verify the 48-bit prefix decodes back.
	id := NewUuidV7Generator(NewFakeClock(0x0123456789ab)).Generate()
	if id[:13] != "01234567-89ab" {
		t.Fatalf("unexpected prefix %s", id)
	}
}

func TestUuidV7Sorts(t *testing.T) {
	earlier := NewUuidV7Generator(NewFakeClock(1)).Generate()
	later := NewUuidV7Generator(NewFakeClock(2)).Generate()
	if !(earlier < later) {
		t.Fatalf("%s !< %s", earlier, later)
	}
}

func TestUuidV7OutOfRangePanics(t *testing.T) {
	for _, ts := range []int64{-1, maxTimestamp + 1} {
		func() {
			defer func() {
				if recover() == nil {
					t.Fatalf("expected panic for %d", ts)
				}
			}()
			NewUuidV7Generator(NewFakeClock(ts)).Generate()
		}()
	}
	NewUuidV7Generator(NewFakeClock(maxTimestamp)).Generate()
}

func TestUuidV7Unique(t *testing.T) {
	g := NewUuidV7Generator(nil)
	seen := map[string]bool{}
	for i := 0; i < 1000; i++ {
		id := g.Generate()
		if seen[id] {
			t.Fatal("duplicate id")
		}
		seen[id] = true
	}
}

func TestFakeClock(t *testing.T) {
	c := NewFakeClock(10)
	c.Advance(5)
	if c.Now() != 15 {
		t.Fatal(c.Now())
	}
	c.Set(1)
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); c.Advance(1); _ = c.Now() }()
	}
	wg.Wait()
	if c.Now() != 11 {
		t.Fatal(c.Now())
	}
	if SystemClock.Now(SystemClock{}) < 1_700_000_000_000 {
		t.Fatal("system clock implausible")
	}
}
