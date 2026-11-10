package main

import (
	"strings"
	"testing"
)

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
