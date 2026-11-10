package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
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

func assertProjectRenameBehavior(t *testing.T, files map[string]string, testSource, variant string) {
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
	if err := os.WriteFile(behaviorPath, []byte("package sample\n\nimport \"testing\"\n\n"+testSource), 0o600); err != nil {
		t.Fatalf("write %s behavior oracle: %v", variant, err)
	}
	command := exec.Command("go", "test", "-run", "^TestCorpusBehavior$")
	command.Dir = packageDirectory
	command.Env = append(os.Environ(), "GO111MODULE=off", "GOTOOLCHAIN=local")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("%s runtime behavior oracle failed: %v\n%s", variant, err, output)
	}
}

func TestProjectRenameRejectsChangedSourceSet(t *testing.T) {
	request := goProjectRequest([]projectFile{
		{Path: "pkg/a.go", Source: "package sample\nfunc normalize(value int) int { return value + 1 }\n"},
		{Path: "pkg/b.go", Source: "package sample\nfunc run() int { return normalize(4) }\n"},
	}, "pkg/a.go")
	cat, err := buildProjectCatalog(request)
	if err != nil {
		t.Fatal(err)
	}
	request.Operation = "project_rename"
	request.ExpectedHash = cat.SelectedHash
	request.SourceSetHash = strings.Repeat("0", 64)
	request.Renames = []renameSelection{{ID: cat.Bindings[0].ID, NewName: "scale"}}
	if _, err := applyProjectRenames(request); err == nil || !strings.Contains(err.Error(), "source changed") {
		t.Fatalf("changed source-set error = %v; want stale-snapshot rejection", err)
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
		{name: "build constraints", files: []projectFile{{Path: "pkg/a.go", Source: "//go:build linux\npackage sample"}, {Path: "pkg/b.go", Source: "package sample"}}},
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
