package main

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"go/ast"
	gobuild "go/build"
	"go/importer"
	"go/parser"
	"go/token"
	"go/types"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strings"
	"testing"
)

type projectRenameCorpus struct {
	Version     int                             `json:"version"`
	Cases       []projectRenameCorpusCase       `json:"cases"`
	RejectCases []projectRenameRejectCorpusCase `json:"reject_cases"`
}

type projectRenameCorpusCase struct {
	Name           string            `json:"name"`
	SelectedPath   string            `json:"selected_path"`
	OldName        string            `json:"old_name"`
	NewName        string            `json:"new_name"`
	ReferenceCount int               `json:"reference_count"`
	Files          map[string]string `json:"files"`
	Expected       map[string]string `json:"expected"`
	BehaviorTest   string            `json:"behavior_test"`
}

type projectRenameRejectCorpusCase struct {
	Name          string            `json:"name"`
	SelectedPath  string            `json:"selected_path"`
	OldName       string            `json:"old_name"`
	NewName       string            `json:"new_name"`
	ErrorContains string            `json:"error_contains"`
	Files         map[string]string `json:"files"`
}

type projectInventoryCorpus struct {
	Version  int                       `json:"version"`
	Fixtures []projectInventoryFixture `json:"fixtures"`
}

type projectInventoryFixture struct {
	Name               string                         `json:"name"`
	ModulePath         string                         `json:"module_path"`
	GoMod              string                         `json:"go_mod"`
	PackageName        string                         `json:"package_name"`
	BuildContexts      []projectInventoryBuildContext `json:"build_contexts"`
	SelectedPath       string                         `json:"selected_path"`
	Files              []projectInventoryFixtureFile  `json:"files"`
	Expected           map[string]int                 `json:"expected"`
	ExpectedAllScopeTP int                            `json:"expected_all_scope_tp"`
	ExpectedAllScopeFP int                            `json:"expected_all_scope_fp"`
	ExpectedAllScopeFN int                            `json:"expected_all_scope_fn"`
}

type projectInventoryBuildContext struct {
	GOOS   string `json:"goos"`
	GOARCH string `json:"goarch"`
}

type projectInventoryFixtureFile struct {
	FixturePath   string `json:"fixture_path"`
	InventoryPath string `json:"inventory_path"`
	SHA256        string `json:"sha256"`
}

type projectInventoryRecallCorpus struct {
	Version  int                             `json:"version"`
	Fixtures []projectInventoryRecallFixture `json:"fixtures"`
}

type projectInventoryRecallFixture struct {
	Name          string                        `json:"name"`
	ModulePath    string                        `json:"module_path"`
	GoModFixture  string                        `json:"go_mod_fixture_path"`
	GoModSHA256   string                        `json:"go_mod_sha256"`
	GoSumFixture  string                        `json:"go_sum_fixture_path"`
	GoSumSHA256   string                        `json:"go_sum_sha256"`
	SelectedPath  string                        `json:"selected_path"`
	Files         []projectInventoryFixtureFile `json:"files"`
	BuildContexts []projectInventoryRecallBuild `json:"build_contexts"`
}

type projectInventoryRecallBuild struct {
	GOOS                string `json:"goos"`
	GOARCH              string `json:"goarch"`
	SelectedPath        string `json:"selected_path"`
	ExpectedPackageTP   int    `json:"expected_package_tp"`
	ExpectedPackageFP   int    `json:"expected_package_fp"`
	ExpectedPackageFN   int    `json:"expected_package_fn"`
	ExpectedAllScopeTP  int    `json:"expected_all_scope_tp"`
	ExpectedAllScopeFP  int    `json:"expected_all_scope_fp"`
	ExpectedAllScopeFN  int    `json:"expected_all_scope_fn"`
	ExpectedMemberCount int    `json:"expected_member_count"`
}

type projectModuleRenameCorpus struct {
	Version     int                                `json:"version"`
	Fixtures    []projectModuleRenameFixture       `json:"fixtures"`
	RejectCases []projectModuleRenameRejectFixture `json:"reject_cases"`
}

type projectModuleRenameFixture struct {
	Name                 string                         `json:"name"`
	SourceManifest       string                         `json:"source_manifest"`
	SourceFixtureName    string                         `json:"source_fixture_name"`
	SelectedPath         string                         `json:"selected_path"`
	Operations           []projectModuleRenameOperation `json:"operations"`
	BehaviorRouterMethod string                         `json:"behavior_router_method"`
	BehaviorRouteMethod  string                         `json:"behavior_route_method"`
	BuildContexts        []projectModuleRenameBuild     `json:"build_contexts"`
}

type projectModuleRenameOperation struct {
	SelectedPath        string         `json:"selected_path"`
	OldName             string         `json:"old_name"`
	NewName             string         `json:"new_name"`
	ExpectedReferences  int            `json:"expected_references"`
	ExpectedEditsByFile map[string]int `json:"expected_edits_by_file"`
}

type projectModuleRenameBuild struct {
	GOOS   string `json:"goos"`
	GOARCH string `json:"goarch"`
}

type projectModuleRenameRejectFixture struct {
	Name               string                     `json:"name"`
	SourceManifest     string                     `json:"source_manifest"`
	SourceFixtureName  string                     `json:"source_fixture_name"`
	SelectedPath       string                     `json:"selected_path"`
	OldName            string                     `json:"old_name"`
	NewName            string                     `json:"new_name"`
	Declaration        string                     `json:"declaration"`
	ExpectedReferences int                        `json:"expected_references"`
	ExpectedError      string                     `json:"expected_error"`
	BuildContexts      []projectModuleRenameBuild `json:"build_contexts"`
}

type projectImportAliasHoldoutCorpus struct {
	Version          int                           `json:"version"`
	Name             string                        `json:"name"`
	ModulePath       string                        `json:"module_path"`
	SourceCommit     string                        `json:"source_commit"`
	ModuleSum        string                        `json:"module_sum"`
	GoModFixturePath string                        `json:"go_mod_fixture_path"`
	GoModSHA256      string                        `json:"go_mod_sha256"`
	LicenseFixture   string                        `json:"license_fixture_path"`
	LicenseSHA256    string                        `json:"license_sha256"`
	BuildContexts    []projectModuleRenameBuild    `json:"build_contexts"`
	Files            []projectInventoryFixtureFile `json:"files"`
	Aliases          []projectImportAliasHoldout   `json:"aliases"`
}

type projectImportAliasHoldout struct {
	SelectedPath       string `json:"selected_path"`
	Name               string `json:"name"`
	ExpectedReferences int    `json:"expected_references"`
	ExpectedEdits      int    `json:"expected_edits"`
}

func bindingNamed(t *testing.T, cat *catalog, name string, declarationStart int) binding {
	t.Helper()
	for _, item := range cat.Bindings {
		if item.Name == name && item.DeclarationStart == declarationStart {
			return item
		}
	}
	t.Fatalf("binding %q at byte %d was not catalogued", name, declarationStart)
	return binding{}
}

func goProjectRequest(files []projectFile, selectedPath string) request {
	for index := range files {
		files[index].ExpectedHash = hashText(files[index].Source)
	}
	selected := ""
	for _, file := range files {
		if file.Path == selectedPath {
			selected = file.Source
		}
	}
	return request{Operation: "project_bindings", Source: selected, SelectedPath: selectedPath, Files: files}
}

func TestProjectRenameUpdatesResolvedReferencesAcrossFiles(t *testing.T) {
	request := goProjectRequest([]projectFile{
		{Path: "pkg/a.go", Source: "package sample\n\nfunc normalize(value int) int { return value + 1 }\n"},
		{Path: "pkg/b.go", Source: "package sample\n\nfunc run() int { return normalize(4) + normalize(5) }\n"},
	}, "pkg/a.go")
	cat, err := buildProjectCatalog(request)
	if err != nil {
		t.Fatal(err)
	}
	var normalize binding
	for _, item := range cat.Bindings {
		if item.Name == "normalize" {
			normalize = item
		}
	}
	if normalize.ID == "" || normalize.FilePath != "pkg/a.go" || normalize.ReferenceCount != 2 {
		t.Fatalf("package binding = %+v; want declaration in a.go with two cross-file references", normalize)
	}
	request.Operation = "project_rename"
	request.ExpectedHash = cat.SelectedHash
	request.SourceSetHash = cat.SourceSetHash
	request.Renames = []renameSelection{{ID: normalize.ID, NewName: "scale"}}

	result, err := applyProjectRenames(request)
	if err != nil {
		t.Fatal(err)
	}
	files := result["files"].([]map[string]any)
	if len(files) != 2 {
		t.Fatalf("edit manifest files = %d; want both declaration and reference files", len(files))
	}
	outputs := make(map[string]string)
	for _, file := range files {
		outputs[file["relative_path"].(string)] = file["source_code"].(string)
	}
	if !strings.Contains(outputs["pkg/a.go"], "func scale(") || !strings.Contains(outputs["pkg/b.go"], "scale(4) + scale(5)") {
		t.Fatalf("project rename did not update declaration and cross-file references: %#v", outputs)
	}
	if result["scope"] != "project" || result["source_set_sha256"] != cat.SourceSetHash || result["output_source_set_sha256"] == cat.SourceSetHash {
		t.Fatalf("project edit manifest hashes or scope are invalid: %#v", result)
	}
	manifest := result["edit_manifest"].(map[string]any)
	if manifest["version"] != 1 || len(manifest["files"].([]map[string]any)) != 2 {
		t.Fatalf("edit manifest is incomplete: %#v", manifest)
	}
}

func TestProjectRenameUpdatesExplicitImportAliasAndSameFileReferences(t *testing.T) {
	files := []projectFile{
		{Path: "pkg/use.go", Source: "package sample\nimport text \"strings\"\nfunc normalize(value string) string { return text.TrimSpace(text.Join([]string{value}, \"\")) }\n"},
		{Path: "pkg/other.go", Source: "package sample\nfunc run() string { return normalize(\" value \") }\n"},
	}
	request := goProjectRequest(files, "pkg/use.go")
	catalog, err := buildProjectCatalog(request)
	if err != nil {
		t.Fatal(err)
	}
	var alias binding
	for _, item := range catalog.Bindings {
		if item.Name == "text" {
			alias = item
		}
	}
	if alias.ID == "" || alias.Kind != "file import alias" || alias.ScopeType != "file" || alias.ReferenceCount != 2 || len(alias.Uses) != 3 {
		t.Fatalf("import alias binding = %+v; want declaration and two same-file references", alias)
	}
	request.Operation = "project_rename"
	request.ExpectedHash, request.SourceSetHash = catalog.SelectedHash, catalog.SourceSetHash
	request.Renames = []renameSelection{{ID: alias.ID, NewName: "strlib"}}
	result, err := applyProjectRenames(request)
	if err != nil {
		t.Fatalf("rename explicit import alias: %v", err)
	}
	outputs := make(map[string]string)
	editCount := 0
	for _, file := range result["files"].([]map[string]any) {
		outputs[file["relative_path"].(string)] = file["source_code"].(string)
		for _, edit := range file["edits"].([]map[string]any) {
			if edit["old_text"] != "text" || edit["new_text"] != "strlib" {
				t.Fatalf("import alias edit = %#v; want text -> strlib", edit)
			}
			editCount++
		}
	}
	if editCount != 3 || !strings.Contains(outputs["pkg/use.go"], "import strlib \"strings\"") || !strings.Contains(outputs["pkg/use.go"], "strlib.TrimSpace(strlib.Join") || outputs["pkg/other.go"] != "" {
		t.Fatalf("import alias output/edits = %#v / %d; want three edits in the selected file only", outputs, editCount)
	}
}

func TestProjectRenameRejectsImportAliasCaptureByLocalBinding(t *testing.T) {
	files := []projectFile{
		{Path: "pkg/use.go", Source: "package sample\nimport old \"fmt\"\nfunc run() string { format := struct { Sprint func(...any) string }{Sprint: func(...any) string { return \"local\" }}; _ = format; return old.Sprint(\"value\") }\nfunc other() string { return old.Sprint(\"other\") }\n"},
		{Path: "pkg/other.go", Source: "package sample\nfunc siblingOnly() {}\n"},
	}
	request := goProjectRequest(files, "pkg/use.go")
	catalog, err := buildProjectCatalog(request)
	if err != nil {
		t.Fatal(err)
	}
	var alias binding
	for _, item := range catalog.Bindings {
		if item.Name == "old" {
			alias = item
		}
	}
	if alias.ID == "" || alias.ReferenceCount != 2 {
		t.Fatalf("import alias binding = %+v; want two resolved selectors", alias)
	}
	request.Operation = "project_rename"
	request.ExpectedHash, request.SourceSetHash = catalog.SelectedHash, catalog.SourceSetHash
	request.Renames = []renameSelection{{ID: alias.ID, NewName: "format"}}
	if _, err := applyProjectRenames(request); err == nil || !strings.Contains(err.Error(), "would change a package binding") {
		t.Fatalf("rename capturing the import selector = %v; want binding-identity rejection", err)
	}
}

func TestProjectMethodRenameUpdatesSelectorsAcrossFilesAndPreservesBehavior(t *testing.T) {
	files := []projectFile{
		{Path: "pkg/model.go", Source: "package sample\ntype worker struct{}\nfunc (worker) normalize(value int) int { return value + 1 }\nfunc (worker) Normalize(value int) int { return value }\n"},
		{Path: "pkg/use.go", Source: "package sample\nfunc run() int { return worker{}.normalize(3) + worker.normalize(worker{}, 4) }\n"},
	}
	request := goProjectRequest(files, "pkg/model.go")
	catalog, err := buildProjectCatalog(request)
	if err != nil {
		t.Fatal(err)
	}
	var selected binding
	for _, item := range catalog.Bindings {
		if item.Name == "normalize" && item.Kind == "method" {
			selected = item
		}
		if item.Name == "Normalize" {
			t.Fatalf("exported method entered private rename catalog: %+v", item)
		}
	}
	if selected.ID == "" || selected.ScopeType != "member" || selected.ReferenceCount != 2 || len(selected.Uses) != 3 {
		t.Fatalf("receiver method binding = %+v; want a member binding with declaration and two selector uses", selected)
	}
	request.Operation = "project_rename"
	request.ExpectedHash, request.SourceSetHash = catalog.SelectedHash, catalog.SourceSetHash
	request.Renames = []renameSelection{{ID: selected.ID, NewName: "scale"}}
	assertProjectRenameBehavior(t, map[string]string{
		"pkg/model.go": files[0].Source,
		"pkg/use.go":   files[1].Source,
	}, "func TestCorpusBehavior(t *testing.T) { if got := run(); got != 9 { t.Fatalf(\"run = %d\", got) } }\n", "original")
	result, err := applyProjectRenames(request)
	if err != nil {
		t.Fatalf("rename receiver method: %v", err)
	}
	outputs := make(map[string]string)
	editCount := 0
	for _, file := range result["files"].([]map[string]any) {
		relativePath := file["relative_path"].(string)
		outputs[relativePath] = file["source_code"].(string)
		original := files[0].Source
		if relativePath == "pkg/use.go" {
			original = files[1].Source
		}
		for _, edit := range file["edits"].([]map[string]any) {
			if edit["old_text"] != "normalize" || edit["new_text"] != "scale" {
				t.Fatalf("method rename edit = %#v; want normalize -> scale", edit)
			}
			start, end := edit["start"].(int), edit["end"].(int)
			if start < 0 || end <= start || end > len(original) || original[start:end] != "normalize" {
				t.Fatalf("method rename edit has invalid byte span: %#v", edit)
			}
			editCount++
		}
	}
	if !strings.Contains(outputs["pkg/model.go"], "func (worker) scale(") || !strings.Contains(outputs["pkg/use.go"], "worker{}.scale(3) + worker.scale(worker{}, 4)") || editCount != 3 {
		t.Fatalf("method rename output/edits = %#v / %d; want declaration and two selector edits", outputs, editCount)
	}
	assertProjectRenameBehavior(t, outputs, "func TestCorpusBehavior(t *testing.T) { if got := run(); got != 9 { t.Fatalf(\"run = %d\", got) } }\n", "renamed")
}

func TestProjectMethodRenameRejectsReceiverMethodCollision(t *testing.T) {
	files := []projectFile{
		{Path: "pkg/model.go", Source: "package sample\ntype worker struct{}\nfunc (worker) normalize() int { return 1 }\nfunc (worker) scale() int { return 2 }\n"},
		{Path: "pkg/use.go", Source: "package sample\nfunc run() int { return worker{}.normalize() }\n"},
	}
	request := goProjectRequest(files, "pkg/model.go")
	catalog, err := buildProjectCatalog(request)
	if err != nil {
		t.Fatal(err)
	}
	var selected binding
	for _, item := range catalog.Bindings {
		if item.Name == "normalize" && item.Kind == "method" {
			selected = item
		}
	}
	if selected.ID == "" {
		t.Fatal("receiver method was not offered as a binding")
	}
	request.Operation = "project_rename"
	request.ExpectedHash, request.SourceSetHash = catalog.SelectedHash, catalog.SourceSetHash
	request.Renames = []renameSelection{{ID: selected.ID, NewName: "scale"}}
	if _, err := applyProjectRenames(request); err == nil || !strings.Contains(err.Error(), "method") {
		t.Fatalf("receiver method collision error = %v; want method collision rejection", err)
	}
}

func TestProjectMethodRenameRejectsPromotedMethodCollision(t *testing.T) {
	files := []projectFile{
		{Path: "pkg/model.go", Source: "package sample\ntype base struct{}\nfunc (base) scale() int { return 2 }\ntype worker struct { base }\nfunc (worker) normalize() int { return 1 }\n"},
		{Path: "pkg/use.go", Source: "package sample\nfunc run() int { return worker{}.normalize() }\n"},
	}
	request := goProjectRequest(files, "pkg/model.go")
	catalog, err := buildProjectCatalog(request)
	if err != nil {
		t.Fatal(err)
	}
	var selected binding
	for _, item := range catalog.Bindings {
		if item.Name == "normalize" && item.Kind == "method" {
			selected = item
			break
		}
	}
	if selected.ID == "" {
		t.Fatal("receiver method was not offered as a binding")
	}
	request.Operation = "project_rename"
	request.ExpectedHash, request.SourceSetHash = catalog.SelectedHash, catalog.SourceSetHash
	request.Renames = []renameSelection{{ID: selected.ID, NewName: "scale"}}
	if _, err := applyProjectRenames(request); err == nil || !strings.Contains(err.Error(), "method") {
		t.Fatalf("promoted receiver method collision error = %v; want method collision rejection", err)
	}
}

func TestProjectMethodRenamePreservesLocalInterfaceContracts(t *testing.T) {
	files := []projectFile{
		{Path: "pkg/model.go", Source: "package sample\ntype runner interface { normalize(int) int }\ntype worker struct{}\nfunc (worker) normalize(value int) int { return value + 1 }\n"},
		{Path: "pkg/use.go", Source: "package sample\nfunc viaInterface(value runner) int { return value.normalize(2) }\nfunc run() int { return viaInterface(worker{}) + worker{}.normalize(3) }\n"},
	}
	request := goProjectRequest(files, "pkg/model.go")
	catalog, err := buildProjectCatalog(request)
	if err != nil {
		t.Fatal(err)
	}
	var selected binding
	for _, item := range catalog.Bindings {
		if item.Name == "normalize" && item.Kind == "method" {
			selected = item
		}
	}
	if selected.ID == "" {
		t.Fatal("receiver method was not offered as a binding")
	}
	request.Operation = "project_rename"
	request.ExpectedHash, request.SourceSetHash = catalog.SelectedHash, catalog.SourceSetHash
	request.Renames = []renameSelection{{ID: selected.ID, NewName: "scale"}}
	if _, err := applyProjectRenames(request); err == nil {
		t.Fatal("renaming a concrete method broke the existing local interface contract")
	}
}

func TestProjectModuleMethodRenameUpdatesCrossPackageSelectorsAndExpressions(t *testing.T) {
	goMod := "module example.test/app\n\ngo 1.25\n"
	files := []projectFile{
		{Path: "pkg/model.go", Source: "package pkg\ntype Worker struct{}\nfunc (Worker) Normalize(value int) int { return value + 1 }\n"},
		{Path: "pkg/use.go", Source: "package pkg\nfunc local() int { return Worker{}.Normalize(2) }\n"},
		{Path: "cmd/run.go", Source: "package main\nimport \"example.test/app/pkg\"\nfunc Run() int { return pkg.Worker{}.Normalize(3) }\n"},
		{Path: "cmd/expression.go", Source: "package main\nimport \"example.test/app/pkg\"\nfunc Expression() int { return pkg.Worker.Normalize(pkg.Worker{}, 4) }\nfunc MethodValue() int { normalize := pkg.Worker{}.Normalize; return normalize(5) }\n"},
	}
	request := goProjectRequest(files, "pkg/model.go")
	request.Operation = "project_module_bindings"
	request.ModulePath, request.GoMod, request.GoModHash = "example.test/app", goMod, hashText(goMod)
	bindingsResult, err := listProjectModuleBindings(request)
	if err != nil {
		t.Fatalf("list module method bindings: %v", err)
	}
	var selected binding
	for _, raw := range bindingsResult["bindings"].([]map[string]any) {
		if raw["name"] == "Normalize" && raw["kind"] == "method" {
			selected = binding{
				ID: raw["id"].(string), Name: raw["name"].(string), Kind: raw["kind"].(string),
				ScopeType: raw["scopeType"].(string), FilePath: raw["relativePath"].(string),
				ReferenceCount: raw["referenceCount"].(int), Exported: raw["exported"].(bool),
			}
		}
	}
	if selected.ID == "" || selected.FilePath != "pkg/model.go" || selected.ReferenceCount != 4 || !selected.Exported {
		t.Fatalf("module method binding = %+v; want exported declaration and four references across three package files", selected)
	}
	if bindingsResult["scope"] != "verified-go-module-source-snapshot" || bindingsResult["source_set_sha256"] != hashProjectSources([]projectSourceFile{
		{Path: "pkg/model.go", Text: files[0].Source}, {Path: "pkg/use.go", Text: files[1].Source},
		{Path: "cmd/run.go", Text: files[2].Source}, {Path: "cmd/expression.go", Text: files[3].Source},
	}) {
		t.Fatalf("module binding snapshot = %#v", bindingsResult)
	}
	original := map[string]string{
		"pkg/model.go": files[0].Source, "pkg/use.go": files[1].Source,
		"cmd/run.go": files[2].Source, "cmd/expression.go": files[3].Source,
	}
	assertProjectModuleBehavior(t, original, goMod, "original")
	request.Operation = "project_module_rename"
	request.ExpectedHash = bindingsResult["source_sha256"].(string)
	request.SourceSetHash = bindingsResult["source_set_sha256"].(string)
	request.Renames = []renameSelection{{ID: selected.ID, NewName: "Scale"}}
	result, err := applyProjectModuleRenames(request)
	if err != nil {
		t.Fatalf("rename exported method across module packages: %v", err)
	}
	outputs := outputsBeforeRename(files)
	editCounts := make(map[string]int)
	for _, file := range result["files"].([]map[string]any) {
		filePath := file["relative_path"].(string)
		outputs[filePath] = file["source_code"].(string)
		for _, edit := range file["edits"].([]map[string]any) {
			start, end := edit["start"].(int), edit["end"].(int)
			if edit["old_text"] != "Normalize" || edit["new_text"] != "Scale" ||
				start < 0 || end <= start || end > len(original[filePath]) || original[filePath][start:end] != "Normalize" {
				t.Fatalf("module rename edit for %s = %#v; want exact Normalize -> Scale byte span", filePath, edit)
			}
			editCounts[filePath]++
		}
	}
	wantEditCounts := map[string]int{"pkg/model.go": 1, "pkg/use.go": 1, "cmd/run.go": 1, "cmd/expression.go": 2}
	if !reflect.DeepEqual(editCounts, wantEditCounts) || outputs["cmd/expression.go"] != "package main\nimport \"example.test/app/pkg\"\nfunc Expression() int { return pkg.Worker.Scale(pkg.Worker{}, 4) }\nfunc MethodValue() int { normalize := pkg.Worker{}.Scale; return normalize(5) }\n" {
		t.Fatalf("module outputs/edits = %#v / %#v; want four exact per-file edits", outputs, editCounts)
	}
	if result["source_set_sha256"] != bindingsResult["source_set_sha256"] || result["output_source_set_sha256"] == result["source_set_sha256"] {
		t.Fatalf("module source-set hashes = %v -> %v", result["source_set_sha256"], result["output_source_set_sha256"])
	}
	assertProjectModuleBehavior(t, outputs, goMod, "renamed")
}

func TestProjectModuleRenameUpdatesExplicitImportAlias(t *testing.T) {
	goMod := "module example.test/app\n\ngo 1.25\n"
	files := []projectFile{
		{Path: "pkg/strings.go", Source: "package pkg\nimport text \"strings\"\nfunc Join(a, b string) string { return text.Join([]string{a, b}, \"-\") }\n"},
		{Path: "pkg/use.go", Source: "package pkg\nfunc Run() string { return Join(\"a\", \"b\") }\n"},
		{Path: "cmd/run.go", Source: "package main\nimport \"example.test/app/pkg\"\nfunc Run() string { return pkg.Run() }\n"},
	}
	request := goProjectRequest(files, "pkg/strings.go")
	request.Operation = "project_module_bindings"
	request.ModulePath, request.GoMod, request.GoModHash = "example.test/app", goMod, hashText(goMod)
	bindingsResult, err := listProjectModuleBindings(request)
	if err != nil {
		t.Fatalf("list module bindings: %v", err)
	}
	var selected binding
	for _, raw := range bindingsResult["bindings"].([]map[string]any) {
		if raw["name"] == "text" {
			selected = binding{
				ID: raw["id"].(string), Name: raw["name"].(string), Kind: raw["kind"].(string),
				ScopeType: raw["scopeType"].(string), FilePath: raw["relativePath"].(string),
				ReferenceCount: raw["referenceCount"].(int), Exported: raw["exported"].(bool),
			}
		}
	}
	if selected.ID == "" || selected.Kind != "file import alias" || selected.ScopeType != "file" || selected.FilePath != "pkg/strings.go" || selected.ReferenceCount != 1 || selected.Exported {
		t.Fatalf("module import alias binding = %+v; want one resolved same-file use", selected)
	}
	original := map[string]string{"pkg/strings.go": files[0].Source, "pkg/use.go": files[1].Source, "cmd/run.go": files[2].Source}
	assertProjectModuleAliasBehavior(t, original, goMod, "original")
	request.Operation = "project_module_rename"
	request.ExpectedHash = bindingsResult["source_sha256"].(string)
	request.SourceSetHash = bindingsResult["source_set_sha256"].(string)
	request.Renames = []renameSelection{{ID: selected.ID, NewName: "strlib"}}
	result, err := applyProjectModuleRenames(request)
	if err != nil {
		t.Fatalf("rename module import alias: %v", err)
	}
	outputs := make(map[string]string)
	editCount := 0
	for _, file := range result["files"].([]map[string]any) {
		filePath := file["relative_path"].(string)
		outputs[filePath] = file["source_code"].(string)
		for _, edit := range file["edits"].([]map[string]any) {
			if edit["old_text"] != "text" || edit["new_text"] != "strlib" {
				t.Fatalf("module import alias edit = %#v; want text -> strlib", edit)
			}
			editCount++
		}
	}
	if len(outputs) != 1 || editCount != 2 || !strings.Contains(outputs["pkg/strings.go"], "import strlib \"strings\"") || !strings.Contains(outputs["pkg/strings.go"], "strlib.Join") {
		t.Fatalf("module import alias outputs/edits = %#v / %d; want only declaration file with two exact edits", outputs, editCount)
	}
	original["pkg/strings.go"] = outputs["pkg/strings.go"]
	assertProjectModuleAliasBehavior(t, original, goMod, "renamed")
}

