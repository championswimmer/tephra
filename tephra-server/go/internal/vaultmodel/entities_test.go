package vaultmodel

import "testing"

func TestObsidianSyncFrequency(t *testing.T) {
	valid := []ObsidianSyncFrequency{FrequencyContinuous, Frequency6Hours, Frequency1Hour, Frequency30Minutes, Frequency10Minutes}
	for _, f := range valid {
		if !f.Valid() {
			t.Fatalf("%q should be valid", f)
		}
		if got := (ObsidianSyncSettings{Frequency: f}).EffectiveFrequency(); got != f {
			t.Fatalf("EffectiveFrequency(%q) = %q", f, got)
		}
	}
	for _, f := range []ObsidianSyncFrequency{"", "2h", "15m", "daily"} {
		if f.Valid() {
			t.Fatalf("%q should be invalid", f)
		}
		if got := (ObsidianSyncSettings{Frequency: f}).EffectiveFrequency(); got != FrequencyContinuous {
			t.Fatalf("EffectiveFrequency(%q) = %q, want continuous", f, got)
		}
	}
}
