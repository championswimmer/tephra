package protocol

import "testing"

func TestVersionConstants(t *testing.T) {
	if ProtocolVersion != "2" || MinimumPluginVersion != "0.2.0" ||
		ProtocolVersionHeader != "X-Tephra-Protocol-Version" || PluginVersionHeader != "X-Tephra-Plugin-Version" {
		t.Fatal("version constants changed")
	}
}

func TestSyncResponsesWithAndWithoutVersionFields(t *testing.T) {
	for _, body := range []string{
		`{"status":"up-to-date","latestRevision":3,"missingBlobs":[]}`,
		`{"status":"upload-required","latestRevision":3,"missingBlobs":[],"protocolVersion":"2","minimumPluginVersion":"0.2.0"}`,
	} {
		if _, err := ParseSyncPlanResponse([]byte(body)); err != nil {
			t.Errorf("%s: %v", body, err)
		}
	}
	for _, body := range []string{`{"status":"committed","revision":1}`, `{"status":"up-to-date","revision":1,"protocolVersion":"2","minimumPluginVersion":"0.2.0"}`} {
		if _, err := ParseSyncCommitResponse([]byte(body)); err != nil {
			t.Errorf("%s: %v", body, err)
		}
	}
	if _, err := ParseSyncPlanResponse([]byte(`{"status":"up-to-date","latestRevision":3,"missingBlobs":[],"protocolVersion":""}`)); err == nil {
		t.Error("empty protocolVersion accepted")
	}
	if _, err := ParseSyncPlanResponse([]byte(`{"status":"up-to-date","latestRevision":3}`)); err == nil {
		t.Error("missing missingBlobs accepted")
	}
}

func TestIsSupportedPluginVersion(t *testing.T) {
	cases := map[string]bool{
		"": true, "   ": true, "0.1.0": false, "0.2.0": true, "1.0.0": true, "0.0.9": false,
		"not-a-version": false, "0.2.0-beta.1": true, "0.1.9+build": false, " 0.3.0 ": true,
		"0.2": false, "v0.2.0": false, "0.2.0-a\nb": false, "10.0.0": true, "0.10.0": true, "0.2.1": true,
	}
	for v, want := range cases {
		if got := IsSupportedPluginVersion(v); got != want {
			t.Errorf("%q: got %v want %v", v, got, want)
		}
	}
}