func TestProjectModuleRenameUpdatesImportAliasesAcrossFiles(t *testing.T) {
	goMod := "module example.test/app\n\ngo 1.25\n"
	files := []projectFile{
		{Path: "pkg/strings.go", Source: "package pkg\nimport text \"strings\"\nfunc Run() string { return text.Join([]string{\"a\", \"b\"}, \"-\") }\n"},
		{Path: "pkg/use.go", Source: "package pkg\nfunc Other() string { return Run() }\n"},
		{Path: "cmd/run.go", Source: "package main\nimport (\"example.test/app/pkg\"; trim \"strings\")\nfunc RunCommand() string { return trim.TrimSpace(\" value \") + pkg.Run() }\n"},
	}
	request := goProjectRequest(files, "pkg/strings.go")
	request.Operation = "project_module_bindings"
	request.ModulePath, request.GoMod, request.GoModHash = "example.test/app", goMod, hashText(goMod)
	bindingsResult, err := listProjectModuleBindings(request)
	if err != nil {
		t.Fatalf("list module bindings: %v", err)
	}
	aliases := make(map[string]binding)
	for _, raw := range bindingsResult["bindings"].([]map[string]any) {
		if raw["kind"] != "file import alias" {
			continue
		}
		name := raw["name"].(string)
		aliases[name] = binding{
			ID: raw["id"].(string), Name: name, Kind: raw["kind"].(string),
			ScopeType: raw["scopeType"].(string), FilePath: raw["relativePath"].(string),
			ReferenceCount: raw["referenceCount"].(int),
		}
	}
	if aliases["text"].ID == "" || aliases["text"].FilePath != "pkg/strings.go" || aliases["text"].ReferenceCount != 1 ||
		aliases["trim"].ID == "" || aliases["trim"].FilePath != "cmd/run.go" || aliases["trim"].ReferenceCount != 1 {
		t.Fatalf("module import aliases = %#v; want reviewed aliases from the selected and command files", aliases)
	}
	original := map[string]string{
		"pkg/strings.go": files[0].Source, "pkg/use.go": files[1].Source, "cmd/run.go": files[2].Source,
	}
	assertProjectModuleAliasBehavior(t, original, goMod, "original")
	request.Operation = "project_module_rename"
	request.ExpectedHash = bindingsResult["source_sha256"].(string)
	request.SourceSetHash = bindingsResult["source_set_sha256"].(string)
	request.Renames = []renameSelection{
		{ID: aliases["text"].ID, NewName: "strlib"},
		{ID: aliases["trim"].ID, NewName: "trimutil"},
	}
	result, err := applyProjectModuleRenames(request)
	if err != nil {
		t.Fatalf("rename module import aliases across files: %v", err)
	}
	outputs := outputsBeforeRename(files)
	editCounts := make(map[string]int)
	for _, file := range result["files"].([]map[string]any) {
		filePath := file["relative_path"].(string)
		outputs[filePath] = file["source_code"].(string)
		for _, edit := range file["edits"].([]map[string]any) {
			oldName, newName := edit["old_text"], edit["new_text"]
			if !((oldName == "text" && newName == "strlib") || (oldName == "trim" && newName == "trimutil")) {
				t.Fatalf("module import alias edit = %#v; want one of the selected alias renames", edit)
			}
			editCounts[filePath]++
		}
	}
	if !reflect.DeepEqual(editCounts, map[string]int{"pkg/strings.go": 2, "cmd/run.go": 2}) ||
		!strings.Contains(outputs["pkg/strings.go"], "import strlib \"strings\"") ||
		!strings.Contains(outputs["cmd/run.go"], "trimutil \"strings\"") {
		t.Fatalf("cross-file alias outputs/edits = %#v / %#v; want declaration and use edits in two files", outputs, editCounts)
	}
	if result["source_set_sha256"] != bindingsResult["source_set_sha256"] || result["output_source_set_sha256"] == result["source_set_sha256"] {
		t.Fatalf("module source-set hashes = %v -> %v", result["source_set_sha256"], result["output_source_set_sha256"])
	}
	original["pkg/strings.go"] = outputs["pkg/strings.go"]
	original["cmd/run.go"] = outputs["cmd/run.go"]
	assertProjectModuleAliasBehavior(t, original, goMod, "renamed")
	request.Renames = []renameSelection{{ID: aliases["trim"].ID, NewName: "trimutil"}}
	unchangedSelected, err := applyProjectModuleRenames(request)
	if err != nil || unchangedSelected["source_code"] != files[0].Source {
		t.Fatalf("sibling-only alias rename result = %v, err=%v; want unchanged selected source", unchangedSelected, err)
	}
}

func TestProjectModuleImportAliasRenameRejectsLocalCapture(t *testing.T) {
	goMod := "module example.test/app\n\ngo 1.25\n"
	files := []projectFile{
		{Path: "pkg/use.go", Source: "package pkg\nimport old \"fmt\"\nfunc Run() string { format := struct { Sprint func(...any) string }{Sprint: func(...any) string { return \"local\" }}; _ = format; return old.Sprint(\"value\") }\nfunc Other() string { return old.Sprint(\"other\") }\n"},
		{Path: "pkg/sibling.go", Source: "package pkg\nfunc Sibling() {}\n"},
	}
	request := goProjectRequest(files, "pkg/use.go")
	request.ModulePath, request.GoMod, request.GoModHash = "example.test/app", goMod, hashText(goMod)
	bindingsResult, err := listProjectModuleBindings(request)
	if err != nil {
		t.Fatalf("list module bindings: %v", err)
	}
	var alias binding
	for _, raw := range bindingsResult["bindings"].([]map[string]any) {
		if raw["name"] == "old" {
			alias = binding{ID: raw["id"].(string), Name: "old", Kind: raw["kind"].(string), ScopeType: raw["scopeType"].(string), FilePath: raw["relativePath"].(string), ReferenceCount: raw["referenceCount"].(int)}
		}
	}
	if alias.ID == "" || alias.Kind != "file import alias" || alias.ReferenceCount != 2 {
		t.Fatalf("module import alias binding = %+v; want two resolved selectors", alias)
	}
	request.Operation = "project_module_rename"
	request.ExpectedHash = bindingsResult["source_sha256"].(string)
	request.SourceSetHash = bindingsResult["source_set_sha256"].(string)
	request.Renames = []renameSelection{{ID: alias.ID, NewName: "format"}}
	if _, err := applyProjectModuleRenames(request); err == nil || !strings.Contains(err.Error(), "would change a module binding") {
		t.Fatalf("rename capturing one import selector = %v; want binding-identity rejection", err)
	}
}

func TestProjectModuleImportAliasRenameRejectsAliasCollisions(t *testing.T) {
	goMod := "module example.test/app\n\ngo 1.25\n"
	files := []projectFile{{Path: "pkg/use.go", Source: "package pkg\nimport (first \"fmt\"; second \"strings\")\nfunc Run() string { return first.Sprint(second.TrimSpace(\" value \")) }\n"}}
	request := goProjectRequest(files, "pkg/use.go")
	request.ModulePath, request.GoMod, request.GoModHash = "example.test/app", goMod, hashText(goMod)
	bindingsResult, err := listProjectModuleBindings(request)
	if err != nil {
		t.Fatalf("list module bindings: %v", err)
	}
	aliases := make(map[string]binding)
	for _, raw := range bindingsResult["bindings"].([]map[string]any) {
		if raw["kind"] == "file import alias" {
			name := raw["name"].(string)
			aliases[name] = binding{ID: raw["id"].(string), Name: name, Kind: raw["kind"].(string), ScopeType: raw["scopeType"].(string), FilePath: raw["relativePath"].(string)}
		}
	}
	if aliases["first"].ID == "" || aliases["second"].ID == "" {
		t.Fatalf("module import aliases = %#v; want both explicit aliases", aliases)
	}
	request.Operation = "project_module_rename"
	request.ExpectedHash = bindingsResult["source_sha256"].(string)
	request.SourceSetHash = bindingsResult["source_set_sha256"].(string)
	request.Renames = []renameSelection{{ID: aliases["first"].ID, NewName: "second"}}
	if _, err := applyProjectModuleRenames(request); err == nil || !strings.Contains(err.Error(), "collide with an import alias") {
		t.Fatalf("rename onto an existing alias = %v; want import-scope collision rejection", err)
	}
	request.Renames = []renameSelection{
		{ID: aliases["first"].ID, NewName: "common"},
		{ID: aliases["second"].ID, NewName: "common"},
	}
	if _, err := applyProjectModuleRenames(request); err == nil || !strings.Contains(err.Error(), "cannot share a new name") {
		t.Fatalf("rename two aliases to one target = %v; want duplicate-target rejection", err)
	}
}

func assertProjectModuleAliasBehavior(t *testing.T, files map[string]string, goMod, variant string) {
	t.Helper()
	root, err := os.MkdirTemp("", "reamon-go-module-alias-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	if err := os.WriteFile(filepath.Join(root, "go.mod"), []byte(goMod), 0o600); err != nil {
		t.Fatalf("write %s module manifest: %v", variant, err)
	}
	if commandSource, ok := files["cmd/run.go"]; ok && strings.Contains(commandSource, "RunCommand") {
		commandTestPath := filepath.Join(root, "cmd", "alias_behavior_test.go")
		commandTest := "package main\nimport \"testing\"\nfunc TestCommandImportAliasBehavior(t *testing.T) { if got := RunCommand(); got != \"valuea-b\" { t.Fatalf(\"RunCommand() = %q\", got) } }\n"
		if err := os.MkdirAll(filepath.Dir(commandTestPath), 0o700); err != nil {
			t.Fatalf("create %s command behavior package: %v", variant, err)
		}
		if err := os.WriteFile(commandTestPath, []byte(commandTest), 0o600); err != nil {
			t.Fatalf("write %s command behavior oracle: %v", variant, err)
		}
	}
	for relative, source := range files {
		full := filepath.Join(root, filepath.FromSlash(relative))
		if err := os.MkdirAll(filepath.Dir(full), 0o700); err != nil {
			t.Fatalf("create %s fixture package: %v", variant, err)
		}
		if err := os.WriteFile(full, []byte(source), 0o600); err != nil {
			t.Fatalf("write %s fixture source: %v", variant, err)
		}
	}
	testPath := filepath.Join(root, "pkg", "alias_behavior_test.go")
	testSource := "package pkg\nimport \"testing\"\nfunc TestImportAliasBehavior(t *testing.T) { if got := Run(); got != \"a-b\" { t.Fatalf(\"Run() = %q\", got) } }\n"
	if err := os.WriteFile(testPath, []byte(testSource), 0o600); err != nil {
		t.Fatalf("write %s behavior oracle: %v", variant, err)
	}
	command := exec.Command("go", "test", "./...")
	command.Dir = root
	command.Env = append(os.Environ(), "GO111MODULE=on", "GOTOOLCHAIN=local", "GOSUMDB=off")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("%s module alias behavior oracle failed: %v\n%s", variant, err, output)
	}
}

func TestProjectModuleRenamePinnedGorillaMuxV181(t *testing.T) {
	renameManifestBytes, err := os.ReadFile(filepath.Join("testdata", "project_module_rename_holdout_v1.json"))
	if err != nil {
		t.Fatalf("read pinned module rename manifest: %v", err)
	}
	var renameCorpus projectModuleRenameCorpus
	if err := json.Unmarshal(renameManifestBytes, &renameCorpus); err != nil {
		t.Fatalf("parse pinned module rename manifest: %v", err)
	}
	if renameCorpus.Version != 1 || len(renameCorpus.Fixtures) != 2 {
		t.Fatalf("module rename corpus version/fixture count = %d/%d; want version 1 and two positive cases", renameCorpus.Version, len(renameCorpus.Fixtures))
	}
	for _, renameFixture := range renameCorpus.Fixtures {
		renameFixture := renameFixture
		t.Run(renameFixture.Name, func(t *testing.T) {
			assertPinnedGorillaMuxMethodRename(t, renameFixture)
		})
	}
}

func assertPinnedGorillaMuxMethodRename(t *testing.T, renameFixture projectModuleRenameFixture) {
	t.Helper()
	if renameFixture.Name == "" || len(renameFixture.Operations) != 1 || len(renameFixture.BuildContexts) != 3 || renameFixture.BehaviorRouterMethod == "" || renameFixture.BehaviorRouteMethod == "" {
		t.Fatalf("pinned module rename fixture = %+v; want one selected method and three build contexts", renameFixture)
	}
	sourceManifestBytes, err := os.ReadFile(filepath.Join("testdata", filepath.FromSlash(renameFixture.SourceManifest)))
	if err != nil {
		t.Fatalf("read source fixture manifest: %v", err)
	}
	var sourceCorpus projectInventoryRecallCorpus
	if err := json.Unmarshal(sourceManifestBytes, &sourceCorpus); err != nil {
		t.Fatalf("parse source fixture manifest: %v", err)
	}
	var fixture *projectInventoryRecallFixture
	for i := range sourceCorpus.Fixtures {
		if sourceCorpus.Fixtures[i].Name == renameFixture.SourceFixtureName {
			fixture = &sourceCorpus.Fixtures[i]
			break
		}
	}
	if fixture == nil || fixture.ModulePath != "github.com/gorilla/mux" || len(fixture.BuildContexts) != len(renameFixture.BuildContexts) {
		t.Fatalf("pinned source module fixture = %+v; want matching gorilla/mux build contexts", fixture)
	}
	sourceBuilds := make(map[string]bool, len(fixture.BuildContexts))
	for _, build := range fixture.BuildContexts {
		sourceBuilds[build.GOOS+"/"+build.GOARCH] = true
	}
	for _, build := range renameFixture.BuildContexts {
		if !sourceBuilds[build.GOOS+"/"+build.GOARCH] {
			t.Fatalf("rename build context %s/%s is not covered by the pinned source corpus", build.GOOS, build.GOARCH)
		}
	}
	goModBytes, err := os.ReadFile(filepath.Join("testdata", filepath.FromSlash(fixture.GoModFixture)))
	if err != nil {
		t.Fatalf("read pinned gorilla/mux go.mod: %v", err)
	}
	if hashText(string(goModBytes)) != fixture.GoModSHA256 {
		t.Fatalf("pinned gorilla/mux go.mod hash changed")
	}
	licenseBytes, err := os.ReadFile(filepath.Join("testdata", "project_inventory_holdout_v1", "gorilla_mux_v1_8_1_LICENSE"))
	if err != nil {
		t.Fatalf("read pinned gorilla/mux license: %v", err)
	}
	if hashText(string(licenseBytes)) != "0b77fdea862f869ef4f201ac5649bdbd38ccb055c7f6454dffae9e2adb4941c1" {
		t.Fatal("pinned gorilla/mux license hash changed")
	}
	files := make([]projectFile, 0, len(fixture.Files))
	for _, sourceFile := range fixture.Files {
		content, err := os.ReadFile(filepath.Join("testdata", filepath.FromSlash(sourceFile.FixturePath)))
		if err != nil {
			t.Fatalf("read pinned gorilla/mux source %s: %v", sourceFile.InventoryPath, err)
		}
		if hashText(string(content)) != sourceFile.SHA256 {
			t.Fatalf("pinned gorilla/mux source hash changed: %s", sourceFile.InventoryPath)
		}
		files = append(files, projectFile{Path: sourceFile.InventoryPath, Source: string(content)})
	}

	var linuxOutputs map[string]string
	for _, build := range renameFixture.BuildContexts {
		build := build
		t.Run(build.GOOS+"/"+build.GOARCH, func(t *testing.T) {
			request := goProjectRequest(files, renameFixture.SelectedPath)
			request.Operation = "project_module_bindings"
			request.ModulePath, request.GoMod, request.GoModHash = fixture.ModulePath, string(goModBytes), fixture.GoModSHA256
			request.BuildGOOS, request.BuildGOARCH = build.GOOS, build.GOARCH
			catalogResult, err := listProjectModuleBindings(request)
			if err != nil {
				t.Fatalf("catalog pinned gorilla/mux module: %v", err)
			}
			selectedOperations := make([]renameSelection, 0, len(renameFixture.Operations))
			expectedEditCounts := make(map[string]int)
			operationByOldName := make(map[string]projectModuleRenameOperation, len(renameFixture.Operations))
			for _, operation := range renameFixture.Operations {
				if operation.OldName == "" || operation.NewName == "" || operation.ExpectedReferences < 0 || len(operation.ExpectedEditsByFile) == 0 {
					t.Fatalf("invalid pinned rename operation: %+v", operation)
				}
				var selected binding
				for _, raw := range catalogResult["bindings"].([]map[string]any) {
					if raw["name"] == operation.OldName && raw["relativePath"] == operation.SelectedPath {
						selected = binding{ID: raw["id"].(string), Name: operation.OldName, ReferenceCount: raw["referenceCount"].(int), Exported: raw["exported"].(bool)}
						break
					}
				}
				if selected.ID == "" || !selected.Exported {
					t.Fatalf("pinned %s binding = %+v; want exported receiver method", operation.OldName, selected)
				}
				if selected.ReferenceCount != operation.ExpectedReferences {
					t.Fatalf("%s %s reference count = %d; want %d", build.GOOS, operation.OldName, selected.ReferenceCount, operation.ExpectedReferences)
				}
				if _, exists := operationByOldName[operation.OldName]; exists {
					t.Fatalf("duplicate pinned rename operation for %s", operation.OldName)
				}
				operationByOldName[operation.OldName] = operation
				selectedOperations = append(selectedOperations, renameSelection{ID: selected.ID, NewName: operation.NewName})
				for filePath, count := range operation.ExpectedEditsByFile {
					expectedEditCounts[filePath] += count
				}
				t.Logf("pinned %s has %d resolved in-module references", operation.OldName, selected.ReferenceCount)
			}

			request.Operation = "project_module_rename"
			request.ExpectedHash = catalogResult["source_sha256"].(string)
			request.SourceSetHash = catalogResult["source_set_sha256"].(string)
			request.Renames = selectedOperations
			result, err := applyProjectModuleRenames(request)
			if err != nil {
				t.Fatalf("rename pinned gorilla/mux methods: %v", err)
			}
			renamedBindings := result["renamed_bindings"].([]map[string]any)
			if len(renamedBindings) != len(renameFixture.Operations) {
				t.Fatalf("pinned rename disclosures = %#v; want %d exported methods", renamedBindings, len(renameFixture.Operations))
			}
			for _, renamed := range renamedBindings {
				operation, ok := operationByOldName[renamed["oldName"].(string)]
				if !ok || renamed["newName"] != operation.NewName || renamed["exported"] != true {
					t.Fatalf("pinned rename disclosure = %#v; want a configured exported method rename", renamed)
				}
			}
			outputs := outputsBeforeRename(files)
			editCounts := make(map[string]int)
			sourceByPath := filesByPath(files)
			for _, output := range result["files"].([]map[string]any) {
				filePath := output["relative_path"].(string)
				outputs[filePath] = output["source_code"].(string)
				for _, edit := range output["edits"].([]map[string]any) {
					start, startOK := edit["start"].(int)
					end, endOK := edit["end"].(int)
					oldName, oldOK := edit["old_text"].(string)
					operation, configured := operationByOldName[oldName]
					if !oldOK || !configured || edit["new_text"] != operation.NewName || !startOK || !endOK || start < 0 || end > len(sourceByPath[filePath]) || sourceByPath[filePath][start:end] != oldName {
						t.Fatalf("pinned edit for %s = %#v; want a configured exact byte-span rename", filePath, edit)
					}
					editCounts[filePath]++
				}
			}
			if !reflect.DeepEqual(editCounts, expectedEditCounts) {
				t.Fatalf("pinned per-file edit counts = %#v; want %#v", editCounts, expectedEditCounts)
			}
			if build.GOOS == "linux" {
				linuxOutputs = outputs
			}
		})
	}
	if linuxOutputs == nil {
		t.Fatal("pinned Linux module rename did not produce a measurable result")
	}
	assertGorillaModuleBehavior(t, outputsBeforeRename(files), string(goModBytes), renameFixture.BehaviorRouterMethod, renameFixture.BehaviorRouteMethod, "original")
	renamedRouterMethod, renamedRouteMethod := renameFixture.BehaviorRouterMethod, renameFixture.BehaviorRouteMethod
	for _, operation := range renameFixture.Operations {
		if operation.OldName == renamedRouterMethod {
			renamedRouterMethod = operation.NewName
		}
		if operation.OldName == renamedRouteMethod {
			renamedRouteMethod = operation.NewName
		}
	}
	assertGorillaModuleBehavior(t, linuxOutputs, string(goModBytes), renamedRouterMethod, renamedRouteMethod, "renamed")
}

func TestProjectModuleRenamePinnedChiContextReset(t *testing.T) {
	manifestBytes, err := os.ReadFile(filepath.Join("testdata", "project_inventory_holdout_v1.json"))
	if err != nil {
		t.Fatalf("read pinned chi source manifest: %v", err)
	}
	var sourceCorpus projectInventoryRecallCorpus
	if err := json.Unmarshal(manifestBytes, &sourceCorpus); err != nil {
		t.Fatalf("parse pinned chi source manifest: %v", err)
	}
	var fixture *projectInventoryRecallFixture
	for i := range sourceCorpus.Fixtures {
		if sourceCorpus.Fixtures[i].Name == "chi-v5.2.1" {
			fixture = &sourceCorpus.Fixtures[i]
			break
		}
	}
	if fixture == nil || fixture.ModulePath != "github.com/go-chi/chi/v5" || len(fixture.BuildContexts) != 3 {
		t.Fatalf("pinned chi source fixture = %+v; want v5.2.1 and three build contexts", fixture)
	}
	goModBytes, err := os.ReadFile(filepath.Join("testdata", filepath.FromSlash(fixture.GoModFixture)))
	if err != nil {
		t.Fatalf("read pinned chi go.mod: %v", err)
	}
	if hashText(string(goModBytes)) != fixture.GoModSHA256 {
		t.Fatal("pinned chi go.mod hash changed")
	}
	licenseBytes, err := os.ReadFile(filepath.Join("testdata", "upstream_chi_v5_2_1", "LICENSE"))
	if err != nil {
		t.Fatalf("read pinned chi license: %v", err)
	}
	if hashText(string(licenseBytes)) != "37808a0b0de20e89268beac2d5cd0443646640025d66669574ad71c2abf72d4c" {
		t.Fatal("pinned chi license hash changed")
	}
	files := make([]projectFile, 0, len(fixture.Files))
	for _, sourceFile := range fixture.Files {
		content, err := os.ReadFile(filepath.Join("testdata", filepath.FromSlash(sourceFile.FixturePath)))
		if err != nil {
			t.Fatalf("read pinned chi source %s: %v", sourceFile.InventoryPath, err)
		}
		if hashText(string(content)) != sourceFile.SHA256 {
			t.Fatalf("pinned chi source hash changed: %s", sourceFile.InventoryPath)
		}
		files = append(files, projectFile{Path: sourceFile.InventoryPath, Source: string(content)})
	}

	var linuxOutputs map[string]string
	for _, build := range fixture.BuildContexts {
		build := build
		t.Run(build.GOOS+"/"+build.GOARCH, func(t *testing.T) {
			request := goProjectRequest(files, "context.go")
			request.Operation = "project_module_bindings"
			request.ModulePath, request.GoMod, request.GoModHash = fixture.ModulePath, string(goModBytes), fixture.GoModSHA256
			request.BuildGOOS, request.BuildGOARCH = build.GOOS, build.GOARCH
			catalogResult, err := listProjectModuleBindings(request)
			if err != nil {
				t.Fatalf("catalog pinned chi module: %v", err)
			}
			var selected binding
			for _, raw := range catalogResult["bindings"].([]map[string]any) {
				if raw["name"] == "Reset" && raw["relativePath"] == "context.go" {
					selected = binding{ID: raw["id"].(string), Name: "Reset", ReferenceCount: raw["referenceCount"].(int), Exported: raw["exported"].(bool)}
					break
				}
			}
			if selected.ID == "" || !selected.Exported || selected.ReferenceCount != 1 {
				t.Fatalf("pinned chi Context.Reset binding = %+v; want exported method with one in-module reference", selected)
			}

			request.Operation = "project_module_rename"
			request.ExpectedHash = catalogResult["source_sha256"].(string)
			request.SourceSetHash = catalogResult["source_set_sha256"].(string)
			request.Renames = []renameSelection{{ID: selected.ID, NewName: "Clear"}}
			result, err := applyProjectModuleRenames(request)
			if err != nil {
				t.Fatalf("rename pinned chi Context.Reset: %v", err)
			}
			renamedBindings := result["renamed_bindings"].([]map[string]any)
			if len(renamedBindings) != 1 || renamedBindings[0]["oldName"] != "Reset" || renamedBindings[0]["newName"] != "Clear" || renamedBindings[0]["exported"] != true {
				t.Fatalf("pinned chi rename disclosure = %#v; want exported Reset to Clear", renamedBindings)
			}
			outputs := outputsBeforeRename(files)
			sourceByPath := filesByPath(files)
			editCounts := make(map[string]int)
			for _, output := range result["files"].([]map[string]any) {
				filePath := output["relative_path"].(string)
				outputs[filePath] = output["source_code"].(string)
				for _, edit := range output["edits"].([]map[string]any) {
					start, startOK := edit["start"].(int)
					end, endOK := edit["end"].(int)
					if edit["old_text"] != "Reset" || edit["new_text"] != "Clear" || !startOK || !endOK || start < 0 || end > len(sourceByPath[filePath]) || sourceByPath[filePath][start:end] != "Reset" {
						t.Fatalf("pinned chi edit for %s = %#v; want exact Reset to Clear byte span", filePath, edit)
					}
					editCounts[filePath]++
				}
			}
			if !reflect.DeepEqual(editCounts, map[string]int{"context.go": 1, "mux.go": 1}) {
				t.Fatalf("pinned chi exact edits by file = %#v; want context.go and mux.go once each", editCounts)
			}

			contractRequest := goProjectRequest(files, "mux.go")
			contractRequest.Operation = "project_module_bindings"
			contractRequest.ModulePath, contractRequest.GoMod, contractRequest.GoModHash = fixture.ModulePath, string(goModBytes), fixture.GoModSHA256
			contractRequest.BuildGOOS, contractRequest.BuildGOARCH = build.GOOS, build.GOARCH
			contractCatalog, err := listProjectModuleBindings(contractRequest)
			if err != nil {
				t.Fatalf("catalog pinned chi local interface contract: %v", err)
			}
			var methodBinding binding
			for _, raw := range contractCatalog["bindings"].([]map[string]any) {
				if raw["name"] == "Method" && raw["relativePath"] == "mux.go" {
					methodBinding = binding{ID: raw["id"].(string), Name: "Method", ReferenceCount: raw["referenceCount"].(int), Exported: raw["exported"].(bool)}
					break
				}
			}
			if methodBinding.ID == "" || !methodBinding.Exported || methodBinding.ReferenceCount != 3 {
				t.Fatalf("pinned chi Mux.Method binding = %+v; want exported method with three in-module references", methodBinding)
			}
			contractRequest.Operation = "project_module_rename"
			contractRequest.ExpectedHash = contractCatalog["source_sha256"].(string)
			contractRequest.SourceSetHash = contractCatalog["source_set_sha256"].(string)
			contractRequest.Renames = []renameSelection{{ID: methodBinding.ID, NewName: "Register"}}
			if _, err := applyProjectModuleRenames(contractRequest); err == nil || !strings.Contains(err.Error(), "does not implement Router") {
				t.Fatalf("pinned chi Mux.Method interface-contract rename error = %v; want rejection because Mux would stop implementing Router", err)
			}
			if build.GOOS == "linux" {
				linuxOutputs = outputs
			}
		})
	}
	if linuxOutputs == nil {
		t.Fatal("pinned Linux chi rename did not produce outputs")
	}
	assertChiContextResetBehavior(t, filesByPath(files), string(goModBytes), "original")
	assertChiContextResetBehavior(t, linuxOutputs, string(goModBytes), "renamed")
	assertChiResetDownstreamCompatibility(t, filesByPath(files), string(goModBytes), "original", true)
	assertChiResetDownstreamCompatibility(t, linuxOutputs, string(goModBytes), "renamed", false)
}

