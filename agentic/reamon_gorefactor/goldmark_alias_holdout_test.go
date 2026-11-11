package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"testing"
)

type goldmarkAliasHoldout struct {
	Version          int                           `json:"version"`
	ModulePath       string                        `json:"module_path"`
	SourceCommit     string                        `json:"source_commit"`
	ModuleSum        string                        `json:"module_sum"`
	GoModFixturePath string                        `json:"go_mod_fixture_path"`
	GoModSHA256      string                        `json:"go_mod_sha256"`
	LicenseFixture   string                        `json:"license_fixture_path"`
	LicenseSHA256    string                        `json:"license_sha256"`
	Files            []projectInventoryFixtureFile `json:"files"`
	Aliases          []goldmarkAliasHoldoutBinding `json:"aliases"`
	BuildContexts    []projectModuleRenameBuild    `json:"build_contexts"`
}

type goldmarkAliasHoldoutBinding struct {
	SelectedPath       string `json:"selected_path"`
	Name               string `json:"name"`
	ExpectedReferences int    `json:"expected_references"`
	NewName            string `json:"new_name"`
}

func TestProjectModuleImportAliasPinnedGoldmarkV178(t *testing.T) {
	const fixtureRoot = "testdata"
	manifestBytes, err := os.ReadFile(filepath.Join(fixtureRoot, "goldmark_import_alias_holdout_v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	var corpus goldmarkAliasHoldout
	if err := json.Unmarshal(manifestBytes, &corpus); err != nil {
		t.Fatal(err)
	}
	if corpus.Version != 1 || corpus.ModulePath != "github.com/yuin/goldmark" ||
		corpus.SourceCommit != "d9c03f07f08c2d36f23afe52dda865f05320ac86" ||
		corpus.ModuleSum != "h1:iERMLn0/QJeHFhxSt3p6PeN9mGnvIKSpG9YYorDMnic=" ||
		len(corpus.Files) != 51 || len(corpus.Aliases) != 14 || len(corpus.BuildContexts) != 3 {
		t.Fatalf("pinned goldmark alias corpus identity = %+v", corpus)
	}
	readVerified := func(relativePath, expectedHash string) []byte {
		t.Helper()
		contents, err := os.ReadFile(filepath.Join(fixtureRoot, filepath.FromSlash(relativePath)))
		if err != nil {
			t.Fatalf("read pinned goldmark fixture %s: %v", relativePath, err)
		}
		if actual := hashText(string(contents)); actual != expectedHash {
			t.Fatalf("pinned goldmark fixture hash for %s = %s; want %s", relativePath, actual, expectedHash)
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

	expectedAliases := make(map[string]goldmarkAliasHoldoutBinding, len(corpus.Aliases))
	for _, expected := range corpus.Aliases {
		key := expected.SelectedPath + "\x00" + expected.Name
		if expected.ExpectedReferences < 1 || expected.NewName == "" {
			t.Fatalf("invalid goldmark alias expectation: %+v", expected)
		}
		if _, duplicate := expectedAliases[key]; duplicate {
			t.Fatalf("duplicate goldmark alias expectation %q", key)
		}
		expectedAliases[key] = expected
	}
	independentAliases := independentExplicitImportAliasReferences(t, files)
	if len(independentAliases) != len(expectedAliases) {
		t.Fatalf("independent goldmark import-alias census has %d entries; manifest has %d: %#v", len(independentAliases), len(expectedAliases), independentAliases)
	}
	for key, expected := range expectedAliases {
		if independentAliases[key] != expected.ExpectedReferences {
			t.Fatalf("independent goldmark AST count for %q = %d; want %d", key, independentAliases[key], expected.ExpectedReferences)
		}
	}

	expectedEditCount := 0
	for _, expected := range corpus.Aliases {
		expectedEditCount += expected.ExpectedReferences + 1
	}
	for _, build := range corpus.BuildContexts {
		build := build
		t.Run(build.GOOS+"/"+build.GOARCH, func(t *testing.T) {
			request := goProjectRequest(files, "ast/ast.go")
			request.Operation = "project_module_bindings"
			request.ModulePath, request.GoMod, request.GoModHash = corpus.ModulePath, goMod, corpus.GoModSHA256
			request.BuildGOOS, request.BuildGOARCH = build.GOOS, build.GOARCH
			bindingsResult, err := listProjectModuleBindings(request)
			if err != nil {
				t.Fatalf("catalog pinned goldmark aliases: %v", err)
			}
			selectedIDs := make(map[string]string, len(expectedAliases))
			aliasCount := 0
			for _, raw := range bindingsResult["bindings"].([]map[string]any) {
				if raw["kind"] != "file import alias" {
					continue
				}
				aliasCount++
				path, name := raw["relativePath"].(string), raw["name"].(string)
				key := path + "\x00" + name
				expected, ok := expectedAliases[key]
				if !ok || raw["scopeType"] != "file" || raw["referenceCount"].(int) != expected.ExpectedReferences {
					t.Fatalf("goldmark import-alias binding = %#v; manifest has no matching declaration/reference expectation", raw)
				}
				selectedIDs[key] = raw["id"].(string)
			}
			if aliasCount != len(expectedAliases) || len(selectedIDs) != len(expectedAliases) {
				t.Fatalf("goldmark alias bindings = %d, selected = %d; want %d", aliasCount, len(selectedIDs), len(expectedAliases))
			}

			request.Operation = "project_module_rename"
			request.ExpectedHash = bindingsResult["source_sha256"].(string)
			request.SourceSetHash = bindingsResult["source_set_sha256"].(string)
			for _, expected := range corpus.Aliases {
				key := expected.SelectedPath + "\x00" + expected.Name
				request.Renames = append(request.Renames, renameSelection{ID: selectedIDs[key], NewName: expected.NewName})
			}
			result, err := applyProjectModuleRenames(request)
			if err != nil {
				t.Fatalf("rename pinned goldmark aliases in one module batch: %v", err)
			}
			outputs := make(map[string]string)
			editsByFile := make(map[string]int)
			totalEdits := 0
			for _, file := range result["files"].([]map[string]any) {
				filePath := file["relative_path"].(string)
				outputs[filePath] = file["source_code"].(string)
				var source string
				for _, original := range files {
					if original.Path == filePath {
						source = original.Source
						break
					}
				}
				rebuilt := []byte(source)
				edits := file["edits"].([]map[string]any)
				sort.Slice(edits, func(i, j int) bool { return edits[i]["start"].(int) > edits[j]["start"].(int) })
				for _, edit := range edits {
					start, end := edit["start"].(int), edit["end"].(int)
					matched := false
					for _, expected := range corpus.Aliases {
						if expected.SelectedPath == filePath && edit["old_text"] == expected.Name && edit["new_text"] == expected.NewName {
							matched = true
							break
						}
					}
					if !matched || start < 0 || end < start || end > len(rebuilt) ||
						string(rebuilt[start:end]) != edit["old_text"].(string) {
						t.Fatalf("goldmark alias byte edit = %#v; source does not match a pinned binding", edit)
					}
					rebuilt = append(rebuilt[:start], append([]byte(edit["new_text"].(string)), rebuilt[end:]...)...)
					editsByFile[filePath]++
					totalEdits++
				}
				if string(rebuilt) != file["source_code"].(string) {
					t.Fatalf("goldmark output for %s differs from reported byte spans", filePath)
				}
			}
			if len(outputs) != len(expectedAliases) || totalEdits != expectedEditCount {
				t.Fatalf("goldmark batch outputs/edits = %d/%d; want %d files and %d edits", len(outputs), totalEdits, len(expectedAliases), expectedEditCount)
			}
			renamed := make([]projectFile, len(files))
			copy(renamed, files)
			for index := range renamed {
				if source, changed := outputs[renamed[index].Path]; changed {
					renamed[index].Source = source
					renamed[index].ExpectedHash = hashText(source)
				}
			}
			for _, expected := range corpus.Aliases {
				if editsByFile[expected.SelectedPath] != expected.ExpectedReferences+1 || outputs[expected.SelectedPath] == "" {
					t.Fatalf("goldmark edits for %s = %d; want %d", expected.SelectedPath, editsByFile[expected.SelectedPath], expected.ExpectedReferences+1)
				}
			}
			assertGoldmarkBuild(t, files, goMod, build, "original")
			assertGoldmarkBuild(t, renamed, goMod, build, "renamed")
			if build.GOOS == "linux" && build.GOARCH == "amd64" {
				assertGoldmarkBehavior(t, files, goMod, "original")
				assertGoldmarkBehavior(t, renamed, goMod, "renamed")
			}
			t.Logf("goldmark coordinated batch: aliases=%d references=176 edits=%d files=%d", len(expectedAliases), expectedEditCount, len(outputs))
		})
	}
}

func assertGoldmarkBuild(t *testing.T, files []projectFile, goMod string, build projectModuleRenameBuild, variant string) {
	t.Helper()
	root := writeGoModuleSource(t, files, goMod)
	command := exec.Command("go", "build", "./...")
	command.Dir = root
	command.Env = append(os.Environ(), "GO111MODULE=on", "GOTOOLCHAIN=local", "GOWORK=off", "GOPROXY=off", "GOSUMDB=off", "GOOS="+build.GOOS, "GOARCH="+build.GOARCH, "CGO_ENABLED=0")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("pinned goldmark %s build failed for %s/%s: %v\n%s", variant, build.GOOS, build.GOARCH, err, output)
	}
}

func assertGoldmarkBehavior(t *testing.T, files []projectFile, goMod, variant string) {
	t.Helper()
	root := writeGoModuleSource(t, files, goMod)
	testSource := `package goldmark_test
import (
  "bytes"
  "strings"
  "testing"
  "github.com/yuin/goldmark"
  "github.com/yuin/goldmark/extension"
)
func TestAliasHoldoutBehavior(t *testing.T) {
  markdown := goldmark.New(goldmark.WithExtensions(extension.GFM))
  var output bytes.Buffer
  if err := markdown.Convert([]byte("# Title\n\nHello **world** and ~~strike~~.\n"), &output); err != nil { t.Fatal(err) }
  for _, want := range []string{"<h1>Title</h1>", "<strong>world</strong>", "<del>strike</del>"} {
    if !strings.Contains(output.String(), want) { t.Fatalf("rendered output %q does not contain %q", output.String(), want) }
  }
}
`
	if err := os.WriteFile(filepath.Join(root, "alias_holdout_test.go"), []byte(testSource), 0o600); err != nil {
		t.Fatal(err)
	}
	command := exec.Command("go", "test", "./...")
	command.Dir = root
	command.Env = append(os.Environ(), "GO111MODULE=on", "GOTOOLCHAIN=local", "GOWORK=off", "GOPROXY=off", "GOSUMDB=off", "CGO_ENABLED=0")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("pinned goldmark %s behavior failed: %v\n%s", variant, err, output)
	}
}
