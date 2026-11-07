package indexer

import (
	"encoding/json"
	"testing"

	vm "github.com/championswimmer/tephra/tephra-server/go/internal/vaultmodel"
)

func TestSearchResultKeyOrderMatchesNode(t *testing.T) {
	mt := "text/markdown"
	b, err := json.Marshal(SearchResult{CurrentVaultFile: vm.CurrentVaultFile{FileID: "f", VaultID: "v", Path: "p", BlobHash: "h", Kind: vm.KindMarkdown, MimeType: &mt}})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"fileId":"f","vaultId":"v","path":"p","blobHash":"h","size":0,"mtime":0,"kind":"markdown","updatedRevision":0,"mimeType":"text/markdown","title":null}`
	if string(b) != want {
		t.Fatalf("got %s", b)
	}
}