func assertChiContextResetBehavior(t *testing.T, files map[string]string, goMod, variant string) {
	t.Helper()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "go.mod"), []byte(goMod), 0o600); err != nil {
		t.Fatalf("write pinned chi %s go.mod: %v", variant, err)
	}
	for filePath, source := range files {
		if err := os.WriteFile(filepath.Join(root, filepath.Base(filePath)), []byte(source), 0o600); err != nil {
			t.Fatalf("write pinned chi %s source %s: %v", variant, filePath, err)
		}
	}
	testSource := "package chi_test\nimport (\"net/http\"; \"net/http/httptest\"; \"testing\"; \"github.com/go-chi/chi/v5\")\nfunc TestHeldOutChiRouteBehavior(t *testing.T) { router := chi.NewRouter(); router.Get(\"/users/{name}\", func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(chi.URLParam(r, \"name\"))) }); response := httptest.NewRecorder(); router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, \"/users/alice\", nil)); if response.Code != http.StatusOK || response.Body.String() != \"alice\" { t.Fatalf(\"route behavior changed: %d %q\", response.Code, response.Body.String()) } }\n"
	if err := os.WriteFile(filepath.Join(root, "module_rename_test.go"), []byte(testSource), 0o600); err != nil {
		t.Fatalf("write pinned chi %s behavior oracle: %v", variant, err)
	}
	command := exec.Command("go", "test", "./...")
	command.Dir = root
	command.Env = append(os.Environ(), "GO111MODULE=on", "GOTOOLCHAIN=local", "GOWORK=off", "GOPROXY=off", "GOSUMDB=off")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("pinned chi %s behavior oracle failed: %v\n%s", variant, err, output)
	}
}

func assertChiResetDownstreamCompatibility(t *testing.T, files map[string]string, goMod, variant string, wantCompile bool) {
	t.Helper()
	root := t.TempDir()
	moduleRoot := filepath.Join(root, "chi")
	consumerRoot := filepath.Join(root, "consumer")
	if err := os.MkdirAll(moduleRoot, 0o700); err != nil {
		t.Fatalf("create pinned chi %s module: %v", variant, err)
	}
	if err := os.MkdirAll(consumerRoot, 0o700); err != nil {
		t.Fatalf("create pinned chi %s consumer: %v", variant, err)
	}
	if err := os.WriteFile(filepath.Join(moduleRoot, "go.mod"), []byte(goMod), 0o600); err != nil {
		t.Fatalf("write pinned chi %s go.mod: %v", variant, err)
	}
	for filePath, source := range files {
		if err := os.WriteFile(filepath.Join(moduleRoot, filepath.Base(filePath)), []byte(source), 0o600); err != nil {
			t.Fatalf("write pinned chi %s source %s: %v", variant, filePath, err)
		}
	}
	consumerModule := "module example.test/chi-consumer\n\ngo 1.20\n\nrequire github.com/go-chi/chi/v5 v5.2.1\nreplace github.com/go-chi/chi/v5 => ../chi\n"
	if err := os.WriteFile(filepath.Join(consumerRoot, "go.mod"), []byte(consumerModule), 0o600); err != nil {
		t.Fatalf("write pinned chi %s consumer go.mod: %v", variant, err)
	}
	consumerSource := "package consumer_test\nimport \"github.com/go-chi/chi/v5\"\nfunc usePublicReset() { chi.NewRouteContext().Reset() }\n"
	if err := os.WriteFile(filepath.Join(consumerRoot, "consumer_test.go"), []byte(consumerSource), 0o600); err != nil {
		t.Fatalf("write pinned chi %s downstream consumer: %v", variant, err)
	}
	command := exec.Command("go", "test", "./...")
	command.Dir = consumerRoot
	command.Env = append(os.Environ(), "GO111MODULE=on", "GOTOOLCHAIN=local", "GOWORK=off", "GOPROXY=off", "GOSUMDB=off")
	output, err := command.CombinedOutput()
	if wantCompile && err != nil {
		t.Fatalf("pinned chi %s downstream consumer failed unexpectedly: %v\n%s", variant, err, output)
	}
	if !wantCompile && (err == nil || !strings.Contains(string(output), "Reset undefined")) {
		t.Fatalf("pinned chi %s downstream compatibility result = %v\n%s; want compile failure identifying the removed Reset API", variant, err, output)
	}
}

func TestProjectModuleRenamePinnedHttprouterV130(t *testing.T) {
	manifestBytes, err := os.ReadFile(filepath.Join("testdata", "project_inventory_holdout_v1.json"))
	if err != nil {
		t.Fatalf("read pinned httprouter source manifest: %v", err)
	}
	var sourceCorpus projectInventoryRecallCorpus
	if err := json.Unmarshal(manifestBytes, &sourceCorpus); err != nil {
		t.Fatalf("parse pinned httprouter source manifest: %v", err)
	}
	var fixture *projectInventoryRecallFixture
	for i := range sourceCorpus.Fixtures {
		if sourceCorpus.Fixtures[i].Name == "httprouter-v1.3.0" {
			fixture = &sourceCorpus.Fixtures[i]
			break
		}
	}
	if fixture == nil || fixture.ModulePath != "github.com/julienschmidt/httprouter" || len(fixture.BuildContexts) != 3 {
		t.Fatalf("pinned httprouter fixture = %+v; want v1.3.0 and three build contexts", fixture)
	}
	goModBytes, err := os.ReadFile(filepath.Join("testdata", filepath.FromSlash(fixture.GoModFixture)))
	if err != nil {
		t.Fatalf("read pinned httprouter go.mod: %v", err)
	}
	if hashText(string(goModBytes)) != fixture.GoModSHA256 {
		t.Fatal("pinned httprouter go.mod hash changed")
	}
	licenseBytes, err := os.ReadFile(filepath.Join("testdata", "upstream_httprouter_v1_3_0", "LICENSE"))
	if err != nil {
		t.Fatalf("read pinned httprouter license: %v", err)
	}
	if hashText(string(licenseBytes)) != "be2fba5f724dac799186e37da036d172c6e20a9ffbeff35f99473141d4b85463" {
		t.Fatal("pinned httprouter license hash changed")
	}
	files := make([]projectFile, 0, len(fixture.Files))
	for _, sourceFile := range fixture.Files {
		content, err := os.ReadFile(filepath.Join("testdata", filepath.FromSlash(sourceFile.FixturePath)))
		if err != nil {
			t.Fatalf("read pinned httprouter source %s: %v", sourceFile.InventoryPath, err)
		}
		if hashText(string(content)) != sourceFile.SHA256 {
			t.Fatalf("pinned httprouter source hash changed: %s", sourceFile.InventoryPath)
		}
		files = append(files, projectFile{Path: sourceFile.InventoryPath, Source: string(content)})
	}

	var linuxOutputs map[string]string
	for _, build := range fixture.BuildContexts {
		build := build
		t.Run(build.GOOS+"/"+build.GOARCH, func(t *testing.T) {
			request := goProjectRequest(files, "router.go")
			request.Operation = "project_module_bindings"
			request.ModulePath, request.GoMod, request.GoModHash = fixture.ModulePath, string(goModBytes), fixture.GoModSHA256
			request.BuildGOOS, request.BuildGOARCH = build.GOOS, build.GOARCH
			catalogResult, err := listProjectModuleBindings(request)
			if err != nil {
				t.Fatalf("catalog pinned httprouter module: %v", err)
			}
			var selected binding
			for _, raw := range catalogResult["bindings"].([]map[string]any) {
				if raw["name"] == "Handle" && raw["relativePath"] == "router.go" {
					selected = binding{ID: raw["id"].(string), Name: "Handle", ReferenceCount: raw["referenceCount"].(int), Exported: raw["exported"].(bool)}
					break
				}
			}
			if selected.ID == "" || !selected.Exported || selected.ReferenceCount != 8 {
				t.Fatalf("pinned Handle binding = %+v; want exported declaration and eight resolved in-module references", selected)
			}

			request.Operation = "project_module_rename"
			request.ExpectedHash = catalogResult["source_sha256"].(string)
			request.SourceSetHash = catalogResult["source_set_sha256"].(string)
			request.Renames = []renameSelection{{ID: selected.ID, NewName: "Register"}}
			result, err := applyProjectModuleRenames(request)
			if err != nil {
				t.Fatalf("rename pinned httprouter Handle: %v", err)
			}
			renamedBindings := result["renamed_bindings"].([]map[string]any)
			if len(renamedBindings) != 1 || renamedBindings[0]["oldName"] != "Handle" || renamedBindings[0]["newName"] != "Register" || renamedBindings[0]["exported"] != true {
				t.Fatalf("pinned httprouter rename disclosure = %#v; want exported Handle -> Register", renamedBindings)
			}
			outputs := outputsBeforeRename(files)
			type expectedEdit struct {
				start, end int
				newText    string
			}
			editCounts := make(map[string]int)
			editsByFile := make(map[string][]expectedEdit)
			sourceByPath := filesByPath(files)
			for _, output := range result["files"].([]map[string]any) {
				filePath := output["relative_path"].(string)
				outputs[filePath] = output["source_code"].(string)
				source, exists := sourceByPath[filePath]
				if !exists {
					t.Fatalf("pinned httprouter returned an edit for unknown file %s", filePath)
				}
				for _, edit := range output["edits"].([]map[string]any) {
					start, startOK := edit["start"].(int)
					end, endOK := edit["end"].(int)
					if edit["old_text"] != "Handle" || edit["new_text"] != "Register" || !startOK || !endOK || start < 0 || end < start || end > len(source) || source[start:end] != "Handle" {
						t.Fatalf("pinned httprouter edit for %s = %#v; want exact Handle -> Register byte span", filePath, edit)
					}
					editCounts[filePath]++
					editsByFile[filePath] = append(editsByFile[filePath], expectedEdit{start: start, end: end, newText: "Register"})
				}
			}
			if !reflect.DeepEqual(editCounts, map[string]int{"router.go": 9}) {
				t.Fatalf("pinned httprouter edits by file = %#v; want exactly nine edits in router.go and none elsewhere", editCounts)
			}
			for filePath, edits := range editsByFile {
				original := []byte(sourceByPath[filePath])
				for i := 1; i < len(edits); i++ {
					for j := i; j > 0 && edits[j].start > edits[j-1].start; j-- {
						edits[j], edits[j-1] = edits[j-1], edits[j]
					}
				}
				expected := append([]byte(nil), original...)
				for _, edit := range edits {
					expected = append(expected[:edit.start], append([]byte(edit.newText), expected[edit.end:]...)...)
				}
				if outputs[filePath] != string(expected) {
					t.Fatalf("pinned httprouter output for %s contains changes outside the nine reported Handle edits", filePath)
				}
			}
			if build.GOOS == "linux" && build.GOARCH == "amd64" {
				linuxOutputs = outputs
			}
		})
	}
	if linuxOutputs == nil {
		t.Fatal("pinned Linux/amd64 httprouter rename did not produce outputs")
	}
	assertHttprouterModuleBehavior(t, outputsBeforeRename(files), string(goModBytes), "Handle", "original")
	assertHttprouterModuleBehavior(t, linuxOutputs, string(goModBytes), "Register", "renamed")
}

func assertHttprouterModuleBehavior(t *testing.T, files map[string]string, goMod, methodName, variant string) {
	t.Helper()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "go.mod"), []byte(goMod), 0o600); err != nil {
		t.Fatalf("write pinned httprouter %s go.mod: %v", variant, err)
	}
	for filePath, source := range files {
		fullPath := filepath.Join(root, filepath.FromSlash(filePath))
		if err := os.MkdirAll(filepath.Dir(fullPath), 0o700); err != nil {
			t.Fatalf("create pinned httprouter %s source directory: %v", variant, err)
		}
		if err := os.WriteFile(fullPath, []byte(source), 0o600); err != nil {
			t.Fatalf("write pinned httprouter %s source: %v", variant, err)
		}
	}
	testSource := fmt.Sprintf("package httprouter\nimport (\"net/http\"; \"net/http/httptest\"; \"testing\")\nfunc TestHeldOutModuleRenameBehavior(t *testing.T) { router := New(); router.%s(http.MethodGet, \"/user/:name\", func(w http.ResponseWriter, _ *http.Request, params Params) { _, _ = w.Write([]byte(params.ByName(\"name\"))) }); response := httptest.NewRecorder(); router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, \"/user/alice\", nil)); if response.Code != http.StatusOK || response.Body.String() != \"alice\" { t.Fatalf(\"route behavior changed: %%d %%q\", response.Code, response.Body.String()) } }\n", methodName)
	if err := os.WriteFile(filepath.Join(root, "module_rename_test.go"), []byte(testSource), 0o600); err != nil {
		t.Fatalf("write pinned httprouter %s behavior oracle: %v", variant, err)
	}
	command := exec.Command("go", "test", "./...")
	command.Dir = root
	command.Env = append(os.Environ(), "GO111MODULE=on", "GOTOOLCHAIN=local", "GOWORK=off", "GOPROXY=off", "GOSUMDB=off")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("pinned httprouter %s behavior oracle failed: %v\n%s", variant, err, output)
	}
}

func TestProjectModuleRenamePinnedGoogleUUIDPreservesStandardInterfaces(t *testing.T) {
	manifestBytes, err := os.ReadFile(filepath.Join("testdata", "project_module_rename_holdout_v1.json"))
	if err != nil {
		t.Fatalf("read pinned module rename manifest: %v", err)
	}
	var renameCorpus projectModuleRenameCorpus
	if err := json.Unmarshal(manifestBytes, &renameCorpus); err != nil {
		t.Fatalf("parse pinned module rename manifest: %v", err)
	}
	if renameCorpus.Version != 1 || len(renameCorpus.RejectCases) < 1 {
		t.Fatalf("module rename corpus version/rejection count = %d/%d; want version 1 and at least one rejection", renameCorpus.Version, len(renameCorpus.RejectCases))
	}
	for _, rejectFixture := range renameCorpus.RejectCases {
		rejectFixture := rejectFixture
		t.Run(rejectFixture.Name, func(t *testing.T) {
			assertPinnedGoogleUUIDInterfaceRenameRejected(t, rejectFixture)
		})
	}
}

func assertPinnedGoogleUUIDInterfaceRenameRejected(t *testing.T, rejectFixture projectModuleRenameRejectFixture) {
	t.Helper()
	if rejectFixture.ExpectedError == "" || rejectFixture.ExpectedReferences < 1 || rejectFixture.Declaration == "" || len(rejectFixture.BuildContexts) != 3 {
		t.Fatalf("pinned interface rejection fixture = %+v; want declaration, references, and three build contexts", rejectFixture)
	}
	sourceManifestBytes, err := os.ReadFile(filepath.Join("testdata", filepath.FromSlash(rejectFixture.SourceManifest)))
	if err != nil {
		t.Fatalf("read pinned UUID source manifest: %v", err)
	}
	var sourceCorpus projectInventoryCorpus
	if err := json.Unmarshal(sourceManifestBytes, &sourceCorpus); err != nil {
		t.Fatalf("parse pinned UUID source manifest: %v", err)
	}
	var fixture *projectInventoryFixture
	for i := range sourceCorpus.Fixtures {
		if sourceCorpus.Fixtures[i].Name == rejectFixture.SourceFixtureName {
			fixture = &sourceCorpus.Fixtures[i]
			break
		}
	}
	if fixture == nil || fixture.ModulePath != "github.com/google/uuid" {
		t.Fatalf("pinned UUID module fixture = %+v", fixture)
	}
	files := make([]projectFile, 0, len(fixture.Files))
	var selectedSource string
	for _, sourceFile := range fixture.Files {
		content, err := os.ReadFile(filepath.Join("testdata", filepath.FromSlash(sourceFile.FixturePath)))
		if err != nil {
			t.Fatalf("read pinned UUID source %s: %v", sourceFile.InventoryPath, err)
		}
		if hashText(string(content)) != sourceFile.SHA256 {
			t.Fatalf("pinned UUID source hash changed: %s", sourceFile.InventoryPath)
		}
		files = append(files, projectFile{Path: sourceFile.InventoryPath, Source: string(content)})
		if sourceFile.InventoryPath == rejectFixture.SelectedPath {
			selectedSource = string(content)
		}
	}
	declarationOffset := strings.Index(selectedSource, rejectFixture.Declaration)
	nameOffset := strings.Index(rejectFixture.Declaration, rejectFixture.OldName)
	if selectedSource == "" || declarationOffset < 0 || nameOffset < 0 {
		t.Fatalf("pinned UUID source does not contain declaration %q", rejectFixture.Declaration)
	}
	declarationOffset += nameOffset
	for _, build := range rejectFixture.BuildContexts {
		build := build
		t.Run(build.GOOS+"/"+build.GOARCH, func(t *testing.T) {
			request := goProjectRequest(files, rejectFixture.SelectedPath)
			request.Operation = "project_module_bindings"
			request.ModulePath, request.GoMod = fixture.ModulePath, fixture.GoMod
			request.GoModHash = hashText(fixture.GoMod)
			request.BuildGOOS, request.BuildGOARCH = build.GOOS, build.GOARCH
			catalogResult, err := listProjectModuleBindings(request)
			if err != nil {
				t.Fatalf("catalog pinned UUID module: %v", err)
			}
			var selected binding
			for _, raw := range catalogResult["bindings"].([]map[string]any) {
				if raw["name"] == rejectFixture.OldName && raw["relativePath"] == rejectFixture.SelectedPath && raw["declarationStart"] == declarationOffset {
					selected = binding{ID: raw["id"].(string), Name: rejectFixture.OldName, ReferenceCount: raw["referenceCount"].(int), Exported: raw["exported"].(bool)}
					break
				}
			}
			if selected.ID == "" || !selected.Exported || selected.ReferenceCount != rejectFixture.ExpectedReferences {
				t.Fatalf("pinned UUID interface method binding = %+v; want %d in-module references", selected, rejectFixture.ExpectedReferences)
			}
			request.Operation = "project_module_rename"
			request.ExpectedHash = catalogResult["source_sha256"].(string)
			request.SourceSetHash = catalogResult["source_set_sha256"].(string)
			request.Renames = []renameSelection{{ID: selected.ID, NewName: rejectFixture.NewName}}
			if _, err := applyProjectModuleRenames(request); err == nil || !strings.Contains(err.Error(), rejectFixture.ExpectedError) {
				t.Fatalf("%s rename error = %v; want %q", build.GOOS+"/"+build.GOARCH, err, rejectFixture.ExpectedError)
			}
		})
	}
}

func filesByPath(files []projectFile) map[string]string {
	byPath := make(map[string]string, len(files))
	for _, file := range files {
		byPath[file.Path] = file.Source
	}
	return byPath
}

func assertGorillaModuleBehavior(t *testing.T, files map[string]string, goMod, routerMethodName, routeMethodName, variant string) {
	t.Helper()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "go.mod"), []byte(goMod), 0o600); err != nil {
		t.Fatalf("write pinned gorilla/mux %s go.mod: %v", variant, err)
	}
	for filePath, source := range files {
		fullPath := filepath.Join(root, filepath.FromSlash(filePath))
		if err := os.MkdirAll(filepath.Dir(fullPath), 0o700); err != nil {
			t.Fatalf("create pinned gorilla/mux %s source directory: %v", variant, err)
		}
		if err := os.WriteFile(fullPath, []byte(source), 0o600); err != nil {
			t.Fatalf("write pinned gorilla/mux %s source: %v", variant, err)
		}
	}
	testSource := fmt.Sprintf("package mux\nimport (\"net/http/httptest\"; \"testing\")\nfunc TestHeldOutModuleRenameBehavior(t *testing.T) { router := NewRouter(); router.%s().%s(\"/api/{id:[0-9]+}\").Methods(\"GET\"); match := &RouteMatch{}; if !router.Match(httptest.NewRequest(\"GET\", \"/api/42\", nil), match) || match.Vars[\"id\"] != \"42\" { t.Fatalf(\"route behavior changed: %%+v\", match) } }\n", routerMethodName, routeMethodName)
	if err := os.WriteFile(filepath.Join(root, "module_rename_test.go"), []byte(testSource), 0o600); err != nil {
		t.Fatalf("write pinned gorilla/mux %s behavior oracle: %v", variant, err)
	}
	command := exec.Command("go", "test", "./...")
	command.Dir = root
	command.Env = append(os.Environ(), "GO111MODULE=on", "GOTOOLCHAIN=local", "GOWORK=off", "GOPROXY=off", "GOSUMDB=off")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("pinned gorilla/mux %s behavior oracle failed: %v\n%s", variant, err, output)
	}
}

func TestProjectModuleExportedMethodRenameBreaksDownstreamConsumer(t *testing.T) {
	goMod := "module example.test/app\n\ngo 1.25\n"
	consumerMod := "module example.test/consumer\n\ngo 1.25\n\nrequire example.test/app v0.0.0\n\nreplace example.test/app => ../app\n"
	consumerSources := map[string]string{
		"consumer_linux_amd64.go":   "package consumer\nimport \"example.test/app/pkg\"\nfunc Use() int { return pkg.Worker{}.Do() }\n",
		"consumer_windows_amd64.go": "package consumer\nimport \"example.test/app/pkg\"\nfunc Use() int { return pkg.Worker{}.Do() }\n",
		"consumer_linux_arm64.go":   "package consumer\nimport \"example.test/app/pkg\"\nfunc Use() int { return pkg.Worker{}.Do() }\n",
	}
	files := []projectFile{{
		Path:   "pkg/api.go",
		Source: "package pkg\ntype Worker struct{}\nfunc (Worker) Do() int { return 7 }\nfunc local() int { return Worker{}.Do() }\n",
	}}
	for _, target := range []struct{ goos, goarch string }{
		{goos: "linux", goarch: "amd64"},
		{goos: "windows", goarch: "amd64"},
		{goos: "linux", goarch: "arm64"},
	} {
		t.Run(target.goos+"/"+target.goarch, func(t *testing.T) {
			targetRequest := goProjectRequest(files, "pkg/api.go")
			targetRequest.BuildGOOS, targetRequest.BuildGOARCH = target.goos, target.goarch
			targetRequest.Operation = "project_module_bindings"
			targetRequest.ModulePath, targetRequest.GoMod, targetRequest.GoModHash = "example.test/app", goMod, hashText(goMod)
			bindingsResult, err := listProjectModuleBindings(targetRequest)
			if err != nil {
				t.Fatalf("list module method bindings: %v", err)
			}
			var selected binding
			for _, raw := range bindingsResult["bindings"].([]map[string]any) {
				if raw["name"] == "Do" {
					selected = binding{ID: raw["id"].(string), Name: "Do", Exported: raw["exported"].(bool)}
					break
				}
			}
			if selected.ID == "" || !selected.Exported {
				t.Fatalf("downstream API method binding = %+v; want exported Do method", selected)
			}
			targetRequest.Operation = "project_module_rename"
			targetRequest.ExpectedHash = bindingsResult["source_sha256"].(string)
			targetRequest.SourceSetHash = bindingsResult["source_set_sha256"].(string)
			targetRequest.Renames = []renameSelection{{ID: selected.ID, NewName: "Serve"}}
			downstreamFiles := make([]projectFile, 0, len(consumerSources))
			for filePath, source := range consumerSources {
				downstreamFiles = append(downstreamFiles, projectFile{Path: filePath, Source: source, ExpectedHash: hashText(source)})
			}
			targetRequest.DownstreamModules = []downstreamModuleSnapshot{{
				ModulePath: "example.test/consumer", GoMod: consumerMod, GoModHash: hashText(consumerMod),
				Files: downstreamFiles,
			}}
			targetRequest.DownstreamModulesComplete = true
			if _, err := applyProjectModuleRenames(targetRequest); err == nil || !strings.Contains(err.Error(), "Go rename breaks downstream module example.test/consumer") || !strings.Contains(err.Error(), "Do") {
				t.Fatalf("downstream compatibility check error = %v; want a rejection identifying the broken Do reference", err)
			}
		})
	}
}

