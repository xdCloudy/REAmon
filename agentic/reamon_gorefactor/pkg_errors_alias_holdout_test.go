package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"testing"
)

type pkgErrorsAliasHoldout struct {
	Version          int                           `json:"version"`
	ModulePath       string                        `json:"module_path"`
	SourceCommit     string                        `json:"source_commit"`
	ModuleSum        string                        `json:"module_sum"`
	GoModFixturePath string                        `json:"go_mod_fixture_path"`
	GoModSHA256      string                        `json:"go_mod_sha256"`
	LicenseFixture   string                        `json:"license_fixture_path"`
	LicenseSHA256    string                        `json:"license_sha256"`
	Files            []projectInventoryFixtureFile `json:"files"`
	BuildContexts    []projectModuleRenameBuild    `json:"build_contexts"`
	AliasName        string                        `json:"alias_name"`
	SelectedPath     string                        `json:"selected_path"`
	ExpectedRefs     int                           `json:"expected_references"`
}

func TestProjectModuleImportAliasPinnedPkgErrorsV091(t *testing.T) {
	const fixtureRoot = "testdata"
	manifestBytes, err := os.ReadFile(filepath.Join(fixtureRoot, "pkg_errors_import_alias_holdout_v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	var corpus pkgErrorsAliasHoldout
	if err := json.Unmarshal(manifestBytes, &corpus); err != nil {
		t.Fatal(err)
	}
	if corpus.Version != 1 || corpus.ModulePath != "github.com/pkg/errors" ||
		corpus.SourceCommit != "614d223910a179a466c1767a985424175c39b465" ||
		corpus.ModuleSum != "h1:FEBLx1zS214owpjy7qsBeixbURkuhQAwrK5UwLGTwt4=" ||
		corpus.AliasName != "stderrors" || corpus.SelectedPath != "go113.go" || corpus.ExpectedRefs != 3 ||
		len(corpus.BuildContexts) != 3 || len(corpus.Files) != 3 {
		t.Fatalf("pinned pkg/errors alias corpus identity = %+v", corpus)
	}
	readVerified := func(relativePath, expectedHash string) []byte {
		t.Helper()
		contents, err := os.ReadFile(filepath.Join(fixtureRoot, filepath.FromSlash(relativePath)))
		if err != nil {
			t.Fatalf("read pinned pkg/errors fixture %s: %v", relativePath, err)
		}
		if actual := hashText(string(contents)); actual != expectedHash {
			t.Fatalf("pinned pkg/errors fixture hash for %s = %s; want %s", relativePath, actual, expectedHash)
		}
		return contents
	}
	goMod := string(readVerified(corpus.GoModFixturePath, corpus.GoModSHA256))
	readVerified(corpus.LicenseFixture, corpus.LicenseSHA256)
	files := make([]projectFile, 0, len(corpus.Files))
	for _, source := range corpus.Files {
		contents := readVerified(source.FixturePath, source.SHA256)
		files = append(files, projectFile{Path: source.InventoryPath, Source: string(contents), ExpectedHash: source.SHA256})
	}
	aliasCounts := independentExplicitImportAliasReferences(t, files)
	if len(aliasCounts) != 1 || aliasCounts[corpus.SelectedPath+"\x00"+corpus.AliasName] != corpus.ExpectedRefs {
		t.Fatalf("independent pkg/errors alias AST census = %#v; want stderrors with three references", aliasCounts)
	}

	request := goProjectRequest(files, corpus.SelectedPath)
	request.Operation = "project_module_bindings"
	request.ModulePath, request.GoMod, request.GoModHash = corpus.ModulePath, goMod, corpus.GoModSHA256
	bindingsResult, err := listProjectModuleBindings(request)
	if err != nil {
		t.Fatalf("catalog pinned pkg/errors aliases: %v", err)
	}
	var selected binding
	aliasCount := 0
	for _, raw := range bindingsResult["bindings"].([]map[string]any) {
		if raw["kind"] != "file import alias" {
			continue
		}
		aliasCount++
		if raw["name"] == corpus.AliasName && raw["relativePath"] == corpus.SelectedPath {
			selected = binding{ID: raw["id"].(string), Name: raw["name"].(string), Kind: raw["kind"].(string),
				ScopeType: raw["scopeType"].(string), FilePath: raw["relativePath"].(string),
				ReferenceCount: raw["referenceCount"].(int)}
		}
	}
	if aliasCount != 1 || selected.ID == "" || selected.Kind != "file import alias" ||
		selected.ScopeType != "file" || selected.ReferenceCount != corpus.ExpectedRefs {
		t.Fatalf("pinned pkg/errors alias catalog = %+v (aliases=%d); want stderrors with 3 references", selected, aliasCount)
	}

	request.Operation = "project_module_rename"
	request.ExpectedHash = bindingsResult["source_sha256"].(string)
	request.SourceSetHash = bindingsResult["source_set_sha256"].(string)
	request.Renames = []renameSelection{{ID: selected.ID, NewName: "standarderrors"}}
	result, err := applyProjectModuleRenames(request)
	if err != nil {
		t.Fatalf("rename pinned pkg/errors import alias: %v", err)
	}
	outputs := make(map[string]string)
	editCount := 0
	for _, file := range result["files"].([]map[string]any) {
		filePath := file["relative_path"].(string)
		outputs[filePath] = file["source_code"].(string)
		edits := file["edits"].([]map[string]any)
		sort.Slice(edits, func(i, j int) bool { return edits[i]["start"].(int) > edits[j]["start"].(int) })
		var source string
		for _, original := range files {
			if original.Path == filePath {
				source = original.Source
				break
			}
		}
		rebuilt := []byte(source)
		for _, edit := range edits {
			start, end := edit["start"].(int), edit["end"].(int)
			if edit["old_text"] != corpus.AliasName || edit["new_text"] != "standarderrors" ||
				start < 0 || end < start || end > len(rebuilt) || string(rebuilt[start:end]) != corpus.AliasName {
				t.Fatalf("pinned pkg/errors alias byte edit = %#v; source does not match the expected alias", edit)
			}
			rebuilt = append(rebuilt[:start], append([]byte("standarderrors"), rebuilt[end:]...)...)
			editCount++
		}
		if string(rebuilt) != file["source_code"].(string) {
			t.Fatalf("pinned pkg/errors output for %s differs from reported byte spans", filePath)
		}
	}
	if len(outputs) != 1 || editCount != corpus.ExpectedRefs+1 || outputs[corpus.SelectedPath] == "" {
		t.Fatalf("pinned pkg/errors alias outputs/edits = %d/%d; want one file and 4 edits", len(outputs), editCount)
	}
	renamed := make([]projectFile, len(files))
	copy(renamed, files)
	for index := range renamed {
		if renamed[index].Path == corpus.SelectedPath {
			renamed[index].Source = outputs[corpus.SelectedPath]
			renamed[index].ExpectedHash = hashText(renamed[index].Source)
		}
	}

	for _, build := range corpus.BuildContexts {
		build := build
		t.Run(build.GOOS+"/"+build.GOARCH, func(t *testing.T) {
			assertPkgErrorsBuild(t, files, goMod, build)
			assertPkgErrorsBuild(t, renamed, goMod, build)
		})
	}
	assertPkgErrorsBehavior(t, files, goMod, "original")
	assertPkgErrorsBehavior(t, renamed, goMod, "renamed")
	t.Logf("held-out pkg/errors v0.9.1 alias census: declarations TP=1 FP=0 FN=0; references TP=3 FP=0 FN=0; exact edits=4")
}

func assertPkgErrorsBuild(t *testing.T, files []projectFile, goMod string, build projectModuleRenameBuild) {
	t.Helper()
	root := writePkgErrorsSource(t, files, goMod)
	command := exec.Command("go", "build", "./...")
	command.Dir = root
	command.Env = append(os.Environ(), "GO111MODULE=on", "GOTOOLCHAIN=local", "GOWORK=off", "GOPROXY=off", "GOSUMDB=off", "GOOS="+build.GOOS, "GOARCH="+build.GOARCH, "CGO_ENABLED=0")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("pinned pkg/errors build failed for %s/%s: %v\n%s", build.GOOS, build.GOARCH, err, output)
	}
}

func assertPkgErrorsBehavior(t *testing.T, files []projectFile, goMod, variant string) {
	t.Helper()
	root := writePkgErrorsSource(t, files, goMod)
	testSource := `package errors
import (
  "testing"
)
type aliasHoldoutTarget struct { message string }
func (e *aliasHoldoutTarget) Error() string { return e.message }
type aliasHoldoutWrapper struct { cause error }
func (e *aliasHoldoutWrapper) Error() string { return "wrapped: " + e.cause.Error() }
func (e *aliasHoldoutWrapper) Unwrap() error { return e.cause }
func TestAliasHoldoutBehavior(t *testing.T) {
  cause := &aliasHoldoutTarget{message: "cause"}
  wrapped := &aliasHoldoutWrapper{cause: cause}
  if !Is(wrapped, cause) { t.Fatal("Is did not find wrapped cause") }
  var got *aliasHoldoutTarget
  if !As(wrapped, &got) || got != cause { t.Fatal("As did not recover wrapped cause") }
  if Unwrap(wrapped) != cause { t.Fatal("Unwrap did not return wrapped cause") }
}
`
	if err := os.WriteFile(filepath.Join(root, "alias_holdout_test.go"), []byte(testSource), 0o600); err != nil {
		t.Fatal(err)
	}
	command := exec.Command("go", "test", "./...")
	command.Dir = root
	command.Env = append(os.Environ(), "GO111MODULE=on", "GOTOOLCHAIN=local", "GOWORK=off", "GOPROXY=off", "GOSUMDB=off", "CGO_ENABLED=0")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("pinned pkg/errors %s behavior failed: %v\n%s", variant, err, output)
	}
}

func writePkgErrorsSource(t *testing.T, files []projectFile, goMod string) string {
	t.Helper()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "go.mod"), []byte(goMod), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		fullPath := filepath.Join(root, filepath.FromSlash(file.Path))
		if err := os.MkdirAll(filepath.Dir(fullPath), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(fullPath, []byte(file.Source), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return root
}
