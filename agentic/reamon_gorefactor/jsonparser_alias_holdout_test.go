package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

type jsonParserAliasHoldout struct {
	Version          int                           `json:"version"`
	ModulePath       string                        `json:"module_path"`
	SourceCommit     string                        `json:"source_commit"`
	ModuleSum        string                        `json:"module_sum"`
	GoModFixturePath string                        `json:"go_mod_fixture_path"`
	GoModSHA256      string                        `json:"go_mod_sha256"`
	LicenseFixture   string                        `json:"license_fixture_path"`
	LicenseSHA256    string                        `json:"license_sha256"`
	Files            []projectInventoryFixtureFile `json:"files"`
	BuildContexts    []jsonParserAliasBuild        `json:"build_contexts"`
	AliasName        string                        `json:"alias_name"`
	SelectedPath     string                        `json:"selected_path"`
	ExpectedRefs     int                           `json:"expected_references"`
}

type jsonParserAliasBuild struct {
	GOOS   string   `json:"goos"`
	GOARCH string   `json:"goarch"`
	Tags   []string `json:"tags"`
}

func TestProjectModuleImportAliasPinnedJsonparserV111(t *testing.T) {
	const fixtureRoot = "testdata"
	manifestBytes, err := os.ReadFile(filepath.Join(fixtureRoot, "jsonparser_import_alias_holdout_v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	var corpus jsonParserAliasHoldout
	if err := json.Unmarshal(manifestBytes, &corpus); err != nil {
		t.Fatal(err)
	}
	if corpus.Version != 1 || corpus.ModulePath != "github.com/buger/jsonparser" ||
		corpus.SourceCommit != "df3ea76ece10095374fd1c9a22a4fb85a44efc42" ||
		corpus.ModuleSum != "h1:2PnMjfWD7wBILjqQbt530v576A/cAbQvEW9gGIpYMUs=" ||
		corpus.AliasName != "bio" || corpus.SelectedPath != "bytes.go" || corpus.ExpectedRefs != 1 ||
		len(corpus.BuildContexts) != 4 || len(corpus.Files) != 6 {
		t.Fatalf("pinned jsonparser alias corpus identity = %+v", corpus)
	}
	readVerified := func(relativePath, expectedHash string) []byte {
		t.Helper()
		contents, err := os.ReadFile(filepath.Join(fixtureRoot, filepath.FromSlash(relativePath)))
		if err != nil {
			t.Fatalf("read pinned jsonparser fixture %s: %v", relativePath, err)
		}
		if actual := hashText(string(contents)); actual != expectedHash {
			t.Fatalf("pinned jsonparser fixture hash for %s = %s; want %s", relativePath, actual, expectedHash)
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
	independentAliases := independentExplicitImportAliasReferences(t, files)
	if len(independentAliases) != 1 || independentAliases[corpus.SelectedPath+"\x00"+corpus.AliasName] != corpus.ExpectedRefs {
		t.Fatalf("independent jsonparser alias AST census = %#v; want bio with one reference", independentAliases)
	}

	declarationTP, referenceTP := 0, 0
	for _, build := range corpus.BuildContexts {
		build := build
		label := build.GOOS + "/" + build.GOARCH
		if len(build.Tags) > 0 {
			label += "/" + strings.Join(build.Tags, ",")
		}
		t.Run(label, func(t *testing.T) {
			request := goProjectRequest(files, corpus.SelectedPath)
			request.Operation = "project_module_bindings"
			request.ModulePath, request.GoMod, request.GoModHash = corpus.ModulePath, goMod, corpus.GoModSHA256
			request.BuildGOOS, request.BuildGOARCH = build.GOOS, build.GOARCH
			request.BuildTags = append([]string(nil), build.Tags...)
			bindingsResult, err := listProjectModuleBindings(request)
			if err != nil {
				t.Fatalf("catalog pinned jsonparser aliases: %v", err)
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
				t.Fatalf("pinned jsonparser alias catalog = %+v (aliases=%d); want bio with 1 reference", selected, aliasCount)
			}
			declarationTP++
			referenceTP += selected.ReferenceCount

			request.Operation = "project_module_rename"
			request.ExpectedHash = bindingsResult["source_sha256"].(string)
			request.SourceSetHash = bindingsResult["source_set_sha256"].(string)
			request.Renames = []renameSelection{{ID: selected.ID, NewName: "byteslib"}}
			result, err := applyProjectModuleRenames(request)
			if err != nil {
				t.Fatalf("rename pinned jsonparser import alias: %v", err)
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
					if edit["old_text"] != corpus.AliasName || edit["new_text"] != "byteslib" ||
						start < 0 || end < start || end > len(rebuilt) || string(rebuilt[start:end]) != corpus.AliasName {
						t.Fatalf("pinned jsonparser alias byte edit = %#v; source does not match the expected alias", edit)
					}
					rebuilt = append(rebuilt[:start], append([]byte("byteslib"), rebuilt[end:]...)...)
					editCount++
				}
				if string(rebuilt) != file["source_code"].(string) {
					t.Fatalf("pinned jsonparser output for %s differs from reported byte spans", filePath)
				}
			}
			if len(outputs) != 1 || outputs[corpus.SelectedPath] == "" || editCount != corpus.ExpectedRefs+1 {
				t.Fatalf("pinned jsonparser alias outputs/edits = %d/%d; want one file and 2 edits", len(outputs), editCount)
			}
			renamed := make([]projectFile, len(files))
			copy(renamed, files)
			for index := range renamed {
				if renamed[index].Path == corpus.SelectedPath {
					renamed[index].Source = outputs[corpus.SelectedPath]
					renamed[index].ExpectedHash = hashText(renamed[index].Source)
				}
			}
			assertJsonparserBuild(t, files, goMod, build)
			assertJsonparserBuild(t, renamed, goMod, build)
			if build.GOOS == "linux" && build.GOARCH == "amd64" {
				assertJsonparserBehavior(t, files, goMod, build.Tags, "original")
				assertJsonparserBehavior(t, renamed, goMod, build.Tags, "renamed")
			}
		})
	}
	if declarationTP != len(corpus.BuildContexts) || referenceTP != len(corpus.BuildContexts) {
		t.Fatalf("held-out jsonparser alias census TP declarations/references = %d/%d; want %d/%d", declarationTP, referenceTP, len(corpus.BuildContexts), len(corpus.BuildContexts))
	}
	t.Logf("held-out jsonparser v1.1.1 alias census: declarations TP=%d FP=0 FN=0; references TP=%d FP=0 FN=0 across %d build contexts", declarationTP, referenceTP, len(corpus.BuildContexts))
}

func assertJsonparserBuild(t *testing.T, files []projectFile, goMod string, build jsonParserAliasBuild) {
	t.Helper()
	root := writeGoModuleSource(t, files, goMod)
	args := []string{"build"}
	if len(build.Tags) > 0 {
		args = append(args, "-tags="+strings.Join(build.Tags, ","))
	}
	args = append(args, "./...")
	command := exec.Command("go", args...)
	command.Dir = root
	command.Env = append(os.Environ(), "GO111MODULE=on", "GOTOOLCHAIN=local", "GOWORK=off", "GOPROXY=off", "GOSUMDB=off", "GOOS="+build.GOOS, "GOARCH="+build.GOARCH, "CGO_ENABLED=0")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("pinned jsonparser build failed for %s/%s tags=%v: %v\n%s", build.GOOS, build.GOARCH, build.Tags, err, output)
	}
}

func assertJsonparserBehavior(t *testing.T, files []projectFile, goMod string, tags []string, variant string) {
	t.Helper()
	root := writeGoModuleSource(t, files, goMod)
	testSource := `package jsonparser
import "testing"
func TestAliasHoldoutBehavior(t *testing.T) {
  got, err := GetInt([]byte("{\"n\":-9223372036854775808}"), "n")
  if err != nil || got != -1<<63 { t.Fatalf("GetInt(min int64) = %d, %v", got, err) }
  got, err = GetInt([]byte("{\"n\":42}"), "n")
  if err != nil || got != 42 { t.Fatalf("GetInt(42) = %d, %v", got, err) }
  if _, err := GetInt([]byte("{\"n\":9223372036854775808}"), "n"); err == nil { t.Fatal("GetInt accepted positive int64 overflow") }
}
`
	if err := os.WriteFile(filepath.Join(root, "alias_holdout_test.go"), []byte(testSource), 0o600); err != nil {
		t.Fatal(err)
	}
	args := []string{"test"}
	if len(tags) > 0 {
		args = append(args, "-tags="+strings.Join(tags, ","))
	}
	args = append(args, "./...")
	command := exec.Command("go", args...)
	command.Dir = root
	command.Env = append(os.Environ(), "GO111MODULE=on", "GOTOOLCHAIN=local", "GOWORK=off", "GOPROXY=off", "GOSUMDB=off", "CGO_ENABLED=0")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("pinned jsonparser %s behavior failed for tags=%v: %v\n%s", variant, tags, err, output)
	}
}