func TestProjectModuleExportedRenameReportsCheckedDownstreamCompatibility(t *testing.T) {
	goMod := "module example.test/app\n\ngo 1.25\n"
	consumerMod := "module example.test/consumer\n\ngo 1.25\n\nrequire example.test/app v0.0.0\n"
	consumerSources := map[string]string{
		"consumer_linux_amd64.go":   "package consumer\nimport \"example.test/app/pkg\"\nfunc Use() any { return pkg.Worker{} }\n",
		"consumer_windows_amd64.go": "package consumer\nimport \"example.test/app/pkg\"\nfunc Use() any { return pkg.Worker{} }\n",
		"consumer_linux_arm64.go":   "package consumer\nimport \"example.test/app/pkg\"\nfunc Use() any { return pkg.Worker{} }\n",
		"consumer_windows_arm64.go": "package consumer\nimport \"example.test/app/pkg\"\nfunc Use() any { return pkg.Worker{} }\n",
		"consumer_js_wasm.go":       "package consumer\nimport \"example.test/app/pkg\"\nfunc Use() any { return pkg.Worker{} }\n",
		"consumer_darwin_arm64.go":  "package consumer\nimport \"example.test/app/pkg\"\nfunc Use() any { return pkg.Worker{} }\n",
	}
	files := []projectFile{{
		Path:   "pkg/api.go",
		Source: "package pkg\ntype Worker struct{}\nfunc (Worker) Do() int { return 7 }\nfunc local() int { return Worker{}.Do() }\n",
	}}
	for _, target := range []struct{ goos, goarch string }{
		{goos: "linux", goarch: "amd64"},
		{goos: "windows", goarch: "amd64"},
		{goos: "linux", goarch: "arm64"},
	} {
		t.Run(target.goos+"/"+target.goarch, func(t *testing.T) {
			targetRequest := goProjectRequest(files, "pkg/api.go")
			targetRequest.BuildGOOS, targetRequest.BuildGOARCH = target.goos, target.goarch
			targetRequest.BuildTags = []string{"downstream_extra"}
			targetRequest.Operation = "project_module_bindings"
			targetRequest.ModulePath, targetRequest.GoMod, targetRequest.GoModHash = "example.test/app", goMod, hashText(goMod)
			bindingsResult, err := listProjectModuleBindings(targetRequest)
			if err != nil {
				t.Fatalf("list module method bindings: %v", err)
			}
			var selected binding
			for _, raw := range bindingsResult["bindings"].([]map[string]any) {
				if raw["name"] == "Do" {
					selected = binding{ID: raw["id"].(string), Name: "Do", Exported: raw["exported"].(bool)}
					break
				}
			}
			if selected.ID == "" || !selected.Exported {
				t.Fatalf("downstream API method binding = %+v; want exported Do method", selected)
			}
			targetRequest.Operation = "project_module_rename"
			targetRequest.ExpectedHash = bindingsResult["source_sha256"].(string)
			targetRequest.SourceSetHash = bindingsResult["source_set_sha256"].(string)
			targetRequest.Renames = []renameSelection{{ID: selected.ID, NewName: "Serve"}}
			downstreamFiles := make([]projectFile, 0, len(consumerSources))
			for filePath, source := range consumerSources {
				downstreamFiles = append(downstreamFiles, projectFile{Path: filePath, Source: source, ExpectedHash: hashText(source)})
			}
			targetRequest.DownstreamModules = []downstreamModuleSnapshot{{
				ModulePath: "example.test/consumer", GoMod: consumerMod, GoModHash: hashText(consumerMod),
				Files: downstreamFiles,
			}}
			targetRequest.DownstreamModulesComplete = true
			result, err := applyProjectModuleRenames(targetRequest)
			if err != nil {
				t.Fatalf("rename with compatible downstream consumer: %v", err)
			}
			compatibility := result["downstream_compatibility"].(map[string]any)
			if compatibility["status"] != "checked" || compatibility["checked_modules"] != 1 || compatibility["build_goos"] != target.goos || compatibility["build_goarch"] != target.goarch {
				t.Fatalf("downstream compatibility receipt = %#v; want one type-checked consumer module for %s/%s", compatibility, target.goos, target.goarch)
			}
			contexts, ok := compatibility["checked_build_contexts"].([]map[string]any)
			if !ok {
				t.Fatalf("downstream checked build contexts = %#v; want target receipts", compatibility["checked_build_contexts"])
			}
			seen := make(map[string]bool, len(contexts))
			for _, context := range contexts {
				seen[context["goos"].(string)+"/"+context["goarch"].(string)] = true
				if !reflect.DeepEqual(context["build_tags"], []string{"downstream_extra"}) {
					t.Fatalf("downstream checked build tags = %#v; want the requested custom tag", context["build_tags"])
				}
			}
			if len(seen) != 6 || !seen["linux/amd64"] || !seen["windows/amd64"] || !seen["linux/arm64"] || !seen["windows/arm64"] || !seen["js/wasm"] || !seen["darwin/arm64"] {
				t.Fatalf("downstream checked build contexts = %#v; want Linux/amd64, Windows/amd64, Linux/arm64, Windows/arm64, JS/wasm, and Darwin/arm64", contexts)
			}
		})
	}
}

func TestProjectModuleExportedRenameChecksDownstreamAlternateBuildContexts(t *testing.T) {
	goMod := "module example.test/app\n\ngo 1.25\n"
	consumerMod := "module example.test/consumer\n\ngo 1.25\n\nrequire example.test/app v0.0.0\n"
	files := []projectFile{{
		Path:   "pkg/api.go",
		Source: "package pkg\ntype Worker struct{}\nfunc (Worker) Do() int { return 7 }\nfunc local() int { return Worker{}.Do() }\n",
	}}
	request := goProjectRequest(files, "pkg/api.go")
	request.Operation = "project_module_bindings"
	request.ModulePath, request.GoMod, request.GoModHash = "example.test/app", goMod, hashText(goMod)
	bindings, err := listProjectModuleBindings(request)
	if err != nil {
		t.Fatalf("list module method bindings: %v", err)
	}
	var selected binding
	for _, raw := range bindings["bindings"].([]map[string]any) {
		if raw["name"] == "Do" && raw["kind"] == "method" {
			selected = binding{ID: raw["id"].(string), Name: "Do", Exported: raw["exported"].(bool)}
			break
		}
	}
	if selected.ID == "" || !selected.Exported {
		t.Fatalf("downstream API method binding = %+v; want exported Do method", selected)
	}
	request.Operation = "project_module_rename"
	request.ExpectedHash = bindings["source_sha256"].(string)
	request.SourceSetHash = bindings["source_set_sha256"].(string)
	request.Renames = []renameSelection{{ID: selected.ID, NewName: "Serve"}}
	request.DownstreamModulesComplete = true
	request.DownstreamModules = []downstreamModuleSnapshot{{
		ModulePath: "example.test/consumer", GoMod: consumerMod, GoModHash: hashText(consumerMod),
		Files: []projectFile{
			{Path: "consumer_linux_amd64.go", Source: "package consumer\nimport \"example.test/app/pkg\"\nfunc Use() any { return pkg.Worker{} }\n"},
			{Path: "consumer_windows_amd64.go", Source: "package consumer\nimport \"example.test/app/pkg\"\nfunc Use() int { return pkg.Worker{}.Do() }\n"},
		},
	}}
	if _, err := applyProjectModuleRenames(request); err == nil || !strings.Contains(err.Error(), "Go rename breaks downstream module example.test/consumer") || !strings.Contains(err.Error(), "windows/amd64") || !strings.Contains(err.Error(), "Do") {
		t.Fatalf("alternate-context downstream check error = %v; want rejection identifying the Windows Do reference", err)
	}
}

func TestProjectModuleExportedRenameChecksDownstreamCustomTagAcrossTargets(t *testing.T) {
	goMod := "module example.test/app\n\ngo 1.25\n"
	consumerMod := "module example.test/consumer\n\ngo 1.25\n\nrequire example.test/app v0.0.0\n"
	files := []projectFile{{
		Path:   "pkg/api.go",
		Source: "package pkg\ntype Worker struct{}\nfunc (Worker) Do() int { return 7 }\nfunc local() int { return Worker{}.Do() }\n",
	}}
	request := goProjectRequest(files, "pkg/api.go")
	request.BuildTags = []string{"downstream_extra"}
	request.Operation = "project_module_bindings"
	request.ModulePath, request.GoMod, request.GoModHash = "example.test/app", goMod, hashText(goMod)
	bindings, err := listProjectModuleBindings(request)
	if err != nil {
		t.Fatalf("list module method bindings: %v", err)
	}
	var selected binding
	for _, raw := range bindings["bindings"].([]map[string]any) {
		if raw["name"] == "Do" && raw["kind"] == "method" {
			selected = binding{ID: raw["id"].(string), Name: "Do", Exported: raw["exported"].(bool)}
			break
		}
	}
	if selected.ID == "" || !selected.Exported {
		t.Fatalf("downstream API method binding = %+v; want exported Do method", selected)
	}
	request.Operation = "project_module_rename"
	request.ExpectedHash = bindings["source_sha256"].(string)
	request.SourceSetHash = bindings["source_set_sha256"].(string)
	request.Renames = []renameSelection{{ID: selected.ID, NewName: "Serve"}}
	request.DownstreamModulesComplete = true
	request.DownstreamModules = []downstreamModuleSnapshot{{
		ModulePath: "example.test/consumer", GoMod: consumerMod, GoModHash: hashText(consumerMod),
		Files: []projectFile{
			{Path: "consumer.go", Source: "package consumer\nimport \"example.test/app/pkg\"\nfunc Use() any { return pkg.Worker{} }\n"},
			{Path: "consumer_windows_extra.go", Source: "//go:build windows && downstream_extra\n\npackage consumer\nimport \"example.test/app/pkg\"\nfunc UseTagged() int { return pkg.Worker{}.Do() }\n"},
		},
	}}
	if _, err := applyProjectModuleRenames(request); err == nil || !strings.Contains(err.Error(), "Go rename breaks downstream module example.test/consumer") || !strings.Contains(err.Error(), "windows/amd64") || !strings.Contains(err.Error(), "Do") {
		t.Fatalf("custom-tag downstream compatibility check error = %v; want a Windows rejection identifying the Do reference", err)
	}
}

func TestProjectModuleExportedRenameRejectsCustomTagConsumersAcrossRemainingTargets(t *testing.T) {
	goMod := "module example.test/app\n\ngo 1.25\n"
	consumerMod := "module example.test/consumer\n\ngo 1.25\n\nrequire example.test/app v0.0.0\n"
	targets := []struct {
		name, sourcePath, constraint string
	}{
		{
			name:       "windows/arm64",
			sourcePath: "consumer_windows_arm64_extra.go",
			constraint: "windows && arm64 && downstream_extra",
		},
		{
			name:       "js/wasm",
			sourcePath: "consumer_js_wasm_extra.go",
			constraint: "js && wasm && downstream_extra",
		},
	}
	for _, target := range targets {
		t.Run(target.name, func(t *testing.T) {
			files := []projectFile{{
				Path:   "pkg/api.go",
				Source: "package pkg\ntype Worker struct{}\nfunc (Worker) Do() int { return 7 }\nfunc local() int { return Worker{}.Do() }\n",
			}}
			request := goProjectRequest(files, "pkg/api.go")
			request.BuildTags = []string{"downstream_extra"}
			request.Operation = "project_module_bindings"
			request.ModulePath, request.GoMod, request.GoModHash = "example.test/app", goMod, hashText(goMod)
			bindings, err := listProjectModuleBindings(request)
			if err != nil {
				t.Fatalf("list module method bindings: %v", err)
			}
			var selected binding
			for _, raw := range bindings["bindings"].([]map[string]any) {
				if raw["name"] == "Do" && raw["kind"] == "method" {
					selected = binding{ID: raw["id"].(string), Name: "Do", Exported: raw["exported"].(bool)}
					break
				}
			}
			if selected.ID == "" || !selected.Exported {
				t.Fatalf("downstream API method binding = %+v; want exported Do method", selected)
			}
			request.Operation = "project_module_rename"
			request.ExpectedHash = bindings["source_sha256"].(string)
			request.SourceSetHash = bindings["source_set_sha256"].(string)
			request.Renames = []renameSelection{{ID: selected.ID, NewName: "Serve"}}
			request.DownstreamModulesComplete = true
			request.DownstreamModules = []downstreamModuleSnapshot{{
				ModulePath: "example.test/consumer", GoMod: consumerMod, GoModHash: hashText(consumerMod),
				Files: []projectFile{
					{Path: "consumer.go", Source: "package consumer\nimport \"example.test/app/pkg\"\nfunc Use() any { return pkg.Worker{} }\n"},
					{Path: target.sourcePath, Source: "//go:build " + target.constraint + "\n\npackage consumer\nimport \"example.test/app/pkg\"\nfunc UseTagged() int { return pkg.Worker{}.Do() }\n"},
				},
			}}
			if _, err := applyProjectModuleRenames(request); err == nil || !strings.Contains(err.Error(), "Go rename breaks downstream module example.test/consumer") || !strings.Contains(err.Error(), target.name) || !strings.Contains(err.Error(), "Do") {
				t.Fatalf("custom-tag downstream compatibility check error = %v; want a %s rejection identifying the Do reference", err, target.name)
			}
		})
	}
}

func TestProjectModuleExportedMethodRenameCoordinatesPlatformVariants(t *testing.T) {
	goMod := "module example.test/app\n\ngo 1.25\n"
	consumerMod := "module example.test/consumer\n\ngo 1.25\n\nrequire example.test/app v0.0.0\n"
	files := []projectFile{
		{Path: "pkg/api.go", Source: "package pkg\ntype Worker struct{}\ntype Other struct{}\n"},
		{Path: "pkg/api_linux.go", Source: "package pkg\nfunc (Worker) Do() int { return 7 }\nfunc linuxUse() int { return Worker{}.Do() }\n"},
		{Path: "pkg/api_darwin.go", Source: "package pkg\nfunc (Worker) Do() int { return 12 }\nfunc darwinUse() int { return Worker{}.Do() }\n"},
		{Path: "pkg/api_windows.go", Source: "package pkg\nfunc (Worker) Do() int { return 9 }\nfunc windowsUse() int { return Worker{}.Do() }\nfunc (Other) Do() int { return 11 }\nfunc otherUse() int { return Other{}.Do() }\n"},
	}
	request := goProjectRequest(files, "pkg/api_linux.go")
	request.Operation = "project_module_bindings"
	request.ModulePath, request.GoMod, request.GoModHash = "example.test/app", goMod, hashText(goMod)
	bindings, err := listProjectModuleBindings(request)
	if err != nil {
		t.Fatalf("list Linux module method bindings: %v", err)
	}
	var selected binding
	for _, raw := range bindings["bindings"].([]map[string]any) {
		if raw["name"] == "Do" {
			selected = binding{ID: raw["id"].(string), Name: "Do", Exported: raw["exported"].(bool)}
			break
		}
	}
	if selected.ID == "" || !selected.Exported {
		t.Fatalf("platform-specific method binding = %+v; want exported Do method", selected)
	}
	request.Operation = "project_module_rename"
	request.ExpectedHash = bindings["source_sha256"].(string)
	request.SourceSetHash = bindings["source_set_sha256"].(string)
	request.Renames = []renameSelection{{ID: selected.ID, NewName: "Serve"}}
	request.DownstreamModulesComplete = true
	request.DownstreamModules = []downstreamModuleSnapshot{{
		ModulePath: "example.test/consumer", GoMod: consumerMod, GoModHash: hashText(consumerMod),
		Files: []projectFile{{
			Path: "consumer.go", Source: "package consumer\nimport \"example.test/app/pkg\"\nfunc Use() any { return pkg.Worker{} }\n",
		}},
	}}
	result, err := applyProjectModuleRenames(request)
	if err != nil {
		t.Fatalf("rename with type-checked Linux and Windows method variants: %v", err)
	}
	changedFiles, ok := result["files"].([]map[string]any)
	if !ok {
		t.Fatalf("platform-variant rename files = %#v; want an edit manifest", result["files"])
	}
	changedSources := make(map[string]string, len(changedFiles))
	for _, file := range changedFiles {
		changedSources[file["relative_path"].(string)] = file["source_code"].(string)
	}
	want := map[string]string{
		"pkg/api_darwin.go":  "package pkg\nfunc (Worker) Serve() int { return 12 }\nfunc darwinUse() int { return Worker{}.Serve() }\n",
		"pkg/api_linux.go":   "package pkg\nfunc (Worker) Serve() int { return 7 }\nfunc linuxUse() int { return Worker{}.Serve() }\n",
		"pkg/api_windows.go": "package pkg\nfunc (Worker) Serve() int { return 9 }\nfunc windowsUse() int { return Worker{}.Serve() }\nfunc (Other) Do() int { return 11 }\nfunc otherUse() int { return Other{}.Do() }\n",
	}
	if len(changedSources) != len(want) {
		t.Fatalf("platform-variant rename outputs = %#v; want both target-specific method files", changedSources)
	}
	for filePath, expected := range want {
		if changedSources[filePath] != expected {
			t.Fatalf("renamed %s = %q; want %q", filePath, changedSources[filePath], expected)
		}
	}
	renamed, ok := result["renamed_bindings"].([]map[string]any)
	if !ok || len(renamed) != 1 || renamed[0]["referenceCount"] != 3 {
		t.Fatalf("platform-variant method receipt = %#v; want all three in-module references", result["renamed_bindings"])
	}
	compatibility := result["downstream_compatibility"].(map[string]any)
	contexts, ok := compatibility["checked_build_contexts"].([]map[string]any)
	if compatibility["status"] != "checked" || !ok || len(contexts) != 6 {
		t.Fatalf("platform-variant downstream receipt = %#v; want six checked target contexts", compatibility)
	}
}

func TestProjectModuleExportedMethodRenameCoordinatesInactiveTargetReferences(t *testing.T) {
	goMod := "module example.test/app\n\ngo 1.25\n"
	files := []projectFile{
		{Path: "pkg/api.go", Source: "package pkg\ntype Worker struct{}\nfunc (Worker) Do() int { return 7 }\nfunc local() int { return Worker{}.Do() }\n"},
		{Path: "cmd/use_linux.go", Source: "package cmd\nimport \"example.test/app/pkg\"\nfunc Use() int { return pkg.Worker{}.Do() }\n"},
		{Path: "cmd/use_windows.go", Source: "package cmd\nimport \"example.test/app/pkg\"\nfunc Use() int { return pkg.Worker{}.Do() }\n"},
		{Path: "cmd/unrelated_windows.go", Source: "package cmd\ntype Other struct{}\nfunc (Other) Do() int { return 9 }\nfunc unrelated() int { return Other{}.Do() }\n"},
	}
	request := goProjectRequest(files, "pkg/api.go")
	request.Operation = "project_module_bindings"
	request.ModulePath, request.GoMod, request.GoModHash = "example.test/app", goMod, hashText(goMod)
	bindings, err := listProjectModuleBindings(request)
	if err != nil {
		t.Fatalf("list Linux module method bindings: %v", err)
	}
	var selected binding
	for _, raw := range bindings["bindings"].([]map[string]any) {
		if raw["name"] == "Do" && raw["kind"] == "method" {
			selected = binding{ID: raw["id"].(string), Name: "Do", Exported: raw["exported"].(bool)}
			break
		}
	}
	if selected.ID == "" || !selected.Exported {
		t.Fatalf("cross-package method binding = %+v; want exported Do method", selected)
	}
	request.Operation = "project_module_rename"
	request.ExpectedHash = bindings["source_sha256"].(string)
	request.SourceSetHash = bindings["source_set_sha256"].(string)
	request.Renames = []renameSelection{{ID: selected.ID, NewName: "Serve"}}
	result, err := applyProjectModuleRenames(request)
	if err != nil {
		t.Fatalf("rename with type-checked inactive Windows reference: %v", err)
	}
	changedFiles, ok := result["files"].([]map[string]any)
	if !ok {
		t.Fatalf("rename result files = %#v; want an edit manifest", result["files"])
	}
	changedSources := make(map[string]string, len(changedFiles))
	for _, file := range changedFiles {
		changedSources[file["relative_path"].(string)] = file["source_code"].(string)
	}
	if len(changedSources) != 3 || !strings.Contains(changedSources["cmd/use_windows.go"], "Worker{}.Serve()") {
		t.Fatalf("coordinated method rename outputs = %#v; want exact edits to the Windows-only call", changedSources)
	}
	if _, changed := changedSources["cmd/unrelated_windows.go"]; changed {
		t.Fatalf("rename changed an unrelated Other.Do method: %#v", changedSources["cmd/unrelated_windows.go"])
	}
	renamed, ok := result["renamed_bindings"].([]map[string]any)
	if !ok || len(renamed) != 1 || renamed[0]["referenceCount"] != 3 {
		t.Fatalf("renamed method receipt = %#v; want all three in-module call sites", result["renamed_bindings"])
	}

	safeFiles := []projectFile{files[0], files[1], files[3]}
	safeRequest := goProjectRequest(safeFiles, "pkg/api.go")
	safeRequest.Operation = "project_module_bindings"
	safeRequest.ModulePath, safeRequest.GoMod, safeRequest.GoModHash = "example.test/app", goMod, hashText(goMod)
	safeBindings, err := listProjectModuleBindings(safeRequest)
	if err != nil {
		t.Fatalf("list module bindings with unrelated Windows method: %v", err)
	}
	for _, raw := range safeBindings["bindings"].([]map[string]any) {
		if raw["name"] != "Do" || raw["kind"] != "method" {
			continue
		}
		safeRequest.Operation = "project_module_rename"
		safeRequest.ExpectedHash = safeBindings["source_sha256"].(string)
		safeRequest.SourceSetHash = safeBindings["source_set_sha256"].(string)
		safeRequest.Renames = []renameSelection{{ID: raw["id"].(string), NewName: "Serve"}}
		safeResult, err := applyProjectModuleRenames(safeRequest)
		if err != nil {
			t.Fatalf("unrelated Windows Do method blocked the Worker rename: %v", err)
		}
		for _, file := range safeResult["files"].([]map[string]any) {
			if file["relative_path"] == "cmd/unrelated_windows.go" {
				t.Fatalf("unrelated Windows Other.Do reference was edited: %#v", file)
			}
		}
		return
	}
	t.Fatal("module bindings did not include the exported Worker.Do method")
}

func assertDownstreamGoModuleBuild(t *testing.T, appGoMod string, appFiles map[string]string, consumerGoMod, consumerSource string, wantSuccess bool) string {
	t.Helper()
	root := t.TempDir()
	appRoot := filepath.Join(root, "app")
	consumerRoot := filepath.Join(root, "consumer")
	for _, directory := range []string{appRoot, consumerRoot} {
		if err := os.MkdirAll(directory, 0o755); err != nil {
			t.Fatalf("create downstream fixture directory: %v", err)
		}
	}
	writeFixture := func(filePath, source string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(filePath), 0o755); err != nil {
			t.Fatalf("create downstream fixture package: %v", err)
		}
		if err := os.WriteFile(filePath, []byte(source), 0o600); err != nil {
			t.Fatalf("write downstream fixture source: %v", err)
		}
	}
	writeFixture(filepath.Join(appRoot, "go.mod"), appGoMod)
	for relativePath, source := range appFiles {
		writeFixture(filepath.Join(appRoot, filepath.FromSlash(relativePath)), source)
	}
	writeFixture(filepath.Join(consumerRoot, "go.mod"), consumerGoMod)
	writeFixture(filepath.Join(consumerRoot, "consumer.go"), consumerSource)
	command := exec.Command("go", "test", "./...")
	command.Dir = consumerRoot
	command.Env = append(os.Environ(), "GO111MODULE=on", "GOTOOLCHAIN=local", "GOWORK=off", "GOPROXY=off", "GOSUMDB=off")
	output, err := command.CombinedOutput()
	if wantSuccess && err != nil {
		t.Fatalf("unchanged downstream consumer did not compile against original module: %v\n%s", err, output)
	}
	if !wantSuccess && err == nil {
		t.Fatalf("unchanged downstream consumer unexpectedly compiled after exported API rename:\n%s", output)
	}
	return string(output)
}

func TestProjectModuleMethodRenamePreservesImportedInterfaceContracts(t *testing.T) {
	goMod := "module example.test/app\n\ngo 1.25\n"
	files := []projectFile{
		{Path: "pkg/model.go", Source: "package pkg\ntype writer struct{}\nfunc (writer) Write(data []byte) (int, error) { return len(data), nil }\n"},
		{Path: "pkg/api.go", Source: "package pkg\nimport \"io\"\nfunc Accept(value io.Writer) {}\nfunc MakeWriter() io.Writer { return writer{} }\nfunc useWriter() { _, _ = writer{}.Write(nil) }\n"},
		{Path: "cmd/run.go", Source: "package main\nimport \"example.test/app/pkg\"\nfunc Run() { pkg.Accept(pkg.MakeWriter()) }\n"},
	}
	request := goProjectRequest(files, "pkg/model.go")
	request.Operation = "project_module_bindings"
	request.ModulePath, request.GoMod, request.GoModHash = "example.test/app", goMod, hashText(goMod)
	result, err := listProjectModuleBindings(request)
	if err != nil {
		t.Fatalf("list module method bindings: %v", err)
	}
	var selected binding
	for _, raw := range result["bindings"].([]map[string]any) {
		if raw["name"] == "Write" {
			selected = binding{ID: raw["id"].(string), Name: "Write", Kind: "method", FilePath: "pkg/model.go"}
		}
	}
	if selected.ID == "" {
		t.Fatal("exported io.Writer method implementation was not catalogued")
	}
	request.Operation = "project_module_rename"
	request.ExpectedHash = result["source_sha256"].(string)
	request.SourceSetHash = result["source_set_sha256"].(string)
	request.Renames = []renameSelection{{ID: selected.ID, NewName: "Flush"}}
	if _, err := applyProjectModuleRenames(request); err == nil {
		t.Fatal("renaming Write to Flush should break the imported io.Writer implementation contract")
	}
}

