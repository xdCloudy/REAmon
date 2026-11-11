package main

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

func TestProjectCatalogBoundsLargeGeneratedSourceFiles(t *testing.T) {
	withinLimit := goProjectRequest([]projectFile{{Path: "generated.go", Source: "package generated\n//" + strings.Repeat("x", maxSourceBytes+1) + "\nfunc Keep() {}\n"}}, "generated.go")
	if _, err := buildProjectCatalog(withinLimit); err != nil {
		t.Fatalf("project catalog rejected a generated file above the single-file limit but below the project-file limit: %v", err)
	}
	tooLarge := goProjectRequest([]projectFile{{Path: "generated.go", Source: "package generated\n//" + strings.Repeat("x", maxProjectFileBytes+1) + "\nfunc Keep() {}\n"}}, "generated.go")
	if _, err := buildProjectCatalog(tooLarge); err == nil || err.Error() != "generated.go exceeds the 2 MiB safe-project file limit" {
		t.Fatalf("oversized project file error = %v; want bounded 2 MiB rejection", err)
	}
}

func TestProjectModuleImportAliasPinnedXSysWindowsV060(t *testing.T) {
	manifestBytes, err := os.ReadFile(filepath.Join("testdata", "project_import_alias_holdout_v1.json"))
	if err != nil {
		t.Fatalf("read pinned import-alias corpus: %v", err)
	}
	var corpus projectImportAliasHoldoutCorpus
	if err := json.Unmarshal(manifestBytes, &corpus); err != nil {
		t.Fatalf("parse pinned import-alias corpus: %v", err)
	}
	if corpus.Version != 1 || corpus.ModulePath != "golang.org/x/sys" ||
		corpus.SourceCommit != "c7a1bf9a0b0aa7c0c0e35a435924dd68e64d1653" ||
		corpus.ModuleSum != "h1:MVltZSvRTcU2ljQOhs94SXPftV6DCNnZViHeQps87pQ=" ||
		len(corpus.BuildContexts) != 2 || corpus.BuildContexts[0].GOOS != "windows" || corpus.BuildContexts[0].GOARCH != "amd64" ||
		corpus.BuildContexts[1].GOOS != "windows" || corpus.BuildContexts[1].GOARCH != "arm64" ||
		len(corpus.Aliases) != 2 || len(corpus.Files) < 1 {
		t.Fatalf("pinned import-alias corpus identity = %+v", corpus)
	}
	goModBytes, err := os.ReadFile(filepath.Join("testdata", filepath.FromSlash(corpus.GoModFixturePath)))
	if err != nil {
		t.Fatalf("read pinned x/sys go.mod: %v", err)
	}
	if hashText(string(goModBytes)) != corpus.GoModSHA256 {
		t.Fatal("pinned x/sys go.mod hash changed")
	}
	licenseBytes, err := os.ReadFile(filepath.Join("testdata", filepath.FromSlash(corpus.LicenseFixture)))
	if err != nil {
		t.Fatalf("read pinned x/sys license: %v", err)
	}
	if hashText(string(licenseBytes)) != corpus.LicenseSHA256 {
		t.Fatal("pinned x/sys license hash changed")
	}
	files := make([]projectFile, 0, len(corpus.Files))
	for _, source := range corpus.Files {
		contents, err := os.ReadFile(filepath.Join("testdata", filepath.FromSlash(source.FixturePath)))
		if err != nil {
			t.Fatalf("read pinned x/sys source %s: %v", source.FixturePath, err)
		}
		if actual := hashText(string(contents)); actual != source.SHA256 {
			t.Fatalf("pinned x/sys source hash for %s = %s; want %s", source.InventoryPath, actual, source.SHA256)
		}
		files = append(files, projectFile{Path: source.InventoryPath, Source: string(contents), ExpectedHash: source.SHA256})
	}
	baseFiles := files
	for _, build := range corpus.BuildContexts {
		build := build
		t.Run(build.GOOS+"/"+build.GOARCH, func(t *testing.T) {
			files := append([]projectFile(nil), baseFiles...)
			independentAliases := independentExplicitImportAliasReferences(t, files)
			if len(independentAliases) != 2 || independentAliases["windows/exec_windows.go\x00errorspkg"] != 1 ||
				independentAliases["windows/syscall_windows.go\x00errorspkg"] != 2 {
				t.Fatalf("independent x/sys import-alias AST census = %#v; want two aliases with 1 and 2 references", independentAliases)
			}
			assertXSysWindowsBuild(t, files, string(goModBytes), build, "original")

			declarationTP, referenceTP := 0, 0
			for _, expected := range corpus.Aliases {
				expected := expected
				t.Run(expected.SelectedPath, func(t *testing.T) {
					goldReferences := independentAliases[expected.SelectedPath+"\x00"+expected.Name]
					if expected.Name != "errorspkg" || goldReferences != expected.ExpectedReferences ||
						expected.ExpectedEdits != expected.ExpectedReferences+1 {
						t.Fatalf("pinned alias expectation = %+v; independent AST census = %#v", expected, independentAliases)
					}
					request := goProjectRequest(files, expected.SelectedPath)
					request.Operation = "project_module_bindings"
					request.ModulePath, request.GoMod, request.GoModHash = corpus.ModulePath, string(goModBytes), corpus.GoModSHA256
					request.BuildGOOS, request.BuildGOARCH = build.GOOS, build.GOARCH
					bindingsResult, err := listProjectModuleBindings(request)
					if err != nil {
						t.Fatalf("catalog pinned x/sys aliases: %v", err)
					}
					var selected binding
					aliasCount := 0
					for _, raw := range bindingsResult["bindings"].([]map[string]any) {
						if raw["kind"] != "file import alias" {
							continue
						}
						aliasCount++
						if raw["name"] == expected.Name && raw["relativePath"] == expected.SelectedPath {
							selected = binding{ID: raw["id"].(string), Name: raw["name"].(string), Kind: raw["kind"].(string),
								ScopeType: raw["scopeType"].(string), FilePath: raw["relativePath"].(string),
								ReferenceCount: raw["referenceCount"].(int)}
						}
					}
					if aliasCount != 1 || selected.ID == "" || selected.Kind != "file import alias" ||
						selected.ScopeType != "file" || selected.ReferenceCount != goldReferences {
						t.Fatalf("pinned x/sys alias catalog = %+v (aliases=%d); want one file alias with %d references", selected, aliasCount, goldReferences)
					}
					declarationTP++
					referenceTP += goldReferences

					request.Operation = "project_module_rename"
					request.ExpectedHash = bindingsResult["source_sha256"].(string)
					request.SourceSetHash = bindingsResult["source_set_sha256"].(string)
					request.Renames = []renameSelection{{ID: selected.ID, NewName: "errorslib"}}
					result, err := applyProjectModuleRenames(request)
					if err != nil {
						t.Fatalf("rename pinned x/sys import alias: %v", err)
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
							if edit["old_text"] != expected.Name || edit["new_text"] != "errorslib" ||
								start < 0 || end < start || end > len(rebuilt) || string(rebuilt[start:end]) != expected.Name {
								t.Fatalf("pinned alias byte edit = %#v; source does not match the expected alias", edit)
							}
							rebuilt = append(rebuilt[:start], append([]byte("errorslib"), rebuilt[end:]...)...)
							editCount++
						}
						if string(rebuilt) != file["source_code"].(string) {
							t.Fatalf("pinned alias output for %s differs from the reported byte spans", filePath)
						}
					}
					if len(outputs) != 1 || editCount != expected.ExpectedEdits || outputs[expected.SelectedPath] == "" {
						t.Fatalf("pinned x/sys alias outputs/edits = %d/%d; want one file and %d edits", len(outputs), editCount, expected.ExpectedEdits)
					}
					for index := range files {
						if files[index].Path == expected.SelectedPath {
							files[index].Source = outputs[expected.SelectedPath]
							files[index].ExpectedHash = hashText(files[index].Source)
						}
					}
				})
			}
			if declarationTP != 2 || referenceTP != 3 {
				t.Fatalf("held-out x/sys alias census TP declarations/references = %d/%d; want 2/3", declarationTP, referenceTP)
			}
			t.Logf("held-out explicit import-alias census: declarations TP=%d FP=0 FN=0; references TP=%d FP=0 FN=0", declarationTP, referenceTP)
			assertXSysWindowsBuild(t, files, string(goModBytes), build, "renamed")
		})
	}
}