func TestProjectModuleMethodRenamePreservesBuiltinErrorContract(t *testing.T) {
	goMod := "module example.test/error-contract\n\ngo 1.25\n"
	files := []projectFile{{
		Path:   "pkg/error.go",
		Source: "package pkg\ntype failure struct{}\nfunc (failure) Error() string { return \"failure\" }\nfunc message(value failure) string { return value.Error() }\n",
	}}
	request := goProjectRequest(files, "pkg/error.go")
	request.Operation = "project_module_bindings"
	request.ModulePath, request.GoMod, request.GoModHash = "example.test/error-contract", goMod, hashText(goMod)
	catalogResult, err := listProjectModuleBindings(request)
	if err != nil {
		t.Fatalf("catalog built-in error implementation: %v", err)
	}
	var selected binding
	for _, raw := range catalogResult["bindings"].([]map[string]any) {
		if raw["name"] == "Error" {
			selected = binding{ID: raw["id"].(string), Name: "Error", ReferenceCount: raw["referenceCount"].(int), Exported: raw["exported"].(bool)}
			break
		}
	}
	if selected.ID == "" || selected.ReferenceCount != 1 || !selected.Exported {
		t.Fatalf("built-in error method binding = %+v; want one resolved reference to exported Error", selected)
	}
	request.Operation = "project_module_rename"
	request.ExpectedHash = catalogResult["source_sha256"].(string)
	request.SourceSetHash = catalogResult["source_set_sha256"].(string)
	request.Renames = []renameSelection{{ID: selected.ID, NewName: "Message"}}
	if _, err := applyProjectModuleRenames(request); err == nil || !strings.Contains(err.Error(), "Go rename would change a module or imported interface implementation contract") {
		t.Fatalf("built-in error method rename error = %v; want rejection for breaking error", err)
	}
}

func TestProjectModuleMethodRenameRejectsChangedSourceSet(t *testing.T) {
	goMod := "module example.test/app\n\ngo 1.25\n"
	files := []projectFile{
		{Path: "pkg/model.go", Source: "package pkg\ntype Worker struct{}\nfunc (Worker) Normalize(value int) int { return value + 1 }\n"},
		{Path: "cmd/run.go", Source: "package main\nimport \"example.test/app/pkg\"\nfunc Run() int { return pkg.Worker{}.Normalize(3) }\n"},
	}
	request := goProjectRequest(files, "pkg/model.go")
	request.Operation = "project_module_bindings"
	request.ModulePath, request.GoMod, request.GoModHash = "example.test/app", goMod, hashText(goMod)
	result, err := listProjectModuleBindings(request)
	if err != nil {
		t.Fatalf("list module method bindings: %v", err)
	}
	var bindingID string
	for _, raw := range result["bindings"].([]map[string]any) {
		if raw["name"] == "Normalize" {
			bindingID = raw["id"].(string)
			break
		}
	}
	if bindingID == "" {
		t.Fatal("exported module method was not catalogued")
	}
	request.Operation = "project_module_rename"
	request.ExpectedHash = result["source_sha256"].(string)
	request.SourceSetHash = result["source_set_sha256"].(string)
	request.Renames = []renameSelection{{ID: bindingID, NewName: "Scale"}}
	request.Files[1].Source = strings.ReplaceAll(request.Files[1].Source, "Normalize", "Normalize ")
	request.Source = request.Files[0].Source
	if _, err := applyProjectModuleRenames(request); err == nil || !strings.Contains(err.Error(), "module source changed") {
		t.Fatalf("changed module source error = %v; want stale source-set rejection", err)
	}
}

func TestProjectTypeRenameUpdatesEmbeddedFieldReferences(t *testing.T) {
	request := goProjectRequest([]projectFile{
		{Path: "pkg/model.go", Source: "package sample\n\ntype entry struct { value int }\n"},
		{Path: "pkg/view.go", Source: "package sample\n\ntype view struct { *entry }\ntype outer struct { view }\nfunc create() outer { return outer{view: view{entry: &entry{value: 4}}} }\nfunc read(item outer) int { return item.entry.value }\n"},
	}, "pkg/model.go")
	catalog, err := buildProjectCatalog(request)
	if err != nil {
		t.Fatal(err)
	}
	var selected binding
	for _, item := range catalog.Bindings {
		if item.FilePath == request.SelectedPath && item.Name == "entry" {
			selected = item
			break
		}
	}
	if selected.ID == "" || selected.ReferenceCount != 2 {
		t.Fatalf("embedded type binding = %+v; want declaration and two type references", selected)
	}
	request.Operation = "project_rename"
	request.ExpectedHash = catalog.SelectedHash
	request.SourceSetHash = catalog.SourceSetHash
	request.Renames = []renameSelection{{ID: selected.ID, NewName: "record"}}
	result, err := applyProjectRenames(request)
	if err != nil {
		t.Fatalf("rename embedded package type: %v", err)
	}
	files := result["files"].([]map[string]any)
	if len(files) != 2 {
		t.Fatalf("edit manifest files = %d; want model and embedded-field reference files", len(files))
	}
	outputs := make(map[string]string)
	for _, file := range files {
		outputs[file["relative_path"].(string)] = file["source_code"].(string)
	}
	want := "package sample\n\ntype view struct { *record }\ntype outer struct { view }\nfunc create() outer { return outer{view: view{record: &record{value: 4}}} }\nfunc read(item outer) int { return item.record.value }\n"
	if outputs["pkg/view.go"] != want {
		t.Fatalf("embedded field references were not updated with the type name:\\n got: %q\\nwant: %q", outputs["pkg/view.go"], want)
	}
	editCount := 0
	editCountsByPath := make(map[string]int, len(files))
	for _, file := range files {
		relativePath := file["relative_path"].(string)
		editCountsByPath[relativePath] = len(file["edits"].([]map[string]any))
		original := request.Files[0].Source
		if relativePath == "pkg/view.go" {
			original = request.Files[1].Source
		}
		for _, edit := range file["edits"].([]map[string]any) {
			if edit["old_text"] != "entry" || edit["new_text"] != "record" {
				t.Fatalf("embedded type edit = %#v; want entry -> record", edit)
			}
			start, startOK := edit["start"].(int)
			end, endOK := edit["end"].(int)
			if !startOK || !endOK || start < 0 || end <= start || end > len(original) || original[start:end] != "entry" {
				t.Fatalf("embedded type edit offsets = %#v; want byte-exact entry span in %s", edit, relativePath)
			}
			editCount++
		}
	}
	if editCount != 5 || editCountsByPath["pkg/model.go"] != 1 || editCountsByPath["pkg/view.go"] != 4 {
		t.Fatalf("embedded type rename manifest has %d edits by path; want model/view counts 1/4, got %v", editCount, editCountsByPath)
	}
	assertProjectRenameBehavior(t, map[string]string{
		"pkg/model.go": request.Files[0].Source,
		"pkg/view.go":  request.Files[1].Source,
	}, "func TestCorpusBehavior(t *testing.T) { if got := read(create()); got != 4 { t.Fatalf(\"read = %d\", got) } }\n", "original")
	assertProjectRenameBehavior(t, map[string]string{
		"pkg/model.go": "package sample\n\ntype record struct { value int }\n",
		"pkg/view.go":  want,
	}, "func TestCorpusBehavior(t *testing.T) { if got := read(create()); got != 4 { t.Fatalf(\"read = %d\", got) } }\n", "renamed")
}

func TestProjectTypeAliasRenameUpdatesEmbeddedFieldReferences(t *testing.T) {
	request := goProjectRequest([]projectFile{
		{Path: "pkg/model.go", Source: "package sample\n\ntype entry struct { value int }\ntype alias = entry\n"},
		{Path: "pkg/view.go", Source: "package sample\n\ntype view struct { alias }\nfunc create() view { return view{alias: alias{value: 5}} }\nfunc read(item view) int { return item.alias.value }\n"},
	}, "pkg/model.go")
	catalog, err := buildProjectCatalog(request)
	if err != nil {
		t.Fatal(err)
	}
	var selected binding
	for _, item := range catalog.Bindings {
		if item.FilePath == request.SelectedPath && item.Name == "alias" {
			selected = item
			break
		}
	}
	if selected.ID == "" || selected.ReferenceCount != 2 {
		t.Fatalf("embedded alias binding = %+v; want an identified alias with two type references", selected)
	}
	request.Operation = "project_rename"
	request.ExpectedHash = catalog.SelectedHash
	request.SourceSetHash = catalog.SourceSetHash
	request.Renames = []renameSelection{{ID: selected.ID, NewName: "record"}}
	result, err := applyProjectRenames(request)
	if err != nil {
		t.Fatalf("rename embedded package type alias: %v", err)
	}
	files := result["files"].([]map[string]any)
	outputs := make(map[string]string)
	editCount := 0
	for _, file := range files {
		outputs[file["relative_path"].(string)] = file["source_code"].(string)
		editCount += len(file["edits"].([]map[string]any))
	}
	want := "package sample\n\ntype view struct { record }\nfunc create() view { return view{record: record{value: 5}} }\nfunc read(item view) int { return item.record.value }\n"
	if outputs["pkg/view.go"] != want || editCount != 5 {
		t.Fatalf("alias rename output/manifest = %q / %d edits; want exact derived-field updates and five edits", outputs["pkg/view.go"], editCount)
	}
	assertProjectRenameBehavior(t, map[string]string{
		"pkg/model.go": request.Files[0].Source,
		"pkg/view.go":  request.Files[1].Source,
	}, "func TestCorpusBehavior(t *testing.T) { if got := read(create()); got != 5 { t.Fatalf(\"read = %d\", got) } }\n", "original")
	assertProjectRenameBehavior(t, map[string]string{
		"pkg/model.go": "package sample\n\ntype entry struct { value int }\ntype record = entry\n",
		"pkg/view.go":  want,
	}, "func TestCorpusBehavior(t *testing.T) { if got := read(create()); got != 5 { t.Fatalf(\"read = %d\", got) } }\n", "renamed")
}

func TestProjectTypeRenameRejectsEmbeddedFieldCollision(t *testing.T) {
	request := goProjectRequest([]projectFile{
		{Path: "pkg/model.go", Source: "package sample\n\ntype entry struct{}\n"},
		{Path: "pkg/view.go", Source: "package sample\n\ntype view struct { entry; record int }\n"},
	}, "pkg/model.go")
	catalog, err := buildProjectCatalog(request)
	if err != nil {
		t.Fatal(err)
	}
	var selected binding
	for _, item := range catalog.Bindings {
		if item.FilePath == request.SelectedPath && item.Name == "entry" {
			selected = item
			break
		}
	}
	if selected.ID == "" {
		t.Fatal("embedded package type was not catalogued")
	}
	request.Operation = "project_rename"
	request.ExpectedHash = catalog.SelectedHash
	request.SourceSetHash = catalog.SourceSetHash
	request.Renames = []renameSelection{{ID: selected.ID, NewName: "record"}}
	if _, err := applyProjectRenames(request); err == nil || !strings.Contains(err.Error(), "Go package rejected the renamed output") {
		t.Fatalf("embedded-field collision error = %v; want type-check rejection", err)
	}
}

func TestProjectRenameVersionedBindingIntegrityCorpus(t *testing.T) {
	content, err := os.ReadFile(filepath.Join("testdata", "project_rename_v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	var corpus projectRenameCorpus
	if err := json.Unmarshal(content, &corpus); err != nil {
		t.Fatal(err)
	}
	if corpus.Version != 1 || len(corpus.Cases) == 0 || len(corpus.RejectCases) == 0 {
		t.Fatalf("project rename corpus version/positive/negative case count = %d/%d/%d; want version 1 and both case classes", corpus.Version, len(corpus.Cases), len(corpus.RejectCases))
	}
	expectedOccurrences := 0
	manifestEdits := 0
	for _, test := range corpus.Cases {
		t.Run(test.Name, func(t *testing.T) {
			if strings.TrimSpace(test.BehaviorTest) == "" {
				t.Fatal("positive corpus case has no runtime behavior oracle")
			}
			paths := make([]string, 0, len(test.Files))
			for filePath := range test.Files {
				paths = append(paths, filePath)
			}
			sort.Strings(paths)
			files := make([]projectFile, 0, len(paths))
			for _, filePath := range paths {
				files = append(files, projectFile{Path: filePath, Source: test.Files[filePath]})
			}
			request := goProjectRequest(files, test.SelectedPath)
			catalog, err := buildProjectCatalog(request)
			if err != nil {
				t.Fatalf("build package catalog: %v", err)
			}
			var selected binding
			for _, item := range catalog.Bindings {
				if item.FilePath == test.SelectedPath && item.Name == test.OldName {
					selected = item
					break
				}
			}
			if selected.ID == "" || selected.ReferenceCount != test.ReferenceCount {
				t.Fatalf("binding %s references = %d; want an identified binding with %d references", test.OldName, selected.ReferenceCount, test.ReferenceCount)
			}

			request.Operation = "project_rename"
			request.ExpectedHash = catalog.SelectedHash
			request.SourceSetHash = catalog.SourceSetHash
			request.Renames = []renameSelection{{ID: selected.ID, NewName: test.NewName}}
			result, err := applyProjectRenames(request)
			if err != nil {
				t.Fatalf("apply project rename: %v", err)
			}
			actual := make(map[string]string, len(test.Files))
			for filePath, source := range test.Files {
				actual[filePath] = source
			}
			for _, output := range result["files"].([]map[string]any) {
				actual[output["relative_path"].(string)] = output["source_code"].(string)
			}
			if !reflect.DeepEqual(actual, test.Expected) {
				t.Fatalf("project rename output differs from corpus oracle:\n got: %#v\nwant: %#v", actual, test.Expected)
			}
			editCount := 0
			for _, output := range result["files"].([]map[string]any) {
				for _, edit := range output["edits"].([]map[string]any) {
					if edit["old_text"] != test.OldName || edit["new_text"] != test.NewName {
						t.Fatalf("edit manifest entry = %#v; want %s -> %s", edit, test.OldName, test.NewName)
					}
					editCount++
				}
			}
			wantEditCount := test.ReferenceCount + 1 // one declaration plus every known reference
			if editCount != wantEditCount {
				t.Fatalf("edit manifest has %d edits; want %d ground-truth occurrences", editCount, wantEditCount)
			}
			assertProjectRenameBehavior(t, test.Files, test.BehaviorTest, "original")
			assertProjectRenameBehavior(t, test.Expected, test.BehaviorTest, "renamed")
			expectedOccurrences += wantEditCount
			manifestEdits += editCount
		})
	}
	for _, test := range corpus.RejectCases {
		t.Run(test.Name, func(t *testing.T) {
			paths := make([]string, 0, len(test.Files))
			for filePath := range test.Files {
				paths = append(paths, filePath)
			}
			sort.Strings(paths)
			files := make([]projectFile, 0, len(paths))
			for _, filePath := range paths {
				files = append(files, projectFile{Path: filePath, Source: test.Files[filePath]})
			}
			request := goProjectRequest(files, test.SelectedPath)
			catalog, err := buildProjectCatalog(request)
			if err != nil {
				t.Fatalf("build package catalog: %v", err)
			}
			var selected binding
			for _, item := range catalog.Bindings {
				if item.FilePath == test.SelectedPath && item.Name == test.OldName {
					selected = item
					break
				}
			}
			if selected.ID == "" {
				t.Fatalf("binding %s was not catalogued", test.OldName)
			}
			request.Operation = "project_rename"
			request.ExpectedHash = catalog.SelectedHash
			request.SourceSetHash = catalog.SourceSetHash
			request.Renames = []renameSelection{{ID: selected.ID, NewName: test.NewName}}
			_, err = applyProjectRenames(request)
			if err == nil || !strings.Contains(err.Error(), test.ErrorContains) {
				t.Fatalf("rename error = %v; want error containing %q", err, test.ErrorContains)
			}
		})
	}
	if !t.Failed() {
		t.Logf("synthetic source-occurrence precision/recall: %d/%d expected occurrences edited, exact output required across %d positive and %d rejection cases", manifestEdits, expectedOccurrences, len(corpus.Cases), len(corpus.RejectCases))
	}
}

func TestProjectRenamePinnedUpstreamErrorsFixture(t *testing.T) {
	fixtureDirectory := filepath.Join("testdata", "upstream_errors_v0_9_1")
	errorsSource, err := os.ReadFile(filepath.Join(fixtureDirectory, "errors.go"))
	if err != nil {
		t.Fatal(err)
	}
	stackSource, err := os.ReadFile(filepath.Join(fixtureDirectory, "stack.go"))
	if err != nil {
		t.Fatal(err)
	}
	licenseSource, err := os.ReadFile(filepath.Join(fixtureDirectory, "LICENSE"))
	if err != nil {
		t.Fatal(err)
	}
	for path, source := range map[string]struct {
		bytes []byte
		hash  string
	}{
		"errors.go": {bytes: errorsSource, hash: "71793fd94586f7261ab418566b3114f89bbbfda354ecf37c42f5b782315c4b4c"},
		"stack.go":  {bytes: stackSource, hash: "8db3c35a432c18077f24f41b29e70adaea5ed9204ced729febf50dbac0e3d100"},
		"LICENSE":   {bytes: licenseSource, hash: "b6ac2b8efa0412a02a909080be694d88ed6a8b25b8041a48dd4d0c50dac785ad"},
	} {
		if actual := hashText(string(source.bytes)); actual != source.hash {
			t.Fatalf("pinned upstream %s SHA-256 = %s; want %s", path, actual, source.hash)
		}
	}
	files := []projectFile{
		{Path: "pkg/errors.go", Source: string(errorsSource)},
		{Path: "pkg/stack.go", Source: string(stackSource)},
	}
	request := goProjectRequest(files, "pkg/stack.go")
	catalog, err := buildProjectCatalog(request)
	if err != nil {
		t.Fatalf("catalog pinned upstream package: %v", err)
	}
	var selected binding
	for _, item := range catalog.Bindings {
		if item.FilePath == request.SelectedPath && item.Name == "callers" {
			selected = item
			break
		}
	}
	if selected.ID == "" || selected.ReferenceCount != 5 {
		t.Fatalf("upstream callers binding = %+v; want one declaration and five references across the pinned files", selected)
	}
	request.Operation = "project_rename"
	request.ExpectedHash = catalog.SelectedHash
	request.SourceSetHash = catalog.SourceSetHash
	request.Renames = []renameSelection{{ID: selected.ID, NewName: "captureStack"}}
	result, err := applyProjectRenames(request)
	if err != nil {
		t.Fatalf("rename upstream callers function: %v", err)
	}
	outputs := map[string]string{"pkg/errors.go": string(errorsSource), "pkg/stack.go": string(stackSource)}
	editCount := 0
	editsByPath := make(map[string]int, len(files))
	for _, output := range result["files"].([]map[string]any) {
		path := output["relative_path"].(string)
		outputs[path] = output["source_code"].(string)
		for _, edit := range output["edits"].([]map[string]any) {
			start, startOK := edit["start"].(int)
			end, endOK := edit["end"].(int)
			original := string(errorsSource)
			if path == "pkg/stack.go" {
				original = string(stackSource)
			}
			if edit["old_text"] != "callers" || edit["new_text"] != "captureStack" || !startOK || !endOK || start < 0 || end > len(original) || original[start:end] != "callers" {
				t.Fatalf("upstream edit for %s = %#v; want a byte-exact callers -> captureStack span", path, edit)
			}
			editCount++
			editsByPath[path]++
		}
	}
	if outputs["pkg/stack.go"] == string(stackSource) || outputs["pkg/errors.go"] == string(errorsSource) || editsByPath["pkg/errors.go"] == 0 {
		t.Fatalf("rename did not propagate across both upstream files; edits by path: %v", editsByPath)
	}
	if editCount != 6 || editsByPath["pkg/stack.go"] != 1 || editsByPath["pkg/errors.go"] != 5 {
		t.Fatalf("upstream edit manifest has %d edits by path %v; want 1 declaration and 5 cross-file references", editCount, editsByPath)
	}
	behaviorTest := "package errors\n\nimport (\n\tstderrors \"errors\"\n\t\"fmt\"\n\t\"strings\"\n\t\"testing\"\n)\n\nfunc TestCorpusBehavior(t *testing.T) {\n\tsentinel := stderrors.New(\"root\")\n\twrapped := Wrap(sentinel, \"outer\")\n\tif got := wrapped.Error(); got != \"outer: root\" { t.Fatalf(\"wrapped error = %q\", got) }\n\tif Cause(wrapped) != sentinel { t.Fatal(\"cause changed\") }\n\tif got := fmt.Sprintf(\"%+v\", wrapped); !strings.Contains(got, \"TestCorpusBehavior\") { t.Fatalf(\"stack trace omitted behavior frame: %q\", got) }\n}\n"
	assertProjectPackageRenameBehavior(t, outputsBeforeRename(files), behaviorTest, "upstream original")
	assertProjectPackageRenameBehavior(t, outputs, behaviorTest, "upstream renamed")
}

func TestProjectRenamePinnedUpstreamUUIDFixture(t *testing.T) {
	fixtureDirectory := filepath.Join("testdata", "upstream_uuid_v1_6_0")
	wantHashes := map[string]string{
		"uuid.go":     "707a63232670b23c8bb7e90fc4cbbfdaf0d2bff6a17734943fa0c476f182a741",
		"version4.go": "700f88aa406818aac89411773bb6395b278b4930f99b113558657333ab6c332a",
		"util.go":     "1734f5bb243b580604adb97e53782c18fc0a2060178fb040dd82c893922b94fc",
		"hash.go":     "bca77e48eea81ae9b514b4aaee29bc5ed09318e0a82f059338405f4eabc23045",
		"marshal.go":  "f0e4e3651bacae9a6509e6d3e4fbacfe24adab91d87ece24cd70f0247b4464e0",
		"sql.go":      "19710834cfcb61d444b5ca41e2c20a4bcea8834530c2b1ff1f592d0b95807c5f",
		"LICENSE":     "f9e95f8256a9c54f6cff58d662d493cc9b8b36c7117a35d2d9e5174c229755ca",
	}
	files := make([]projectFile, 0, len(wantHashes)-1)
	sourceByPath := make(map[string][]byte, len(wantHashes))
	for path, wantHash := range wantHashes {
		source, err := os.ReadFile(filepath.Join(fixtureDirectory, path))
		if err != nil {
			t.Fatal(err)
		}
		if actual := hashText(string(source)); actual != wantHash {
			t.Fatalf("pinned upstream %s SHA-256 = %s; want %s", path, actual, wantHash)
		}
		sourceByPath[path] = source
		if path != "LICENSE" {
			files = append(files, projectFile{Path: "pkg/" + path, Source: string(source)})
		}
	}
	behaviorTest := "package uuid\n\nimport (\n\t\"bytes\"\n\t\"testing\"\n)\n\nfunc TestCorpusBehavior(t *testing.T) {\n\tseed := []byte{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15}\n\twant := \"00010203-0405-4607-8809-0a0b0c0d0e0f\"\n\tDisableRandPool()\n\tdefer DisableRandPool()\n\tdefer SetRand(nil)\n\tSetRand(bytes.NewReader(seed))\n\tgot, err := NewRandom()\n\tif err != nil || got.String() != want { t.Fatalf(\"direct generation = %s, %v\", got, err) }\n\tEnableRandPool()\n\tSetRand(bytes.NewReader(bytes.Repeat(seed, 16)))\n\tgot, err = NewRandom()\n\tif err != nil || got.String() != want { t.Fatalf(\"pooled generation = %s, %v\", got, err) }\n}\n"
	behaviorTest += "func TestCorpusParseBehavior(t *testing.T) {\n\twant := \"00010203-0405-4607-8809-0a0b0c0d0e0f\"\n\tparsed, err := Parse(want)\n\tif err != nil || parsed.String() != want { t.Fatalf(\"Parse = %s, %v\", parsed, err) }\n\tparsedBytes, err := ParseBytes([]byte(want))\n\tif err != nil || parsedBytes != parsed { t.Fatalf(\"ParseBytes = %s, %v\", parsedBytes, err) }\n\tif err := Validate(want); err != nil { t.Fatalf(\"Validate = %v\", err) }\n}\n"
	renameCases := []struct {
		name                string
		selectedPath        string
		newName             string
		references          int
		expectedEditsByFile map[string]int
	}{
		{name: "randPoolSize", selectedPath: "pkg/uuid.go", newName: "randomBufferSize", references: 4, expectedEditsByFile: map[string]int{"pkg/uuid.go": 4, "pkg/version4.go": 1}},
		{name: "poolEnabled", selectedPath: "pkg/uuid.go", newName: "randomPoolEnabled", references: 3, expectedEditsByFile: map[string]int{"pkg/uuid.go": 3, "pkg/version4.go": 1}},
		{name: "poolMu", selectedPath: "pkg/uuid.go", newName: "randomPoolMutex", references: 5, expectedEditsByFile: map[string]int{"pkg/uuid.go": 3, "pkg/version4.go": 3}},
		{name: "poolPos", selectedPath: "pkg/uuid.go", newName: "randomPoolPosition", references: 6, expectedEditsByFile: map[string]int{"pkg/uuid.go": 2, "pkg/version4.go": 5}},
		{name: "pool", selectedPath: "pkg/uuid.go", newName: "randomPool", references: 2, expectedEditsByFile: map[string]int{"pkg/uuid.go": 1, "pkg/version4.go": 2}},
		{name: "rander", selectedPath: "pkg/uuid.go", newName: "randomReader", references: 5, expectedEditsByFile: map[string]int{"pkg/uuid.go": 3, "pkg/version4.go": 2, "pkg/util.go": 1}},
		{name: "xtob", selectedPath: "pkg/util.go", newName: "hexPairToByte", references: 6, expectedEditsByFile: map[string]int{"pkg/util.go": 1, "pkg/uuid.go": 6}},
	}
	for _, testCase := range renameCases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			request := goProjectRequest(files, testCase.selectedPath)
			catalog, err := buildProjectCatalog(request)
			if err != nil {
				t.Fatalf("catalog pinned upstream package subset: %v", err)
			}
			var selected binding
			for _, item := range catalog.Bindings {
				if item.FilePath == request.SelectedPath && item.Name == testCase.name {
					selected = item
					break
				}
			}
			if selected.ID == "" || selected.ReferenceCount != testCase.references {
				t.Fatalf("upstream %s binding = %+v; want %d resolved references", testCase.name, selected, testCase.references)
			}
			renameRequest := goProjectRequest(files, testCase.selectedPath)
			renameRequest.Operation = "project_rename"
			renameRequest.ExpectedHash = catalog.SelectedHash
			renameRequest.SourceSetHash = catalog.SourceSetHash
			renameRequest.Renames = []renameSelection{{ID: selected.ID, NewName: testCase.newName}}
			result, err := applyProjectRenames(renameRequest)
			if err != nil {
				t.Fatalf("rename upstream %s: %v", testCase.name, err)
			}
			outputs := outputsBeforeRename(files)
			editsByPath := make(map[string]int, len(testCase.expectedEditsByFile))
			for _, output := range result["files"].([]map[string]any) {
				path := output["relative_path"].(string)
				outputs[path] = output["source_code"].(string)
				original := string(sourceByPath[filepath.Base(path)])
				for _, edit := range output["edits"].([]map[string]any) {
					start, startOK := edit["start"].(int)
					end, endOK := edit["end"].(int)
					if edit["old_text"] != testCase.name || edit["new_text"] != testCase.newName || !startOK || !endOK || start < 0 || end > len(original) || original[start:end] != testCase.name {
						t.Fatalf("upstream edit for %s = %#v; want a byte-exact %s -> %s span", path, edit, testCase.name, testCase.newName)
					}
					editsByPath[path]++
				}
			}
			if !reflect.DeepEqual(editsByPath, testCase.expectedEditsByFile) {
				t.Fatalf("upstream edit manifest for %s = %v; want %v", testCase.name, editsByPath, testCase.expectedEditsByFile)
			}
			assertProjectPackageRenameBehavior(t, outputsBeforeRename(files), behaviorTest, "upstream UUID original")
			assertProjectPackageRenameBehavior(t, outputs, behaviorTest, "upstream UUID renamed "+testCase.name)
		})
	}
}

func assertProjectRenameBehavior(t *testing.T, files map[string]string, testSource, variant string) {
	t.Helper()
	assertProjectPackageRenameBehavior(t, files, "package sample\n\nimport \"testing\"\n\n"+testSource, variant)
}

func assertProjectPackageRenameBehavior(t *testing.T, files map[string]string, behaviorSource, variant string) {
	t.Helper()
	root, err := os.MkdirTemp("", "reamon-go-project-rename-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	packageDirectory := ""
	for filePath, source := range files {
		fullPath := filepath.Join(root, filepath.FromSlash(filePath))
		packageDirectory = filepath.Dir(fullPath)
		if err := os.MkdirAll(filepath.Dir(fullPath), 0o700); err != nil {
			t.Fatalf("create %s fixture directory: %v", variant, err)
		}
		if err := os.WriteFile(fullPath, []byte(source), 0o600); err != nil {
			t.Fatalf("write %s fixture source: %v", variant, err)
		}
	}
	behaviorPath := filepath.Join(packageDirectory, "corpus_behavior_test.go")
	if err := os.WriteFile(behaviorPath, []byte(behaviorSource), 0o600); err != nil {
		t.Fatalf("write %s behavior oracle: %v", variant, err)
	}
	command := exec.Command("go", "test", "-run", "^TestCorpus")
	command.Dir = packageDirectory
	command.Env = append(os.Environ(), "GO111MODULE=off", "GOTOOLCHAIN=local")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("%s runtime behavior oracle failed: %v\n%s", variant, err, output)
	}
}

func assertProjectModuleBehavior(t *testing.T, files map[string]string, goMod, variant string) {
	t.Helper()
	root, err := os.MkdirTemp("", "reamon-go-module-rename-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	if err := os.WriteFile(filepath.Join(root, "go.mod"), []byte(goMod), 0o600); err != nil {
		t.Fatalf("write %s module manifest: %v", variant, err)
	}
	for filePath, source := range files {
		fullPath := filepath.Join(root, filepath.FromSlash(filePath))
		if err := os.MkdirAll(filepath.Dir(fullPath), 0o700); err != nil {
			t.Fatalf("create %s fixture directory: %v", variant, err)
		}
		if err := os.WriteFile(fullPath, []byte(source), 0o600); err != nil {
			t.Fatalf("write %s fixture source: %v", variant, err)
		}
	}
	tests := map[string]string{
		"pkg": "package pkg\nimport \"testing\"\nfunc TestModuleMethodBehavior(t *testing.T) { if got := local(); got != 3 { t.Fatalf(\"local = %d\", got) } }\n",
		"cmd": "package main\nimport \"testing\"\nfunc TestModuleMethodBehavior(t *testing.T) { if got := Run(); got != 4 { t.Fatalf(\"Run = %d\", got) }; if got := Expression(); got != 5 { t.Fatalf(\"Expression = %d\", got) }; if got := MethodValue(); got != 6 { t.Fatalf(\"MethodValue = %d\", got) } }\n",
	}
	for directory, source := range tests {
		fullPath := filepath.Join(root, directory, "module_behavior_test.go")
		if err := os.WriteFile(fullPath, []byte(source), 0o600); err != nil {
			t.Fatalf("write %s behavior oracle: %v", variant, err)
		}
	}
	command := exec.Command("go", "test", "./...")
	command.Dir = root
	command.Env = append(os.Environ(), "GO111MODULE=on", "GOTOOLCHAIN=local", "GOSUMDB=off")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("%s module behavior oracle failed: %v\n%s", variant, err, output)
	}
}

func outputsBeforeRename(files []projectFile) map[string]string {
	outputs := make(map[string]string, len(files))
	for _, file := range files {
		outputs[file.Path] = file.Source
	}
	return outputs
}

func TestProjectMethodRenameRejectsChangedSourceSet(t *testing.T) {
	request := goProjectRequest([]projectFile{
		{Path: "pkg/a.go", Source: "package sample\ntype worker struct{}\nfunc (worker) normalize() int { return 1 }\n"},
		{Path: "pkg/b.go", Source: "package sample\nfunc run() int { return worker{}.normalize() }\n"},
	}, "pkg/a.go")
	cat, err := buildProjectCatalog(request)
	if err != nil {
		t.Fatal(err)
	}
	var selected binding
	for _, item := range cat.Bindings {
		if item.Name == "normalize" && item.Kind == "method" {
			selected = item
			break
		}
	}
	if selected.ID == "" {
		t.Fatal("receiver method was not offered as a binding")
	}
	request.Operation = "project_rename"
	request.ExpectedHash = cat.SelectedHash
	request.SourceSetHash = cat.SourceSetHash
	request.Renames = []renameSelection{{ID: selected.ID, NewName: "scale"}}
	request.Files[1].Source = "package sample\n// edited after the rename catalog was created\nfunc run() int { return worker{}.normalize() }\n"
	request.Files[1].ExpectedHash = hashText(request.Files[1].Source)
	if _, err := applyProjectRenames(request); err == nil || !strings.Contains(err.Error(), "source changed") {
		t.Fatalf("stale receiver-method source-set error = %v; want stale-snapshot rejection", err)
	}
}

func TestProjectCatalogRejectsIncompleteOrAmbiguousPackages(t *testing.T) {
	tests := []struct {
		name  string
		files []projectFile
	}{
		{name: "different directories", files: []projectFile{{Path: "a/a.go", Source: "package sample"}, {Path: "b/b.go", Source: "package sample"}}},
		{name: "different packages", files: []projectFile{{Path: "pkg/a.go", Source: "package sample"}, {Path: "pkg/b.go", Source: "package other"}}},
		{name: "unresolved type references", files: []projectFile{{Path: "pkg/a.go", Source: "package sample\nfunc normalize(value int) int { return missing(value) }"}, {Path: "pkg/b.go", Source: "package sample\nfunc run() int { return normalize(4) }"}}},
		{name: "invalid build constraints", files: []projectFile{{Path: "pkg/a.go", Source: "//go:build linux &&\npackage sample"}, {Path: "pkg/b.go", Source: "package sample"}}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := goProjectRequest(test.files, test.files[0].Path)
			if _, err := buildProjectCatalog(request); err == nil {
				t.Fatal("incomplete or ambiguous Go package was accepted")
			}
		})
	}
}

func TestProjectCatalogExcludesExportedPackageAPIs(t *testing.T) {
	request := goProjectRequest([]projectFile{
		{Path: "pkg/api.go", Source: "package sample\n\nfunc Public(value int) int { return private(value) }\nfunc private(value int) int { return value + 1 }\n"},
		{Path: "pkg/use.go", Source: "package sample\n\nfunc call() int { return Public(4) }\n"},
	}, "pkg/api.go")
	catalog, err := buildProjectCatalog(request)
	if err != nil {
		t.Fatalf("build exported API package catalog: %v", err)
	}
	var privateBinding binding
	for _, item := range catalog.Bindings {
		if item.Name == "Public" || item.Exported {
			t.Fatalf("exported package API was offered for rename: %+v", item)
		}
		if item.Name == "private" {
			privateBinding = item
		}
	}
	if privateBinding.ID == "" || privateBinding.ReferenceCount != 1 {
		t.Fatalf("private package binding = %+v; want a selectable same-package binding with one reference", privateBinding)
	}
}

func TestProjectCatalogReportsPackageInventoryIncludingUnreferencedSymbols(t *testing.T) {
	request := goProjectRequest([]projectFile{
		{Path: "pkg/api.go", Source: "package sample\nfunc Public(value int) int { return private(value) }\nfunc private(value int) int { return value + 1 }\n"},
		{Path: "pkg/use.go", Source: "package sample\nfunc init() {}\nfunc call() int { return Public(4) }\n"},
	}, "pkg/api.go")
	catalog, err := buildProjectCatalog(request)
	if err != nil {
		t.Fatalf("build package inventory: %v", err)
	}
	want := projectInventory{
		SourceFileCount: 2, PrivatePackageSymbolCount: 2,
		ReferencedPrivatePackageSymbols: 1, UnreferencedPrivateSymbols: 1,
		ExportedPackageSymbolCount: 1, UnsupportedPackageSymbolCount: 1, EntryCount: 6,
		LocalSymbolCount: 2, ReferencedLocalSymbols: 2,
	}
	gotCounts := catalog.Inventory
	gotCounts.Entries = nil
	if !reflect.DeepEqual(gotCounts, want) {
		t.Fatalf("package inventory = %+v; want %+v", catalog.Inventory, want)
	}
	entries := make(map[string]projectInventoryEntry, len(catalog.Inventory.Entries))
	for _, entry := range catalog.Inventory.Entries {
		entries[entry.Name] = entry
	}
	if catalog.Inventory.EntryCount != 6 || catalog.Inventory.EntriesTruncated ||
		entries["Public"].Classification != "excluded" ||
		entries["private"].Classification != "eligible" ||
		entries["call"].Classification != "excluded" ||
		entries["init"].Classification != "unsupported" ||
		entries["private"].ReferenceCount != 1 ||
		entries["call"].ClassificationReason != "unreferenced-package-symbol" ||
		entries["private"].NameAssessment != "unassessed" {
		t.Fatalf("package inventory entries = %+v; want classified, exact per-symbol rows", catalog.Inventory.Entries)
	}
}

func TestProjectCatalogOmitsBlankIdentifiersFromInventory(t *testing.T) {
	request := goProjectRequest([]projectFile{{
		Path:   "pkg/blank.go",
		Source: "package sample\nfunc sum(values []int) int {\n\ttotal := 0\n\tfor _, value := range values { total += value }\n\treturn total\n}\n",
	}}, "pkg/blank.go")
	catalog, err := buildProjectCatalog(request)
	if err != nil {
		t.Fatalf("build inventory with blank range identifier: %v", err)
	}
	for _, entry := range catalog.Inventory.Entries {
		if entry.Name == "_" {
			t.Fatalf("blank identifier was inventoried as a symbol: %+v", entry)
		}
	}
	if catalog.Inventory.LocalSymbolCount != 3 {
		t.Fatalf("local symbol count = %d; want only values, total, and the range value", catalog.Inventory.LocalSymbolCount)
	}
}

func TestProjectCatalogInventoriesFunctionLocalsAndCountsResolvedReferences(t *testing.T) {
	request := goProjectRequest([]projectFile{
		{Path: "pkg/locals.go", Source: "package sample\nfunc call(input int) (result int) {\n\tvar declared int\n\tdeclared = input\n\tshort := declared\n\tconst used = 1\n\tconst unused = 2\n\ttype Used int\n\ttype Unused int\n\ttype Record struct { Field int }\n\tvalue := Used(short)\n\t_ = Record{Field: int(value)}\n\treturn int(value) + used\n}\n"},
		{Path: "pkg/use.go", Source: "package sample\nfunc wrapper() int { return call(3) }\n"},
	}, "pkg/locals.go")
	catalog, err := buildProjectCatalog(request)
	if err != nil {
		t.Fatalf("build local symbol inventory: %v", err)
	}
	if catalog.Inventory.LocalSymbolCount != 11 || catalog.Inventory.ReferencedLocalSymbols != 7 ||
		catalog.Inventory.UnreferencedLocalSymbols != 3 || catalog.Inventory.UnsupportedLocalSymbolCount != 1 ||
		catalog.Inventory.EntryCount != 13 || catalog.Inventory.EntriesTruncated {
		t.Fatalf("local inventory counts = %+v; want 11 locals (7 referenced, 3 unreferenced, 1 unsupported) and 13 total rows", catalog.Inventory)
	}
	entries := make(map[string]projectInventoryEntry, len(catalog.Inventory.Entries))
	for _, entry := range catalog.Inventory.Entries {
		if entry.Scope == "local" {
			entries[entry.Name] = entry
		}
	}
	for _, name := range []string{"input", "declared", "short", "used", "Used", "Record", "value"} {
		if entries[name].Classification != "eligible" || entries[name].Scope != "local" {
			t.Errorf("local %q = %+v; want referenced eligible local", name, entries[name])
		}
	}
	for _, name := range []string{"result", "unused", "Unused"} {
		if entries[name].Classification != "excluded" || entries[name].ReferenceCount != 0 {
			t.Errorf("local %q = %+v; want unreferenced excluded local", name, entries[name])
		}
	}
	if entries["Field"].Kind != "local struct field" || entries["Field"].Classification != "unsupported" ||
		entries["Field"].ClassificationReason != "local-struct-field-out-of-scope" || entries["Field"].ReferenceCount != 1 {
		t.Errorf("local struct field = %+v; want unsupported with its resolved keyed-literal use", entries["Field"])
	}
}

func TestProjectCatalogInventoriesImplicitTypeSwitchBindings(t *testing.T) {
	request := goProjectRequest([]projectFile{
		{
			Path:   "pkg/switch.go",
			Source: "package sample\nfunc inspect(value any) int {\n\tswitch item := value.(type) {\n\tcase int:\n\t\treturn item\n\tcase string:\n\t\treturn len(item)\n\tdefault:\n\t\treturn len(item.(interface{ String() string }).String())\n\t}\n}\n",
		},
		{Path: "pkg/helper.go", Source: "package sample\nfunc helper() {}\n"},
	}, "pkg/switch.go")
	catalog, err := buildProjectCatalog(request)
	if err != nil {
		t.Fatalf("build type-switch local inventory: %v", err)
	}
	var switchBindings []projectInventoryEntry
	for _, entry := range catalog.Inventory.Entries {
		if entry.Scope == "local" && entry.Name == "item" {
			switchBindings = append(switchBindings, entry)
		}
	}
	if len(switchBindings) != 3 {
		t.Fatalf("type-switch bindings = %+v; want one binding per case clause", switchBindings)
	}
	ids := make(map[string]struct{}, len(switchBindings))
	for _, entry := range switchBindings {
		if entry.Kind != "local type-switch variable" || entry.Classification != "eligible" || entry.ReferenceCount != 1 {
			t.Errorf("type-switch binding = %+v; want a referenced, eligible case-scoped local", entry)
		}
		if _, exists := ids[entry.ID]; exists {
			t.Errorf("type-switch binding ID %q is not unique across case scopes", entry.ID)
		}
		ids[entry.ID] = struct{}{}
	}
}

func TestProjectCatalogInventoriesFileScopedGoImportBindings(t *testing.T) {
	request := goProjectRequest([]projectFile{
		{
			Path:   "pkg/imports.go",
			Source: "package sample\nimport (\n\tformatter \"fmt\"\n\t\"strings\"\n\t. \"unicode\"\n\t_ \"net/http/pprof\"\n)\nfunc render(value string) string { return formatter.Sprint(strings.TrimSpace(value), IsGraphic('a')) }\n",
		},
		{Path: "pkg/run.go", Source: "package sample\nfunc run() string { return render(\" value \") }\n"},
	}, "pkg/imports.go")
	catalog, err := buildProjectCatalog(request)
	if err != nil {
		t.Fatalf("build file-scope import inventory: %v", err)
	}
	if catalog.Inventory.FileScopeSymbolCount != 3 || catalog.Inventory.ReferencedFileScopeSymbols != 2 ||
		catalog.Inventory.UnreferencedFileScopeSymbols != 0 || catalog.Inventory.UnsupportedFileScopeSymbolCount != 1 {
		t.Fatalf("file-scope counts = %+v; want two referenced aliases and one unsupported dot import (blank imports omitted)", catalog.Inventory)
	}
	imports := make(map[string]projectInventoryEntry, 3)
	for _, entry := range catalog.Inventory.Entries {
		if entry.Scope == "file" {
			imports[entry.Name] = entry
		}
	}
	for _, name := range []string{"formatter", "strings"} {
		entry := imports[name]
		if entry.ID == "" || entry.Kind != "file import alias" || entry.Classification != "eligible" || entry.ReferenceCount != 1 {
			t.Errorf("file import %q = %+v; want one referenced file-scope alias", name, entry)
		}
	}
	if entry := imports["."]; entry.Kind != "dot import" || entry.Classification != "unsupported" ||
		entry.ClassificationReason != "dot-import-out-of-scope" {
		t.Errorf("dot import = %+v; want an explicit unsupported file-scope row", entry)
	}
}

func TestProjectCatalogKeepsLocalInterfaceMethodsAndLabelsUnsupported(t *testing.T) {
	request := goProjectRequest([]projectFile{
		{Path: "pkg/locals.go", Source: "package sample\nfunc inspect(value int) int {\n\ttype Runner interface { Run() int }\n\tvar runner Runner\n\tgoto done\n done:\n\treturn runner.Run() + value\n}\n"},
		{Path: "pkg/use.go", Source: "package sample\nfunc use() int { return inspect(1) }\n"},
	}, "pkg/locals.go")
	catalog, err := buildProjectCatalog(request)
	if err != nil {
		t.Fatalf("build interface and label inventory: %v", err)
	}
	if catalog.Inventory.LocalSymbolCount != 5 || catalog.Inventory.ReferencedLocalSymbols != 3 ||
		catalog.Inventory.UnreferencedLocalSymbols != 0 || catalog.Inventory.UnsupportedLocalSymbolCount != 2 {
		t.Fatalf("local scope counts = %+v; want three referenced supported bindings and two unsupported objects", catalog.Inventory)
	}
	entries := make(map[string]projectInventoryEntry, 5)
	for _, entry := range catalog.Inventory.Entries {
		if entry.Scope == "local" {
			entries[entry.Name] = entry
		}
	}
	for _, name := range []string{"value", "Runner", "runner"} {
		if entry := entries[name]; entry.Classification != "eligible" {
			t.Errorf("supported local %q = %+v; want eligible", name, entry)
		}
	}
	for name, reason := range map[string]string{"Run": "local-interface-method-out-of-scope", "done": "local-label-out-of-scope"} {
		if entry := entries[name]; entry.Classification != "unsupported" || entry.ClassificationReason != reason || entry.ReferenceCount != 1 {
			t.Errorf("unsupported local %q = %+v; want reason %q and one resolved reference", name, entry, reason)
		}
	}
}

func TestProjectInventoryAggregatesCompleteGoPackagesAcrossDirectories(t *testing.T) {
	request := goProjectRequest([]projectFile{
		{Path: "core/model.go", Source: "package core\nfunc normalize(value int) int { return value + 1 }\n"},
		{Path: "core/use.go", Source: "package core\nfunc use() int { return normalize(4) }\n"},
		{Path: "cmd/run.go", Source: "package cmd\nfunc run() int { return load() }\n"},
		{Path: "cmd/data.go", Source: "package cmd\nfunc load() int { return 7 }\n"},
	}, "core/model.go")
	request.Operation = "project_inventory"
	buildContext, err := normalizeGoBuildContext(request)
	if err != nil {
		t.Fatal(err)
	}

	result, err := listProjectInventory(request)
	if err != nil {
		t.Fatalf("inventory Go project: %v", err)
	}
	inventory := result["inventory"].(map[string]any)
	if inventory["scope"] != "verified-whole-project-go-source-snapshot" || inventory["complete"] != true ||
		inventory["source_file_count"] != 4 || inventory["package_count"] != 2 ||
		inventory["private_package_symbol_count"] != 4 || inventory["referenced_private_package_symbols"] != 2 ||
		inventory["unreferenced_private_symbols"] != 2 || inventory["entry_count"] != 5 || inventory["entries_truncated"] != false {
		t.Fatalf("whole-project inventory summary = %#v", inventory)
	}
	entries := inventory["entries"].([]projectInventoryEntry)
	if len(entries) != 5 {
		t.Fatalf("inventory entries = %d; want all four package functions and one local parameter", len(entries))
	}
	packagePaths := make(map[string]bool)
	ids := make(map[string]bool)
	for _, entry := range entries {
		packagePaths[entry.RelativePath] = true
		if ids[entry.ID] {
			t.Fatalf("duplicate project inventory ID %q", entry.ID)
		}
		ids[entry.ID] = true
	}
	if !packagePaths["core/model.go"] || !packagePaths["core/use.go"] || !packagePaths["cmd/run.go"] || !packagePaths["cmd/data.go"] {
		t.Fatalf("inventory paths = %#v; want rows from both package directories", packagePaths)
	}
	if len(result["packages"].([]map[string]any)) != 2 || result["source_set_sha256"] != hashProjectSources([]projectSourceFile{
		{Path: "core/model.go", Text: request.Files[0].Source},
		{Path: "core/use.go", Text: request.Files[1].Source},
		{Path: "cmd/run.go", Text: request.Files[2].Source},
		{Path: "cmd/data.go", Text: request.Files[3].Source},
	}) || result["inventory_scope_sha256"] != hashProjectInventory([]projectSourceFile{
		{Path: "core/model.go", Text: request.Files[0].Source},
		{Path: "core/use.go", Text: request.Files[1].Source},
		{Path: "cmd/run.go", Text: request.Files[2].Source},
		{Path: "cmd/data.go", Text: request.Files[3].Source},
	}, buildContext) {
		t.Fatalf("project snapshot metadata = %#v", result)
	}
}