func independentExplicitImportAliasReferences(t *testing.T, files []projectFile) map[string]int {
	t.Helper()
	aliases := make(map[string]int)
	for _, source := range files {
		parsed, err := parser.ParseFile(token.NewFileSet(), source.Path, source.Source, parser.AllErrors)
		if err != nil {
			t.Fatalf("independent import-alias parse for %s: %v", source.Path, err)
		}
		for _, spec := range parsed.Imports {
			if spec.Name == nil || spec.Name.Name == "_" || spec.Name.Name == "." {
				continue
			}
			key := source.Path + "\x00" + spec.Name.Name
			if _, duplicate := aliases[key]; duplicate {
				t.Fatalf("duplicate explicit alias %s in %s", spec.Name.Name, source.Path)
			}
			ast.Inspect(parsed, func(node ast.Node) bool {
				selector, ok := node.(*ast.SelectorExpr)
				if !ok {
					return true
				}
				base, ok := selector.X.(*ast.Ident)
				if ok && base.Name == spec.Name.Name {
					aliases[key]++
				}
				return true
			})
		}
	}
	return aliases
}

func assertXSysWindowsBuild(t *testing.T, files []projectFile, goMod string, build projectModuleRenameBuild, variant string) {
	t.Helper()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "go.mod"), []byte(goMod), 0o600); err != nil {
		t.Fatalf("write pinned x/sys %s go.mod: %v", variant, err)
	}
	for _, file := range files {
		fullPath := filepath.Join(root, filepath.FromSlash(file.Path))
		if err := os.MkdirAll(filepath.Dir(fullPath), 0o700); err != nil {
			t.Fatalf("create pinned x/sys %s directory: %v", variant, err)
		}
		if err := os.WriteFile(fullPath, []byte(file.Source), 0o600); err != nil {
			t.Fatalf("write pinned x/sys %s source %s: %v", variant, file.Path, err)
		}
	}
	command := exec.Command("go", "build", "./windows")
	command.Dir = root
	command.Env = append(os.Environ(), "GO111MODULE=on", "GOTOOLCHAIN=local", "GOWORK=off", "GOPROXY=off", "GOSUMDB=off", "GOOS="+build.GOOS, "GOARCH="+build.GOARCH, "CGO_ENABLED=0")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("pinned x/sys Windows build %s failed: %v\n%s", variant, err, output)
	}
}