func TestProjectInventoryMatchesHashPinnedUpstreamCorpusV1(t *testing.T) {
	manifestBytes, err := os.ReadFile(filepath.Join("testdata", "project_inventory_v1.json"))
	if err != nil {
		t.Fatalf("read project inventory corpus manifest: %v", err)
	}
	var corpus projectInventoryCorpus
	if err := json.Unmarshal(manifestBytes, &corpus); err != nil {
		t.Fatalf("parse project inventory corpus manifest: %v", err)
	}
	if corpus.Version != 1 || len(corpus.Fixtures) != 2 {
		t.Fatalf("project inventory corpus version/fixture count = %d/%d; want 1/2", corpus.Version, len(corpus.Fixtures))
	}
	for _, fixture := range corpus.Fixtures {
		t.Run(fixture.Name, func(t *testing.T) {
			files := make([]projectFile, 0, len(fixture.Files))
			for _, file := range fixture.Files {
				contents, err := os.ReadFile(filepath.Join("testdata", filepath.FromSlash(file.FixturePath)))
				if err != nil {
					t.Fatalf("read pinned source %s: %v", file.FixturePath, err)
				}
				source := string(contents)
				if actual := hashText(source); actual != file.SHA256 {
					t.Fatalf("pinned source hash for %s = %s; want %s", file.FixturePath, actual, file.SHA256)
				}
				files = append(files, projectFile{Path: file.InventoryPath, Source: source, ExpectedHash: file.SHA256})
			}
			if len(fixture.BuildContexts) == 0 {
				t.Fatal("fixture has no pinned build contexts")
			}
			request := goProjectRequest(files, fixture.SelectedPath)
			request.Operation = "project_inventory"
			request.ModulePath = fixture.ModulePath
			request.GoMod = fixture.GoMod
			request.GoModHash = hashText(fixture.GoMod)
			request.BuildGOOS, request.BuildGOARCH = fixture.BuildContexts[0].GOOS, fixture.BuildContexts[0].GOARCH
			result, err := listProjectInventory(request)
			if err != nil {
				t.Fatalf("inventory hash-pinned upstream sources: %v", err)
			}
			inventory := result["inventory"].(map[string]any)
			selectedFiles := selectProjectFilesForBuildContext(t, files, fixture.BuildContexts[0].GOOS, fixture.BuildContexts[0].GOARCH)
			gold := independentAllDeclarationKeys(t, selectedFiles, fixture.ModulePath)
			allScopeTP, allScopeFP, allScopeFN := logProjectInventoryDeclarationAccuracy(t, inventory["entries"].([]projectInventoryEntry), gold)
			assertProjectInventoryDeclarationAccuracy(t, allScopeTP, allScopeFP, allScopeFN, fixture)
			counts := map[string]int{
				"source_file_count":                   inventory["source_file_count"].(int),
				"package_count":                       inventory["package_count"].(int),
				"private_package_symbol_count":        inventory["private_package_symbol_count"].(int),
				"referenced_private_package_symbols":  inventory["referenced_private_package_symbols"].(int),
				"unreferenced_private_symbols":        inventory["unreferenced_private_symbols"].(int),
				"exported_package_symbol_count":       inventory["exported_package_symbol_count"].(int),
				"unsupported_package_symbol_count":    inventory["unsupported_package_symbol_count"].(int),
				"file_scope_symbol_count":             inventory["file_scope_symbol_count"].(int),
				"referenced_file_scope_symbols":       inventory["referenced_file_scope_symbols"].(int),
				"unreferenced_file_scope_symbols":     inventory["unreferenced_file_scope_symbols"].(int),
				"unsupported_file_scope_symbol_count": inventory["unsupported_file_scope_symbol_count"].(int),
				"local_symbol_count":                  inventory["local_symbol_count"].(int),
				"referenced_local_symbols":            inventory["referenced_local_symbols"].(int),
				"unreferenced_local_symbols":          inventory["unreferenced_local_symbols"].(int),
				"unsupported_local_symbol_count":      inventory["unsupported_local_symbol_count"].(int),
				"member_symbol_count":                 inventory["member_symbol_count"].(int),
				"unsupported_member_symbol_count":     inventory["unsupported_member_symbol_count"].(int),
				"entry_count":                         inventory["entry_count"].(int),
			}
			if !reflect.DeepEqual(counts, fixture.Expected) {
				t.Fatalf("inventory counts = %#v; want pinned counts %#v", counts, fixture.Expected)
			}
			for _, build := range fixture.BuildContexts[1:] {
				alternateRequest := request
				alternateRequest.BuildGOOS, alternateRequest.BuildGOARCH = build.GOOS, build.GOARCH
				alternateResult, err := listProjectInventory(alternateRequest)
				if err != nil {
					t.Fatalf("inventory pinned sources for %s/%s: %v", build.GOOS, build.GOARCH, err)
				}
				alternateInventory := alternateResult["inventory"].(map[string]any)
				selectedFiles := selectProjectFilesForBuildContext(t, files, build.GOOS, build.GOARCH)
				gold := independentAllDeclarationKeys(t, selectedFiles, fixture.ModulePath)
				allScopeTP, allScopeFP, allScopeFN := logProjectInventoryDeclarationAccuracy(t, alternateInventory["entries"].([]projectInventoryEntry), gold)
				assertProjectInventoryDeclarationAccuracy(t, allScopeTP, allScopeFP, allScopeFN, fixture)
				for field, expected := range fixture.Expected {
					if actual, ok := alternateInventory[field].(int); !ok || actual != expected {
						t.Fatalf("%s/%s inventory %s = %v; want pinned count %d", build.GOOS, build.GOARCH, field, alternateInventory[field], expected)
					}
				}
			}
			entries := inventory["entries"].([]projectInventoryEntry)
			if inventory["complete"] != true || inventory["entries_truncated"] != false || len(entries) != counts["entry_count"] {
				t.Fatalf("inventory completeness/truncation/entries = %v/%v/%d", inventory["complete"], inventory["entries_truncated"], len(entries))
			}
			packages := result["packages"].([]map[string]any)
			if len(packages) != 1 || packages[0]["directory"] != path.Dir(fixture.SelectedPath) || packages[0]["package_name"] != fixture.PackageName {
				t.Fatalf("inventory packages = %#v; want one %s package in %s", packages, fixture.PackageName, path.Dir(fixture.SelectedPath))
			}
			gotPaths := make([]string, 0, len(result["files"].([]map[string]any)))
			for _, file := range result["files"].([]map[string]any) {
				gotPaths = append(gotPaths, file["relative_path"].(string))
			}
			wantPaths := make([]string, 0, len(fixture.Files))
			for _, file := range fixture.Files {
				wantPaths = append(wantPaths, file.InventoryPath)
			}
			sort.Strings(wantPaths)
			if !reflect.DeepEqual(gotPaths, wantPaths) {
				t.Fatalf("inventory file paths = %#v; want %#v", gotPaths, wantPaths)
			}
		})
	}
}

func TestProjectInventoryHeldOutPackageSymbolPrecisionRecallV1(t *testing.T) {
	manifestBytes, err := os.ReadFile(filepath.Join("testdata", "project_inventory_holdout_v1.json"))
	if err != nil {
		t.Fatalf("read held-out project inventory manifest: %v", err)
	}
	var corpus projectInventoryRecallCorpus
	if err := json.Unmarshal(manifestBytes, &corpus); err != nil {
		t.Fatalf("parse held-out project inventory manifest: %v", err)
	}
	if corpus.Version != 1 || len(corpus.Fixtures) != 4 {
		t.Fatalf("held-out corpus version/fixture count = %d/%d; want 1/4", corpus.Version, len(corpus.Fixtures))
	}

	for _, fixture := range corpus.Fixtures {
		t.Run(fixture.Name, func(t *testing.T) {
			goModBytes, err := os.ReadFile(filepath.Join("testdata", filepath.FromSlash(fixture.GoModFixture)))
			if err != nil {
				t.Fatalf("read pinned go.mod: %v", err)
			}
			if actual := hashText(string(goModBytes)); actual != fixture.GoModSHA256 {
				t.Fatalf("go.mod SHA-256 = %s; want %s", actual, fixture.GoModSHA256)
			}
			var goSum string
			if fixture.GoSumFixture != "" {
				goSumBytes, err := os.ReadFile(filepath.Join("testdata", filepath.FromSlash(fixture.GoSumFixture)))
				if err != nil {
					t.Fatalf("read pinned go.sum: %v", err)
				}
				if actual := hashText(string(goSumBytes)); actual != fixture.GoSumSHA256 {
					t.Fatalf("go.sum SHA-256 = %s; want %s", actual, fixture.GoSumSHA256)
				}
				goSum = string(goSumBytes)
			}

			files := make([]projectFile, 0, len(fixture.Files))
			for _, source := range fixture.Files {
				contents, err := os.ReadFile(filepath.Join("testdata", filepath.FromSlash(source.FixturePath)))
				if err != nil {
					t.Fatalf("read pinned held-out source %s: %v", source.FixturePath, err)
				}
				if actual := hashText(string(contents)); actual != source.SHA256 {
					t.Fatalf("source SHA-256 for %s = %s; want %s", source.FixturePath, actual, source.SHA256)
				}
				files = append(files, projectFile{Path: source.InventoryPath, Source: string(contents), ExpectedHash: source.SHA256})
			}

			for _, target := range fixture.BuildContexts {
				t.Run(target.GOOS+"_"+target.GOARCH, func(t *testing.T) {
					sourceRoot := t.TempDir()
					buildContext := gobuild.Default
					buildContext.GOOS, buildContext.GOARCH, buildContext.CgoEnabled = target.GOOS, target.GOARCH, false
					selectedFiles := make([]projectFile, 0, len(files))
					for _, source := range files {
						if err := os.WriteFile(filepath.Join(sourceRoot, filepath.Base(source.Path)), []byte(source.Source), 0o600); err != nil {
							t.Fatalf("write source for independent Go build selection: %v", err)
						}
						matches, err := buildContext.MatchFile(sourceRoot, filepath.Base(source.Path))
						if err != nil {
							t.Fatalf("Go toolchain build selection for %s: %v", source.Path, err)
						}
						if matches {
							selectedFiles = append(selectedFiles, source)
						}
					}
					if !containsProjectPath(selectedFiles, target.SelectedPath) {
						t.Fatalf("selected path %s is absent from the independent Go build selection", target.SelectedPath)
					}

					gold := independentPackageDeclarationKeys(t, selectedFiles)
					allGold := independentAllDeclarationKeys(t, selectedFiles, fixture.ModulePath)
					request := goProjectRequest(files, target.SelectedPath)
					request.Operation, request.ModulePath = "project_inventory", fixture.ModulePath
					request.GoMod, request.GoModHash = string(goModBytes), fixture.GoModSHA256
					request.GoSum, request.GoSumHash = goSum, fixture.GoSumSHA256
					request.BuildGOOS, request.BuildGOARCH = target.GOOS, target.GOARCH
					result, err := listProjectInventory(request)
					if err != nil {
						t.Fatalf("inventory held-out project: %v", err)
					}
					inventory := result["inventory"].(map[string]any)
					if inventory["complete"] != true || inventory["entries_truncated"] != false {
						t.Fatalf("inventory completeness/truncation = %v/%v", inventory["complete"], inventory["entries_truncated"])
					}
					if inventory["member_symbol_count"] != target.ExpectedMemberCount || inventory["unsupported_member_symbol_count"] != target.ExpectedMemberCount {
						t.Fatalf("member inventory counts = %v/%v; want %d unsupported rows", inventory["member_symbol_count"], inventory["unsupported_member_symbol_count"], target.ExpectedMemberCount)
					}

					actual := make(map[string]bool)
					allActual := make(map[string]bool)
					duplicateCount := 0
					for _, entry := range inventory["entries"].([]projectInventoryEntry) {
						if entry.Scope == "member" && (entry.Classification != "unsupported" || entry.ClassificationReason != "go-member-not-offered-by-project-inventory") {
							t.Fatalf("member entry %q is not marked as unsupported: %#v", entry.Name, entry)
						}
						key := projectDeclarationKey(entry.RelativePath, entry.DeclarationStart, entry.Name)
						if allActual[key] {
							duplicateCount++
						}
						allActual[key] = true
						if entry.Scope != "package" {
							continue
						}
						if actual[key] {
							continue
						}
						actual[key] = true
					}
					truePositives := 0
					for key := range gold {
						if actual[key] {
							truePositives++
						}
					}
					falsePositives := len(actual) - truePositives + duplicateCount
					falseNegatives := len(gold) - truePositives
					precision := float64(truePositives) / float64(truePositives+falsePositives)
					recall := float64(truePositives) / float64(truePositives+falseNegatives)
					t.Logf("held-out package declaration identity: precision %.4f, recall %.4f, TP=%d FP=%d FN=%d (duplicate=%d)", precision, recall, truePositives, falsePositives, falseNegatives, duplicateCount)
					allTP := 0
					for key := range allGold {
						if allActual[key] {
							allTP++
						}
					}
					allFP, allFN := len(allActual)-allTP+duplicateCount, len(allGold)-allTP
					allPrecision := float64(allTP) / float64(allTP+allFP)
					allRecall := float64(allTP) / float64(allTP+allFN)
					t.Logf("held-out all-scope declaration identity: precision %.4f, recall %.4f, TP=%d FP=%d FN=%d", allPrecision, allRecall, allTP, allFP, allFN)
					if allTP != target.ExpectedAllScopeTP || allFP != target.ExpectedAllScopeFP || allFN != target.ExpectedAllScopeFN {
						var allMissing, allUnexpected []string
						for key := range allGold {
							if !allActual[key] {
								allMissing = append(allMissing, key)
							}
						}
						for key := range allActual {
							if !allGold[key] {
								allUnexpected = append(allUnexpected, key)
							}
						}
						sort.Strings(allMissing)
						sort.Strings(allUnexpected)
						t.Logf("all-scope false positives: %v", allUnexpected)
						t.Logf("all-scope false negatives: %v", allMissing)
						t.Fatalf("all-scope declaration metrics = TP/FP/FN %d/%d/%d; want %d/%d/%d", allTP, allFP, allFN, target.ExpectedAllScopeTP, target.ExpectedAllScopeFP, target.ExpectedAllScopeFN)
					}
					if truePositives != target.ExpectedPackageTP || falsePositives != target.ExpectedPackageFP || falseNegatives != target.ExpectedPackageFN {
						t.Fatalf("package declaration metrics = TP/FP/FN %d/%d/%d; want %d/%d/%d", truePositives, falsePositives, falseNegatives, target.ExpectedPackageTP, target.ExpectedPackageFP, target.ExpectedPackageFN)
					}
					if falsePositives != 0 || falseNegatives != 0 {
						var missing, unexpected []string
						for key := range gold {
							if !actual[key] {
								missing = append(missing, key)
							}
						}
						for key := range actual {
							if !gold[key] {
								unexpected = append(unexpected, key)
							}
						}
						sort.Strings(missing)
						sort.Strings(unexpected)
						t.Fatalf("package declaration identity mismatch: missing=%v unexpected=%v duplicates=%d", missing, unexpected, duplicateCount)
					}
				})
			}
		})
	}
}

func assertProjectInventoryDeclarationAccuracy(t *testing.T, truePositives, falsePositives, falseNegatives int, fixture projectInventoryFixture) {
	t.Helper()
	if truePositives != fixture.ExpectedAllScopeTP || falsePositives != fixture.ExpectedAllScopeFP || falseNegatives != fixture.ExpectedAllScopeFN {
		t.Fatalf("all-scope declaration metrics = TP/FP/FN %d/%d/%d; want %d/%d/%d", truePositives, falsePositives, falseNegatives, fixture.ExpectedAllScopeTP, fixture.ExpectedAllScopeFP, fixture.ExpectedAllScopeFN)
	}
}

func selectProjectFilesForBuildContext(t *testing.T, files []projectFile, goos, goarch string) []projectFile {
	t.Helper()
	sourceRoot := t.TempDir()
	buildContext := gobuild.Default
	buildContext.GOOS, buildContext.GOARCH, buildContext.CgoEnabled = goos, goarch, false
	selected := make([]projectFile, 0, len(files))
	for _, source := range files {
		name := filepath.Base(source.Path)
		if err := os.WriteFile(filepath.Join(sourceRoot, name), []byte(source.Source), 0o600); err != nil {
			t.Fatalf("write source for independent Go build selection: %v", err)
		}
		matches, err := buildContext.MatchFile(sourceRoot, name)
		if err != nil {
			t.Fatalf("Go toolchain build selection for %s: %v", source.Path, err)
		}
		if matches {
			selected = append(selected, source)
		}
	}
	if len(selected) == 0 {
		t.Fatalf("Go build selection produced no source files for %s/%s", goos, goarch)
	}
	return selected
}

func logProjectInventoryDeclarationAccuracy(t *testing.T, entries []projectInventoryEntry, gold map[string]bool) (truePositives, falsePositives, falseNegatives int) {
	t.Helper()
	actual := make(map[string]bool, len(entries))
	duplicates := 0
	for _, entry := range entries {
		key := projectDeclarationKey(entry.RelativePath, entry.DeclarationStart, entry.Name)
		if actual[key] {
			duplicates++
		}
		actual[key] = true
	}
	for key := range gold {
		if actual[key] {
			truePositives++
		}
	}
	falsePositives = len(actual) - truePositives + duplicates
	falseNegatives = len(gold) - truePositives
	precision := float64(truePositives) / float64(truePositives+falsePositives)
	recall := float64(truePositives) / float64(truePositives+falseNegatives)
	t.Logf("independent all-scope declaration census: precision %.4f, recall %.4f, TP=%d FP=%d FN=%d (duplicate=%d)", precision, recall, truePositives, falsePositives, falseNegatives, duplicates)
	return truePositives, falsePositives, falseNegatives
}

func independentAllDeclarationKeys(t *testing.T, files []projectFile, importPath string) map[string]bool {
	t.Helper()
	fileSet := token.NewFileSet()
	astFiles := make([]*ast.File, 0, len(files))
	for _, file := range files {
		parsed, err := parser.ParseFile(fileSet, file.Path, file.Source, parser.AllErrors)
		if err != nil {
			t.Fatalf("independent Go AST parse for %s: %v", file.Path, err)
		}
		astFiles = append(astFiles, parsed)
	}
	info := &types.Info{
		Defs: make(map[*ast.Ident]types.Object), Implicits: make(map[ast.Node]types.Object),
		Uses: make(map[*ast.Ident]types.Object), Scopes: make(map[ast.Node]*types.Scope),
	}
	packageInfo, err := (&types.Config{Importer: importer.Default()}).Check(importPath, fileSet, astFiles, info)
	if err != nil {
		t.Fatalf("independent Go type-check for declaration census: %v", err)
	}
	keys := make(map[string]bool)
	add := func(filePath string, pos token.Pos, name string) {
		if name == "" || name == "_" {
			return
		}
		position := fileSet.PositionFor(pos, false)
		keys[projectDeclarationKey(filePath, position.Offset, name)] = true
	}
	for _, file := range astFiles {
		for identifier, object := range info.Defs {
			if object == nil || object.Name() == "_" || fileSet.PositionFor(identifier.Pos(), false).Filename != fileSet.PositionFor(file.Pos(), false).Filename {
				continue
			}
			add(fileSet.PositionFor(identifier.Pos(), false).Filename, identifier.Pos(), identifier.Name)
		}
		ast.Inspect(file, func(node ast.Node) bool {
			clause, ok := node.(*ast.FuncDecl)
			if ok && clause.Name.Name == "init" {
				add(fileSet.PositionFor(clause.Name.Pos(), false).Filename, clause.Name.Pos(), clause.Name.Name)
			}
			return true
		})
	}
	for node, object := range info.Implicits {
		if object == nil || object.Name() == "_" {
			continue
		}
		position := node.Pos()
		if spec, ok := node.(*ast.ImportSpec); ok {
			position = spec.Path.Pos()
		}
		add(fileSet.PositionFor(position, false).Filename, position, object.Name())
	}
	if packageInfo == nil {
		t.Fatal("independent Go type-check returned no package")
	}
	return keys
}

func containsProjectPath(files []projectFile, wanted string) bool {
	for _, file := range files {
		if file.Path == wanted {
			return true
		}
	}
	return false
}

func projectDeclarationKey(filePath string, offset int, name string) string {
	return fmt.Sprintf("%s:%d:%s", filePath, offset, name)
}

func independentPackageDeclarationKeys(t *testing.T, files []projectFile) map[string]bool {
	t.Helper()
	keys := make(map[string]bool)
	for _, file := range files {
		fileSet := token.NewFileSet()
		parsed, err := parser.ParseFile(fileSet, file.Path, file.Source, parser.AllErrors)
		if err != nil {
			t.Fatalf("independent Go AST parse for %s: %v", file.Path, err)
		}
		add := func(identifier *ast.Ident) {
			if identifier == nil || identifier.Name == "_" {
				return
			}
			position := fileSet.PositionFor(identifier.Pos(), false)
			keys[projectDeclarationKey(file.Path, position.Offset, identifier.Name)] = true
		}
		for _, declaration := range parsed.Decls {
			switch declaration := declaration.(type) {
			case *ast.FuncDecl:
				if declaration.Recv == nil {
					add(declaration.Name)
				}
			case *ast.GenDecl:
				if declaration.Tok != token.CONST && declaration.Tok != token.TYPE && declaration.Tok != token.VAR {
					continue
				}
				for _, spec := range declaration.Specs {
					switch spec := spec.(type) {
					case *ast.TypeSpec:
						add(spec.Name)
					case *ast.ValueSpec:
						for _, name := range spec.Names {
							add(name)
						}
					}
				}
			}
		}
	}
	return keys
}

func TestProjectInventoryResolvesImportsBetweenModulePackages(t *testing.T) {
	request := goProjectRequest([]projectFile{
		{Path: "src/lib/lib.go", Source: "package lib\ntype Item struct { Value int }\nfunc Make() Item { return Item{Value: 7} }\n"},
		{Path: "src/cmd/main.go", Source: "package main\nimport dep \"example.test/project/lib\"\nfunc main() { item := dep.Make(); _ = item.Value }\n"},
	}, "src/cmd/main.go")
	request.Operation = "project_inventory"
	request.ModulePath = "example.test/project"
	request.ModuleRoot = "src"
	request.GoMod = "module example.test/project\n\ngo 1.24\n"
	request.GoModHash = hashText(request.GoMod)

	result, err := listProjectInventory(request)
	if err != nil {
		t.Fatalf("inventory module with local package import: %v", err)
	}
	inventory := result["inventory"].(map[string]any)
	if inventory["complete"] != true || inventory["source_file_count"] != 2 || inventory["package_count"] != 2 {
		t.Fatalf("module inventory summary = %#v", inventory)
	}
	entries := inventory["entries"].([]projectInventoryEntry)
	var importAlias *projectInventoryEntry
	for index := range entries {
		if entries[index].Kind == "file import alias" && entries[index].Name == "dep" {
			importAlias = &entries[index]
		}
	}
	if importAlias == nil || importAlias.Classification != "eligible" || importAlias.ReferenceCount != 1 {
		t.Fatalf("local module import alias = %+v; want one resolved reference", importAlias)
	}
}

func TestProjectInventorySelectsFilesForProvenanceBoundBuildContext(t *testing.T) {
	files := []projectFile{
		{Path: "pkg/value_linux.go", Source: "//go:build linux && amd64\npackage sample\nimport \"syscall\"\nfunc normalize(value int) int { return syscall.Getpid() + value }\n"},
		{Path: "pkg/value_windows.go", Source: "//go:build windows\npackage sample\nimport \"syscall\"\nfunc normalize(value int) int { version, _ := syscall.GetVersion(); return int(version) + value }\n"},
		{Path: "pkg/tagged.go", Source: "//go:build integration\npackage sample\nfunc integrationOnly() {}\n"},
		{Path: "pkg/use.go", Source: "package sample\nfunc run() int { return normalize(1) }\n"},
	}
	request := goProjectRequest(files, "pkg/use.go")
	request.Operation = "project_inventory"

	base, err := listProjectInventory(request)
	if err != nil {
		t.Fatalf("inventory default Go build context: %v", err)
	}
	if base["build_context"].(goBuildContext).GOOS != runtime.GOOS || base["build_context"].(goBuildContext).GOARCH != runtime.GOARCH {
		t.Fatalf("reported build context = %#v", base["build_context"])
	}
	if base["source_set_sha256"] != hashProjectSources([]projectSourceFile{
		{Path: "pkg/value_linux.go", Text: files[0].Source}, {Path: "pkg/value_windows.go", Text: files[1].Source},
		{Path: "pkg/tagged.go", Text: files[2].Source}, {Path: "pkg/use.go", Text: files[3].Source},
	}) || base["inventory_scope_sha256"] != hashProjectInventory([]projectSourceFile{
		{Path: "pkg/value_linux.go", Text: files[0].Source}, {Path: "pkg/use.go", Text: files[3].Source},
	}, base["build_context"].(goBuildContext)) {
		t.Fatalf("inventory source and build-context scope hashes do not match their separate inputs: source=%v want=%v scope=%v wantScope=%v", base["source_set_sha256"], hashProjectSources([]projectSourceFile{
			{Path: "pkg/value_linux.go", Text: files[0].Source}, {Path: "pkg/value_windows.go", Text: files[1].Source},
			{Path: "pkg/tagged.go", Text: files[2].Source}, {Path: "pkg/use.go", Text: files[3].Source},
		}), base["inventory_scope_sha256"], hashProjectInventory([]projectSourceFile{
			{Path: "pkg/value_linux.go", Text: files[0].Source}, {Path: "pkg/value_windows.go", Text: files[1].Source},
			{Path: "pkg/tagged.go", Text: files[2].Source}, {Path: "pkg/use.go", Text: files[3].Source},
		}, base["build_context"].(goBuildContext)))
	}
	baseInventory := base["inventory"].(map[string]any)
	if baseInventory["source_file_count"] != 2 {
		t.Fatalf("default context selected %v files, want linux implementation plus common file", baseInventory["source_file_count"])
	}
	baseFiles := base["files"].([]map[string]any)
	if len(baseFiles) != 2 || baseFiles[0]["relative_path"] != "pkg/use.go" || baseFiles[1]["relative_path"] != "pkg/value_linux.go" {
		t.Fatalf("default context source files = %#v", baseFiles)
	}

	request.BuildTags = []string{"integration"}
	withTag, err := listProjectInventory(request)
	if err != nil {
		t.Fatalf("inventory explicit Go build tags: %v", err)
	}
	if withTag["source_set_sha256"] != base["source_set_sha256"] || withTag["inventory_scope_sha256"] == base["inventory_scope_sha256"] || withTag["inventory"].(map[string]any)["source_file_count"] != 3 {
		t.Fatalf("tagged inventory failed to select and bind integration file: %#v", withTag)
	}

	request.BuildGOOS = "windows"
	request.BuildGOARCH = runtime.GOARCH
	request.BuildTags = nil
	windows, err := listProjectInventory(request)
	if err != nil {
		t.Fatalf("inventory Windows target with its standard-library exports: %v", err)
	}
	if windows["source_set_sha256"] != base["source_set_sha256"] || windows["inventory_scope_sha256"] == base["inventory_scope_sha256"] || windows["inventory"].(map[string]any)["source_file_count"] != 2 {
		t.Fatalf("Windows inventory failed to select and bind its platform files: %#v", windows)
	}
	windowsFiles := windows["files"].([]map[string]any)
	if len(windowsFiles) != 2 || windowsFiles[1]["relative_path"] != "pkg/value_windows.go" {
		t.Fatalf("Windows target file selection = %#v", windowsFiles)
	}
	if windows["build_context"].(goBuildContext).CgoEnabled {
		t.Fatal("cross-OS default must disable cgo when no cross C toolchain is declared")
	}
}

func TestGoBuildFileSelectionRespectsGOARCHFilenameSuffix(t *testing.T) {
	files := []projectFile{
		{Path: "pkg/dispatch_amd64.go", Source: "package sample\nfunc dispatch() {}\n"},
		{Path: "pkg/dispatch_arm64.go", Source: "package sample\nfunc dispatch() {}\n"},
	}
	target, err := normalizeGoBuildContext(request{BuildGOOS: "linux", BuildGOARCH: "arm64"})
	if err != nil {
		t.Fatalf("resolve arm64 build context: %v", err)
	}
	selected, err := selectGoBuildFiles(files, target)
	if err != nil {
		t.Fatalf("select arm64 Go sources: %v", err)
	}
	if len(selected) != 1 || selected[0].Path != "pkg/dispatch_arm64.go" {
		t.Fatalf("arm64 source selection = %#v; want only dispatch_arm64.go", selected)
	}
}

func TestGoBuildFileSelectionSkipsPackageDirectoriesWithoutTargetFiles(t *testing.T) {
	files := []projectFile{
		{Path: "pkg/api.go", Source: "package pkg\ntype Worker struct{}\n"},
		{Path: "cmd/run_linux.go", Source: "//go:build linux\n\npackage main\nfunc main() {}\n"},
	}
	target, err := normalizeGoBuildContext(request{BuildGOOS: "js", BuildGOARCH: "wasm"})
	if err != nil {
		t.Fatalf("resolve js/wasm build context: %v", err)
	}
	selected, err := selectGoBuildFiles(files, target)
	if err != nil {
		t.Fatalf("select Go module files without a js/wasm command package: %v", err)
	}
	if len(selected) != 1 || selected[0].Path != "pkg/api.go" {
		t.Fatalf("js/wasm source selection = %#v; want the common package and no platform-only command package", selected)
	}
}

func TestProjectInventoryExplicitlyRejectsCgoFiles(t *testing.T) {
	cgoEnabled := true
	request := goProjectRequest([]projectFile{
		{Path: "pkg/native.go", Source: "package sample\n/* int answer(void) { return 42; } */\nimport \"C\"\nfunc answer() int { return int(C.answer()) }\n"},
		{Path: "pkg/use.go", Source: "package sample\nfunc run() int { return answer() }\n"},
	}, "pkg/use.go")
	request.Operation = "project_inventory"
	request.BuildGOOS = runtime.GOOS
	request.BuildGOARCH = runtime.GOARCH
	request.BuildCgo = &cgoEnabled
	if _, err := listProjectInventory(request); err == nil || !strings.Contains(err.Error(), "includes cgo files that the semantic inventory cannot type-check") {
		t.Fatalf("cgo inventory result error = %v; want explicit unsupported status", err)
	}
}

func TestProjectInventoryBuildContextCorpusV1(t *testing.T) {
	type sourceFixture struct {
		FixturePath   string `json:"fixture_path"`
		InventoryPath string `json:"inventory_path"`
		SHA256        string `json:"sha256"`
	}
	type contextFixture struct {
		Name                 string   `json:"name"`
		GOOS                 string   `json:"goos"`
		GOARCH               string   `json:"goarch"`
		BuildTags            []string `json:"build_tags"`
		ExpectedFiles        []string `json:"expected_files"`
		ExpectedEntryCount   int      `json:"expected_entry_count"`
		ExpectedPrivateCount int      `json:"expected_private_symbols"`
		ExpectedExportCount  int      `json:"expected_exported_symbols"`
	}
	var corpus struct {
		Version         int              `json:"version"`
		SourceDirectory string           `json:"source_directory"`
		SelectedPath    string           `json:"selected_path"`
		Files           []sourceFixture  `json:"files"`
		Contexts        []contextFixture `json:"contexts"`
	}
	manifestBytes, err := os.ReadFile(filepath.Join("testdata", "project_inventory_build_v1.json"))
	if err != nil {
		t.Fatalf("read build-context corpus manifest: %v", err)
	}
	if err := json.Unmarshal(manifestBytes, &corpus); err != nil {
		t.Fatalf("parse build-context corpus manifest: %v", err)
	}
	if corpus.Version != 1 || len(corpus.Files) != 5 || len(corpus.Contexts) != 4 {
		t.Fatalf("build-context corpus version/file/context count = %d/%d/%d; want 1/5/4", corpus.Version, len(corpus.Files), len(corpus.Contexts))
	}
	files := make([]projectFile, 0, len(corpus.Files))
	for _, file := range corpus.Files {
		contents, err := os.ReadFile(filepath.Join("testdata", filepath.FromSlash(corpus.SourceDirectory), filepath.FromSlash(file.FixturePath)))
		if err != nil {
			t.Fatalf("read pinned build source %s: %v", file.FixturePath, err)
		}
		source := string(contents)
		if actual := hashText(source); actual != file.SHA256 {
			t.Fatalf("pinned build source hash for %s = %s; want %s", file.FixturePath, actual, file.SHA256)
		}
		files = append(files, projectFile{Path: file.InventoryPath, Source: source, ExpectedHash: file.SHA256})
	}
	for _, build := range corpus.Contexts {
		t.Run(build.Name, func(t *testing.T) {
			request := goProjectRequest(files, corpus.SelectedPath)
			request.Operation = "project_inventory"
			request.BuildGOOS, request.BuildGOARCH = build.GOOS, build.GOARCH
			request.BuildTags = build.BuildTags
			result, err := listProjectInventory(request)
			if err != nil {
				t.Fatalf("inventory pinned build context: %v", err)
			}
			inventory := result["inventory"].(map[string]any)
			if inventory["complete"] != true || inventory["source_file_count"] != len(build.ExpectedFiles) ||
				inventory["package_count"] != 1 || inventory["entry_count"] != build.ExpectedEntryCount ||
				inventory["private_package_symbol_count"] != build.ExpectedPrivateCount || inventory["exported_package_symbol_count"] != build.ExpectedExportCount {
				t.Fatalf("inventory summary for %s/%s = %#v", build.GOOS, build.GOARCH, inventory)
			}
			gotFiles := make([]string, 0, len(result["files"].([]map[string]any)))
			for _, file := range result["files"].([]map[string]any) {
				gotFiles = append(gotFiles, file["relative_path"].(string))
			}
			sort.Strings(gotFiles)
			wantFiles := append([]string(nil), build.ExpectedFiles...)
			sort.Strings(wantFiles)
			if !reflect.DeepEqual(gotFiles, wantFiles) {
				t.Fatalf("selected files = %#v; want %#v", gotFiles, wantFiles)
			}
		})
	}
}

func TestProjectInventoryTypeChecksWithTargetGOARCHExports(t *testing.T) {
	request := goProjectRequest([]projectFile{
		{Path: "pkg/process_linux_amd64.go", Source: "//go:build linux && amd64\npackage sample\nimport \"syscall\"\nfunc processID() int { return syscall.Gettid() }\n"},
		{Path: "pkg/process_linux_arm64.go", Source: "//go:build linux && arm64\npackage sample\nimport \"syscall\"\nfunc processID() int { return syscall.Gettid() }\n"},
		{Path: "pkg/use.go", Source: "package sample\nfunc run() int { return processID() }\n"},
	}, "pkg/use.go")
	request.Operation = "project_inventory"
	request.BuildGOOS = "linux"
	request.BuildGOARCH = "arm64"

	result, err := listProjectInventory(request)
	if err != nil {
		t.Fatalf("inventory linux/arm64 package with target standard-library exports: %v", err)
	}
	inventory := result["inventory"].(map[string]any)
	if inventory["source_file_count"] != 2 || result["build_context"].(goBuildContext).ArchitectureOptions["GOARM64"] != "v8.0" {
		t.Fatalf("linux/arm64 context or selected source files = %#v", result)
	}
	files := result["files"].([]map[string]any)
	if len(files) != 2 || files[0]["relative_path"] != "pkg/process_linux_arm64.go" || files[1]["relative_path"] != "pkg/use.go" {
		t.Fatalf("linux/arm64 source selection = %#v", files)
	}
}

func TestGoTargetImporterRejectsUnavailableExternalModulesOffline(t *testing.T) {
	target, err := normalizeGoBuildContext(request{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := newGoTargetImporter(target).Import("example.invalid/unverified"); err == nil {
		t.Fatal("an unavailable external module was accepted without verified dependency receipts")
	}
}

func TestGoModuleReceiptRequiresMatchingManifestAndChecksumHashes(t *testing.T) {
	goMod := "module example.test/project\n\ngo 1.24\n"
	goSum := "example.test/dep v1.0.0 h1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n"
	req := request{
		ModulePath: "example.test/project", GoMod: goMod, GoModHash: hashText(goMod),
		GoSum: goSum, GoSumHash: hashText(goSum),
	}
	if err := validateGoModuleReceipt(req); err != nil {
		t.Fatalf("valid module receipt rejected: %v", err)
	}
	req.GoSumHash = strings.Repeat("0", 64)
	if err := validateGoModuleReceipt(req); err == nil || !strings.Contains(err.Error(), "checksum manifest hash") {
		t.Fatalf("tampered go.sum receipt error = %v", err)
	}
	req.GoSumHash = hashText(goSum)
	req.ModulePath = "example.test/other"
	if err := validateGoModuleReceipt(req); err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("mismatched module identity error = %v", err)
	}
	req.ModulePath = "example.test/project"
	req.GoMod = "module \"example.test/project\" // fixture module\n\ngo 1.24\n"
	req.GoModHash = hashText(req.GoMod)
	if err := validateGoModuleReceipt(req); err != nil {
		t.Fatalf("valid quoted module directive with comment rejected: %v", err)
	}
}

func TestProjectInventoryResolvesHashVerifiedModuleFromOfflineCache(t *testing.T) {
	root := t.TempDir()
	proxyRoot := filepath.Join(root, "proxy")
	moduleCache := filepath.Join(root, "module-cache")
	projectRoot := filepath.Join(root, "project")
	proxyModule := filepath.Join(proxyRoot, "example.test", "dep", "@v")
	if err := os.MkdirAll(proxyModule, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(projectRoot, 0700); err != nil {
		t.Fatal(err)
	}
	version := "v1.0.0"
	moduleSource := "module example.test/dep\n\ngo 1.24\n"
	packageSource := "package dep\nconst Value = 7\n"
	if err := os.WriteFile(filepath.Join(proxyModule, version+".info"), []byte(`{"Version":"v1.0.0","Time":"2026-01-01T00:00:00Z"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(proxyModule, version+".mod"), []byte(moduleSource), 0600); err != nil {
		t.Fatal(err)
	}
	zipFile, err := os.Create(filepath.Join(proxyModule, version+".zip"))
	if err != nil {
		t.Fatal(err)
	}
	zipWriter := zip.NewWriter(zipFile)
	for name, content := range map[string]string{
		"go.mod": moduleSource,
		"dep.go": packageSource,
	} {
		entry, createErr := zipWriter.Create("example.test/dep@v1.0.0/" + name)
		if createErr != nil {
			t.Fatal(createErr)
		}
		if _, writeErr := entry.Write([]byte(content)); writeErr != nil {
			t.Fatal(writeErr)
		}
	}
	if err := zipWriter.Close(); err != nil {
		t.Fatal(err)
	}
	if err := zipFile.Close(); err != nil {
		t.Fatal(err)
	}
	goMod := "module example.test/project\n\ngo 1.24\n\nrequire example.test/dep v1.0.0\n"
	projectManifest := filepath.Join(projectRoot, "go.mod")
	if err := os.WriteFile(projectManifest, []byte(goMod), 0600); err != nil {
		t.Fatal(err)
	}
	target, err := normalizeGoBuildContext(request{})
	if err != nil {
		t.Fatal(err)
	}
	moduleEnvironment := goBuildCommandEnvironment(target)
	moduleEnvironment = setGoEnvironmentValue(moduleEnvironment, "GO111MODULE", "on")
	moduleEnvironment = setGoEnvironmentValue(moduleEnvironment, "GOPROXY", "file://"+filepath.ToSlash(proxyRoot))
	moduleEnvironment = setGoEnvironmentValue(moduleEnvironment, "GOMODCACHE", moduleCache)
	moduleEnvironment = setGoEnvironmentValue(moduleEnvironment, "GOFLAGS", "")
	download := exec.Command("go", "mod", "download", "example.test/dep@v1.0.0")
	download.Dir, download.Env = projectRoot, moduleEnvironment
	if output, err := download.CombinedOutput(); err != nil {
		t.Fatalf("seed the isolated cache from the local file proxy: %v: %s", err, strings.TrimSpace(string(output)))
	}
	goSum, err := os.ReadFile(filepath.Join(projectRoot, "go.sum"))
	if err != nil {
		t.Fatal(err)
	}
	previousCache := os.Getenv("REAMON_GO_MODULE_CACHE")
	if err := os.Setenv("REAMON_GO_MODULE_CACHE", moduleCache); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if previousCache == "" {
			_ = os.Unsetenv("REAMON_GO_MODULE_CACHE")
		} else {
			_ = os.Setenv("REAMON_GO_MODULE_CACHE", previousCache)
		}
	}()
	request := goProjectRequest([]projectFile{{
		Path: "pkg/use.go", Source: "package sample\nimport \"example.test/dep\"\nfunc use() int { return dep.Value }\n",
	}}, "pkg/use.go")
	request.Operation = "project_inventory"
	request.ModulePath, request.GoMod, request.GoModHash = "example.test/project", goMod, hashText(goMod)
	request.GoSum, request.GoSumHash = string(goSum), hashText(string(goSum))
	result, err := listProjectInventory(request)
	if err != nil {
		t.Fatalf("inventory package using only the verified offline module cache: %v", err)
	}
	if result["go_mod_sha256"] != request.GoModHash || result["go_sum_sha256"] != request.GoSumHash {
		t.Fatalf("module receipt hashes were not bound to the inventory: %#v", result)
	}
}

func TestProjectInventoryRejectsLocalModuleReplacements(t *testing.T) {
	goMod := "module example.test/project\n\ngo 1.24\n\nrequire example.test/dep v1.0.0\nreplace example.test/dep => ../dep\n"
	request := goProjectRequest([]projectFile{{
		Path: "pkg/use.go", Source: "package sample\nimport \"example.test/dep\"\nfunc use() int { return dep.Value }\n",
	}}, "pkg/use.go")
	request.Operation = "project_inventory"
	request.ModulePath, request.GoMod, request.GoModHash = "example.test/project", goMod, hashText(goMod)
	if _, err := listProjectInventory(request); err == nil || !strings.Contains(err.Error(), "local Go module replacements are unsupported") {
		t.Fatalf("local module replacement error = %v", err)
	}
}

func TestProjectInventoryRejectsInvalidModuleContext(t *testing.T) {
	request := goProjectRequest([]projectFile{
		{Path: "pkg/a.go", Source: "package sample\nfunc a() {}\n"},
	}, "pkg/a.go")
	request.Operation = "project_inventory"
	request.ModulePath = "example.test/project"
	request.ModuleRoot = "../outside"
	if _, err := listProjectInventory(request); err == nil || !strings.Contains(err.Error(), "module root is invalid") {
		t.Fatalf("invalid module root error = %v", err)
	}
	request.ModuleRoot = ""
	request.ModulePath = "example.test//project"
	if _, err := listProjectInventory(request); err == nil || !strings.Contains(err.Error(), "module path is invalid") {
		t.Fatalf("invalid module path error = %v", err)
	}
}

func TestProjectInventoryRejectsIncompleteOrInvalidSourceSets(t *testing.T) {
	base := goProjectRequest([]projectFile{
		{Path: "pkg/a.go", Source: "package sample\nfunc a() int { return 1 }\n"},
		{Path: "pkg/b.go", Source: "package sample\nfunc b() int { return a() }\n"},
	}, "pkg/a.go")
	base.Operation = "project_inventory"
	base.Files = append(base.Files, projectFile{Path: "bad/c.go", Source: "package other\nfunc c() { missing() }\n", ExpectedHash: hashText("package other\nfunc c() { missing() }\n")})
	if _, err := listProjectInventory(base); err == nil || !strings.Contains(err.Error(), "cannot inventory Go package bad") {
		t.Fatalf("unresolved package inventory error = %v; want explicit incomplete package rejection", err)
	}

	base.Files = goProjectRequest([]projectFile{
		{Path: "pkg/a.go", Source: "package sample\nfunc a() {}\n"},
	}, "pkg/a.go").Files
	base.SelectedPath = "../outside.go"
	if _, err := listProjectInventory(base); err == nil || !strings.Contains(err.Error(), "path is invalid") {
		t.Fatalf("unsafe selected path error = %v; want path rejection", err)
	}
	base = goProjectRequest([]projectFile{{Path: "pkg/a\n.go", Source: "package sample\n"}}, "pkg/a\n.go")
	base.Operation = "project_inventory"
	if _, err := listProjectInventory(base); err == nil || !strings.Contains(err.Error(), "path is invalid") {
		t.Fatalf("newline source path error = %v; want path rejection", err)
	}

	base = goProjectRequest([]projectFile{
		{Path: "pkg/a.go", Source: "package sample\nfunc a() {}\n"},
	}, "pkg/a.go")
	base.Operation = "project_inventory"
	base.Source = "package sample\nfunc different() {}\n"
	if _, err := listProjectInventory(base); err == nil || !strings.Contains(err.Error(), "does not match the project inventory snapshot") {
		t.Fatalf("stale selected source error = %v; want source snapshot rejection", err)
	}
}

func TestProjectCatalogReportsMainEntrypointAsUnsupported(t *testing.T) {
	request := goProjectRequest([]projectFile{
		{Path: "cmd/tool/main.go", Source: "package main\nfunc main() {}\n"},
		{Path: "cmd/tool/helper.go", Source: "package main\nfunc helper() {}\n"},
	}, "cmd/tool/main.go")
	catalog, err := buildProjectCatalog(request)
	if err != nil {
		t.Fatalf("build main package inventory: %v", err)
	}
	want := projectInventory{SourceFileCount: 2, PrivatePackageSymbolCount: 1, UnreferencedPrivateSymbols: 1, UnsupportedPackageSymbolCount: 1, EntryCount: 2}
	gotCounts := catalog.Inventory
	gotCounts.Entries = nil
	if !reflect.DeepEqual(gotCounts, want) {
		t.Fatalf("main package inventory = %+v; want %+v", catalog.Inventory, want)
	}
}

func TestListProjectBindingsReturnsBoundedInventoryEntries(t *testing.T) {
	request := goProjectRequest([]projectFile{
		{Path: "pkg/a.go", Source: "package sample\nfunc normalize() int { return helper() }\n"},
		{Path: "pkg/b.go", Source: "package sample\nfunc helper() int { return normalize() }\n"},
	}, "pkg/a.go")
	response, err := listProjectBindings(request)
	if err != nil {
		t.Fatalf("list project bindings: %v", err)
	}
	inventory, ok := response["inventory"].(map[string]any)
	if !ok {
		t.Fatalf("inventory response has type %T", response["inventory"])
	}
	if inventory["entry_count"] != 2 || inventory["entries_truncated"] != false {
		t.Fatalf("inventory entry metadata = %+v", inventory)
	}
	entries, ok := inventory["entries"].([]projectInventoryEntry)
	if !ok || len(entries) != 2 {
		t.Fatalf("inventory entries = %#v; want two typed rows", inventory["entries"])
	}
	if entries[0].Name != "normalize" || entries[0].Classification != "eligible" || entries[1].Name != "helper" || entries[1].Classification != "eligible" {
		t.Fatalf("inventory entries = %+v; want both cross-file referenced functions", entries)
	}
}

func TestProjectInventoryBoundsRowsWithoutTruncatingTotals(t *testing.T) {
	var source strings.Builder
	source.WriteString("package sample\n")
	for index := 0; index < maxProjectInventoryEntries; index++ {
		fmt.Fprintf(&source, "func symbol%d() {}\n", index)
	}
	request := goProjectRequest([]projectFile{
		{Path: "pkg/a.go", Source: source.String()},
		{Path: "pkg/b.go", Source: "package sample\nfunc helper() {}\n"},
	}, "pkg/a.go")
	catalog, err := buildProjectCatalog(request)
	if err != nil {
		t.Fatalf("build large package inventory: %v", err)
	}
	if catalog.Inventory.EntryCount != maxProjectInventoryEntries+1 ||
		len(catalog.Inventory.Entries) != maxProjectInventoryEntries ||
		!catalog.Inventory.EntriesTruncated ||
		catalog.Inventory.PrivatePackageSymbolCount != maxProjectInventoryEntries+1 ||
		catalog.Inventory.UnreferencedPrivateSymbols != maxProjectInventoryEntries+1 {
		t.Fatalf("large inventory = count %d, rows %d, truncated %t, private %d, unreferenced %d",
			catalog.Inventory.EntryCount, len(catalog.Inventory.Entries), catalog.Inventory.EntriesTruncated,
			catalog.Inventory.PrivatePackageSymbolCount, catalog.Inventory.UnreferencedPrivateSymbols)
	}
}

func TestProjectInventoryBoundsLocalRowsWithoutTruncatingTotals(t *testing.T) {
	var packageSource strings.Builder
	packageSource.WriteString("package sample\n")
	for index := 0; index < maxProjectInventoryEntries/2-1; index++ {
		fmt.Fprintf(&packageSource, "func packageSymbol%d() {}\n", index)
	}
	var localSource strings.Builder
	localSource.WriteString("package sample\nfunc locals() {\n")
	for index := 0; index <= maxProjectInventoryEntries/2; index++ {
		fmt.Fprintf(&localSource, "local%d := %d\n_ = local%d\n", index, index, index)
	}
	localSource.WriteString("}\n")
	request := goProjectRequest([]projectFile{
		{Path: "pkg/a.go", Source: packageSource.String()},
		{Path: "pkg/b.go", Source: localSource.String()},
	}, "pkg/a.go")
	catalog, err := buildProjectCatalog(request)
	if err != nil {
		t.Fatalf("build mixed package/local inventory: %v", err)
	}
	if catalog.Inventory.EntryCount != maxProjectInventoryEntries+1 ||
		len(catalog.Inventory.Entries) != maxProjectInventoryEntries || !catalog.Inventory.EntriesTruncated ||
		catalog.Inventory.PrivatePackageSymbolCount != maxProjectInventoryEntries/2 ||
		catalog.Inventory.UnreferencedPrivateSymbols != maxProjectInventoryEntries/2 ||
		catalog.Inventory.LocalSymbolCount != maxProjectInventoryEntries/2+1 ||
		catalog.Inventory.ReferencedLocalSymbols != maxProjectInventoryEntries/2+1 {
		t.Fatalf("mixed inventory = count %d, rows %d, truncated %t, package %d/%d, local %d/%d",
			catalog.Inventory.EntryCount, len(catalog.Inventory.Entries), catalog.Inventory.EntriesTruncated,
			catalog.Inventory.PrivatePackageSymbolCount, catalog.Inventory.UnreferencedPrivateSymbols,
			catalog.Inventory.LocalSymbolCount, catalog.Inventory.ReferencedLocalSymbols)
	}
	if got := catalog.Inventory.Entries[len(catalog.Inventory.Entries)-1]; got.Scope != "local" || got.Name != "local2499" {
		t.Fatalf("last bounded row = %+v; want a stable in-scope local entry", got)
	}
}

func TestCapturedLocalRenameFollowsObjectIntoNestedClosure(t *testing.T) {
	source := "package sample\nfunc build(seed int) func() int {\n\ttotal := seed\n\treturn func() int { return total + 1 }\n}\n"
	cat, err := buildCatalog(source)
	if err != nil {
		t.Fatal(err)
	}
	start := strings.Index(source, "total :=")
	item := bindingNamed(t, cat, "total", start)
	if item.ReferenceCount != 1 || item.Kind != "local variable" {
		t.Fatalf("captured local metadata = kind %q, references %d; want local variable, 1", item.Kind, item.ReferenceCount)
	}
	result, err := applyRenames(request{
		Source: source, ExpectedHash: cat.Hash,
		Renames: []renameSelection{{ID: item.ID, NewName: "accumulator"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	output := result["source_code"].(string)
	want := "package sample\nfunc build(seed int) func() int {\n\taccumulator := seed\n\treturn func() int { return accumulator + 1 }\n}\n"
	if output != want {
		t.Fatalf("rename output did not follow the captured object:\n%s", output)
	}
}

func TestShadowedBindingsRenameOnlyTheirOwnReferences(t *testing.T) {
	source := "package sample\nfunc calculate(input int) int {\n\tvalue := input\n\tinner := func(value int) int { return value + 1 }\n\treturn value + inner(2)\n}\n"
	cat, err := buildCatalog(source)
	if err != nil {
		t.Fatal(err)
	}
	outer := bindingNamed(t, cat, "value", strings.Index(source, "value :="))
	inner := bindingNamed(t, cat, "value", strings.LastIndex(source, "value int"))
	if outer.ReferenceCount != 1 || inner.ReferenceCount != 1 {
		t.Fatalf("shadowed reference counts = outer %d, inner %d; want 1, 1", outer.ReferenceCount, inner.ReferenceCount)
	}
	result, err := applyRenames(request{
		Source: source, ExpectedHash: cat.Hash,
		Renames: []renameSelection{{ID: outer.ID, NewName: "result"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	output := result["source_code"].(string)
	want := "package sample\nfunc calculate(input int) int {\n\tresult := input\n\tinner := func(value int) int { return value + 1 }\n\treturn result + inner(2)\n}\n"
	if output != want {
		t.Fatalf("rename crossed a shadowed binding boundary:\n%s", output)
	}
}

func TestRenameRejectsClosureCaptureByInnerShadow(t *testing.T) {
	source := "package sample\nfunc calculate() int {\n\tvalue := 1\n\treturn func() int {\n\t\tshadow := 2\n\t\t_ = shadow\n\t\treturn value\n\t}()\n}\n"
	cat, err := buildCatalog(source)
	if err != nil {
		t.Fatal(err)
	}
	item := bindingNamed(t, cat, "value", strings.Index(source, "value :="))
	_, err = applyRenames(request{
		Source: source, ExpectedHash: cat.Hash,
		Renames: []renameSelection{{ID: item.ID, NewName: "shadow"}},
	})
	if err == nil || !strings.Contains(err.Error(), "would change the binding") {
		t.Fatalf("rename error = %v; want closure binding-change rejection", err)
	}
}

func TestMultipleRenamesPreserveReferenceIdentityAfterOffsetChanges(t *testing.T) {
	source := "package sample\nfunc calculate(input int) int {\n\tfirst := input\n\tsecond := first + 1\n\treturn second\n}\n"
	cat, err := buildCatalog(source)
	if err != nil {
		t.Fatal(err)
	}
	first := bindingNamed(t, cat, "first", strings.Index(source, "first :="))
	second := bindingNamed(t, cat, "second", strings.Index(source, "second :="))
	result, err := applyRenames(request{
		Source: source, ExpectedHash: cat.Hash,
		Renames: []renameSelection{
			{ID: first.ID, NewName: "accumulator"},
			{ID: second.ID, NewName: "result"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	output := result["source_code"].(string)
	want := "package sample\nfunc calculate(input int) int {\n\taccumulator := input\n\tresult := accumulator + 1\n\treturn result\n}\n"
	if output != want {
		t.Fatalf("multi-rename output did not preserve object references:\n%s", output)
	}
}
