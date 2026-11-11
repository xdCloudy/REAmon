// Command reamon-gorefactor provides conservative, single-file Go binding
// catalogs and hash-bound renames for REAmon's source-maintenance workflow.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/build"
	"go/importer"
	"go/parser"
	"go/token"
	"go/types"
	"hash"
	"io"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
)

const maxSourceBytes = 512 * 1024
const maxProjectFileBytes = 2 * 1024 * 1024
const maxProjectBytes = 8 * 1024 * 1024
const maxProjectFiles = 256
const maxRequestBytes = maxProjectBytes + maxProjectFiles*8192 + 2*1024*1024
const maxBindings = 5000
const maxProjectInventoryEntries = 5000
const maxRenames = 80

type request struct {
	Operation     string            `json:"operation"`
	Source        string            `json:"source_code"`
	ExpectedHash  string            `json:"expected_sha256"`
	SourceSetHash string            `json:"source_set_sha256"`
	SelectedPath  string            `json:"selected_path"`
	ModulePath    string            `json:"module_path"`
	ModuleRoot    string            `json:"module_root"`
	GoMod         string            `json:"go_mod"`
	GoModHash     string            `json:"go_mod_sha256"`
	GoSum         string            `json:"go_sum"`
	GoSumHash     string            `json:"go_sum_sha256"`
	BuildGOOS     string            `json:"build_goos"`
	BuildGOARCH   string            `json:"build_goarch"`
	BuildCgo      *bool             `json:"build_cgo_enabled"`
	BuildTags     []string          `json:"build_tags"`
	PackagePath   string            `json:"-"`
	Files         []projectFile     `json:"files"`
	Renames       []renameSelection `json:"renames"`
}

type projectFile struct {
	Path         string `json:"relative_path"`
	Source       string `json:"source_code"`
	ExpectedHash string `json:"expected_sha256"`
}

type renameSelection struct {
	ID      string `json:"binding_id"`
	NewName string `json:"new_name"`
}

type binding struct {
	ID               string       `json:"id"`
	FilePath         string       `json:"relativePath,omitempty"`
	Name             string       `json:"name"`
	Kind             string       `json:"kind"`
	ScopeType        string       `json:"scopeType"`
	DeclarationStart int          `json:"declarationStart"`
	ReferenceCount   int          `json:"referenceCount"`
	Exported         bool         `json:"exported"`
	Object           types.Object `json:"-"`
	Scope            *types.Scope `json:"-"`
	Declaration      *ast.Ident   `json:"-"`
	Uses             []*ast.Ident `json:"-"`
}

type catalog struct {
	Hash      string
	FileSet   *token.FileSet
	File      *ast.File
	Info      *types.Info
	Bindings  []binding
	Truncated bool
}

type projectSourceFile struct {
	Path string
	Text string
	AST  *ast.File
}

type projectCatalog struct {
	Hash               string
	SourceSetHash      string
	InventoryScopeHash string
	SelectedPath       string
	SelectedHash       string
	Inventory          projectInventory
	FileSet            *token.FileSet
	Files              []projectSourceFile
	Info               *types.Info
	Package            *types.Package
	Bindings           []binding
	Truncated          bool
}

type projectInventory struct {
	SourceFileCount                 int
	PackageCount                    int
	PrivatePackageSymbolCount       int
	ReferencedPrivatePackageSymbols int
	UnreferencedPrivateSymbols      int
	ExportedPackageSymbolCount      int
	UnsupportedPackageSymbolCount   int
	FileScopeSymbolCount            int
	ReferencedFileScopeSymbols      int
	UnreferencedFileScopeSymbols    int
	UnsupportedFileScopeSymbolCount int
	LocalSymbolCount                int
	ReferencedLocalSymbols          int
	UnreferencedLocalSymbols        int
	UnsupportedLocalSymbolCount     int
	MemberSymbolCount               int
	UnsupportedMemberSymbolCount    int
	EntryCount                      int
	EntriesTruncated                bool
	Entries                         []projectInventoryEntry
}

type projectInventoryEntry struct {
	ID                   string `json:"id"`
	Name                 string `json:"name"`
	Kind                 string `json:"kind"`
	Scope                string `json:"scope"`
	RelativePath         string `json:"relativePath"`
	DeclarationStart     int    `json:"declarationStart"`
	ReferenceCount       int    `json:"referenceCount"`
	Exported             bool   `json:"exported"`
	Classification       string `json:"classification"`
	ClassificationReason string `json:"classificationReason"`
	NameAssessment       string `json:"nameAssessment"`
}

type derivedFieldReference struct {
	ident *ast.Ident
}

type projectRenameChoice struct {
	item    binding
	newName string
	derived []derivedFieldReference
}

type sourceEdit struct {
	start, end int
	text       string
}

func main() {
	input, err := io.ReadAll(io.LimitReader(os.Stdin, maxRequestBytes+1))
	if err != nil {
		writeError("Could not read request", 400)
		return
	}
	if len(input) > maxRequestBytes {
		writeError("Go refactor request exceeds the project size limit", 413)
		return
	}
	var req request
	if err := json.Unmarshal(input, &req); err != nil {
		writeError("Invalid Go refactor request", 400)
		return
	}
	if len([]byte(req.Source)) > maxSourceBytes && req.Operation != "project_bindings" && req.Operation != "project_rename" && req.Operation != "project_module_bindings" && req.Operation != "project_module_rename" {
		writeError("Go source exceeds the 512 KiB safe-rename limit", 413)
		return
	}
	var result any
	switch req.Operation {
	case "bindings":
		result, err = listBindings(req.Source)
	case "rename":
		result, err = applyRenames(req)
	case "project_bindings":
		result, err = listProjectBindings(req)
	case "project_inventory":
		result, err = listProjectInventory(req)
	case "project_rename":
		result, err = applyProjectRenames(req)
	case "project_module_bindings":
		result, err = listProjectModuleBindings(req)
	case "project_module_rename":
		result, err = applyProjectModuleRenames(req)
	default:
		writeError("Unsupported Go refactor operation", 400)
		return
	}
	if err != nil {
		writeError(err.Error(), 422)
		return
	}
	_ = json.NewEncoder(os.Stdout).Encode(result)
}

func writeError(message string, status int) {
	_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"error": message, "status": status})
}

func hashText(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

func newHash() hash.Hash { return sha256.New() }

func buildCatalog(source string) (*catalog, error) {
	if len([]byte(source)) > maxSourceBytes {
		return nil, fmt.Errorf("Go source exceeds the 512 KiB safe-rename limit")
	}
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "selected.go", source, parser.AllErrors|parser.ParseComments)
	if err != nil {
		return nil, fmt.Errorf("Go parser rejected the source: %s", err.Error())
	}
	info := &types.Info{
		Defs: make(map[*ast.Ident]types.Object), Uses: make(map[*ast.Ident]types.Object),
		Scopes: make(map[ast.Node]*types.Scope),
	}
	conf := types.Config{Importer: importer.Default(), Error: func(error) {}}
	pkg, _ := conf.Check(file.Name.Name, fset, []*ast.File{file}, info)
	var packageScope *types.Scope
	if pkg != nil {
		packageScope = pkg.Scope()
	}
	cat := &catalog{Hash: hashText(source), FileSet: fset, File: file, Info: info}
	declKinds := make(map[types.Object]string)
	declScopes := make(map[types.Object]*types.Scope)
	funcNodes := make(map[types.Object]string)
	functionScopes := make(map[*types.Scope]bool)
	markParameters := func(fields *ast.FieldList, scopeType string) {
		if fields == nil {
			return
		}
		for _, field := range fields.List {
			for _, name := range field.Names {
				if object := info.Defs[name]; object != nil && object.Parent() != packageScope {
					declKinds[object] = "parameter"
					declScopes[object] = object.Parent()
					funcNodes[object] = scopeType
				}
			}
		}
	}
	ast.Inspect(file, func(node ast.Node) bool {
		switch n := node.(type) {
		case *ast.FuncDecl:
			if scope := info.Scopes[n.Type]; scope != nil {
				functionScopes[scope] = true
			}
			if scope := info.Scopes[n.Body]; scope != nil {
				functionScopes[scope] = true
			}
			markParameters(n.Type.Params, "function")
			markParameters(n.Type.Results, "function")
			if n.Recv != nil {
				markParameters(&ast.FieldList{List: n.Recv.List}, "function")
			}
			return true
		case *ast.FuncLit:
			if scope := info.Scopes[n.Type]; scope != nil {
				functionScopes[scope] = true
			}
			if scope := info.Scopes[n.Body]; scope != nil {
				functionScopes[scope] = true
			}
			markParameters(n.Type.Params, "function")
			markParameters(n.Type.Results, "function")
			return true
		case *ast.ValueSpec:
			for _, name := range n.Names {
				if object := info.Defs[name]; object != nil && object.Parent() != packageScope {
					declKinds[object] = "local variable"
					declScopes[object] = object.Parent()
					funcNodes[object] = scopeLabel(object.Parent(), functionScopes)
				}
			}
		case *ast.AssignStmt:
			if n.Tok == token.DEFINE {
				for _, expr := range n.Lhs {
					if name, ok := expr.(*ast.Ident); ok {
						if object := info.Defs[name]; object != nil && object.Parent() != packageScope {
							declKinds[object] = "local variable"
							declScopes[object] = object.Parent()
							funcNodes[object] = scopeLabel(object.Parent(), functionScopes)
						}
					}
				}
			}
		case *ast.RangeStmt:
			if n.Tok == token.DEFINE {
				for _, expr := range []ast.Expr{n.Key, n.Value} {
					if name, ok := expr.(*ast.Ident); ok && name.Name != "_" {
						if object := info.Defs[name]; object != nil && object.Parent() != packageScope {
							declKinds[object] = "local variable"
							declScopes[object] = object.Parent()
							funcNodes[object] = scopeLabel(object.Parent(), functionScopes)
						}
					}
				}
			}
		}
		return true
	})
	declarations := make(map[types.Object]*ast.Ident)
	for ident, object := range info.Defs {
		if _, ok := declKinds[object]; ok {
			declarations[object] = ident
		}
	}
	for object, kind := range declKinds {
		decl := declarations[object]
		if decl == nil || decl.Name == "_" || object == nil {
			continue
		}
		position := fset.PositionFor(decl.Pos(), false)
		start := fset.File(decl.Pos()).Offset(decl.Pos())
		uses := []*ast.Ident{decl}
		for ident, used := range info.Uses {
			if used == object {
				uses = append(uses, ident)
			}
		}
		if len(uses) <= 1 {
			continue
		}
		id := shortID(cat.Hash, position.Offset, decl.Name)
		cat.Bindings = append(cat.Bindings, binding{
			ID: id, Name: decl.Name, Kind: kind, ScopeType: funcNodes[object],
			DeclarationStart: start, ReferenceCount: len(uses) - 1,
			Object: object, Scope: declScopes[object], Declaration: decl, Uses: uses,
		})
	}
	sort.Slice(cat.Bindings, func(i, j int) bool { return cat.Bindings[i].DeclarationStart < cat.Bindings[j].DeclarationStart })
	cat.Truncated = len(cat.Bindings) > maxBindings
	if cat.Truncated {
		cat.Bindings = cat.Bindings[:maxBindings]
	}
	return cat, nil
}

func scopeLabel(scope *types.Scope, functionScopes map[*types.Scope]bool) string {
	if functionScopes[scope] {
		return "function"
	}
	return "block"
}

func shortID(sourceHash string, offset int, name string) string {
	h := newHash()
	_, _ = h.Write([]byte(fmt.Sprintf("%s\x00%d\x00%s", sourceHash, offset, name)))
	return hex.EncodeToString(h.Sum(nil))[:24]
}

func listBindings(source string) (map[string]any, error) {
	cat, err := buildCatalog(source)
	if err != nil {
		return nil, err
	}
	bindings := make([]map[string]any, 0, len(cat.Bindings))
	for _, item := range cat.Bindings {
		bindings = append(bindings, map[string]any{
			"id": item.ID, "name": item.Name, "kind": item.Kind, "scopeType": item.ScopeType,
			"declarationStart": item.DeclarationStart, "referenceCount": item.ReferenceCount, "exported": false,
		})
	}
	return map[string]any{"source_sha256": cat.Hash, "bindings": bindings, "truncated": cat.Truncated, "parser_version": runtime.Version()}, nil
}

func applyRenames(req request) (map[string]any, error) {
	cat, err := buildCatalog(req.Source)
	if err != nil {
		return nil, err
	}
	if len(req.ExpectedHash) != 64 || strings.ToLower(req.ExpectedHash) != cat.Hash {
		return nil, fmt.Errorf("Go source changed after rename suggestions were generated")
	}
	if len(req.Renames) < 1 || len(req.Renames) > maxRenames {
		return nil, fmt.Errorf("Select between 1 and 80 Go bindings to rename")
	}
	byID := make(map[string]binding, len(cat.Bindings))
	for _, item := range cat.Bindings {
		byID[item.ID] = item
	}
	selected := make([]struct {
		item    binding
		newName string
	}, 0, len(req.Renames))
	seen := make(map[string]bool)
	targets := make(map[*types.Scope]map[string]bool)
	for _, choice := range req.Renames {
		item, ok := byID[choice.ID]
		if !ok || seen[choice.ID] || len(choice.NewName) > 128 || !token.IsIdentifier(choice.NewName) || token.Lookup(choice.NewName).IsKeyword() || choice.NewName == item.Name {
			return nil, fmt.Errorf("A selected Go rename no longer matches a valid local binding")
		}
		seen[choice.ID] = true
		if item.Scope == nil {
			return nil, fmt.Errorf("The Go binding scope could not be resolved")
		}
		if types.Universe.Lookup(choice.NewName) != nil {
			return nil, fmt.Errorf("Renaming %s to predeclared Go name %s is not allowed", item.Name, choice.NewName)
		}
		for _, ident := range item.Uses {
			if scope := scopeAt(cat.Info.Scopes, ident.Pos()); scope != nil {
				if _, existing := scope.LookupParent(choice.NewName, ident.Pos()); existing != nil && existing != item.Object {
					return nil, fmt.Errorf("Renaming %s to %s would capture an existing Go name", item.Name, choice.NewName)
				}
			}
		}
		if targets[item.Scope] == nil {
			targets[item.Scope] = make(map[string]bool)
		}
		if targets[item.Scope][choice.NewName] {
			return nil, fmt.Errorf("Two selected Go bindings in the same scope cannot share a new name")
		}
		targets[item.Scope][choice.NewName] = true
		selected = append(selected, struct {
			item    binding
			newName string
		}{item, choice.NewName})
	}
	file := cat.FileSet.File(cat.File.Pos())
	edits := make([]sourceEdit, 0)
	renamed := make([]map[string]any, 0, len(selected))
	for _, selection := range selected {
		for _, ident := range selection.item.Uses {
			start := file.Offset(ident.Pos())
			end := file.Offset(ident.End())
			edits = append(edits, sourceEdit{start: start, end: end, text: selection.newName})
		}
		renamed = append(renamed, map[string]any{
			"bindingId": selection.item.ID, "oldName": selection.item.Name, "newName": selection.newName,
			"kind": selection.item.Kind, "referenceCount": selection.item.ReferenceCount, "scopeType": selection.item.ScopeType,
		})
	}
	sort.Slice(edits, func(i, j int) bool { return edits[i].start > edits[j].start })
	output := []byte(req.Source)
	for _, change := range edits {
		output = append(output[:change.start], append([]byte(change.text), output[change.end:]...)...)
	}
	outputSource := string(output)
	outputCatalog, err := buildCatalog(outputSource)
	if err != nil {
		return nil, fmt.Errorf("Go parser rejected the renamed output: %s", err.Error())
	}
	// Re-resolve the edited occurrences; a nested closure can shadow a name after the earlier scope check.
	outputIdentifiers := identifiersByOffset(outputCatalog)
	for _, selection := range selected {
		declarationOffset := offsetAfterEdits(selection.item.DeclarationStart, edits)
		declaration := outputIdentifiers[declarationOffset]
		renamedObject := outputCatalog.Info.Defs[declaration]
		if declaration == nil || renamedObject == nil || declaration.Name != selection.newName {
			return nil, fmt.Errorf("Go could not resolve the renamed declaration for %s", selection.item.Name)
		}
		for _, original := range selection.item.Uses {
			outputOffset := offsetAfterEdits(cat.FileSet.File(original.Pos()).Offset(original.Pos()), edits)
			transformed := outputIdentifiers[outputOffset]
			var resolved types.Object
			if original == selection.item.Declaration {
				resolved = outputCatalog.Info.Defs[transformed]
			} else {
				resolved = outputCatalog.Info.Uses[transformed]
			}
			if transformed == nil || transformed.Name != selection.newName || resolved != renamedObject {
				return nil, fmt.Errorf("Renaming %s would change the binding at byte %d", selection.item.Name, outputOffset)
			}
		}
	}
	return map[string]any{
		"source_sha256": cat.Hash, "output_sha256": hashText(outputSource), "source_code": outputSource,
		"renamed_bindings": renamed, "parser_version": runtime.Version(),
	}, nil
}

func projectPackageObjectKind(object types.Object) string {
	switch object.(type) {
	case *types.Func:
		return "package function"
	case *types.TypeName:
		return "package type"
	case *types.Var:
		return "package variable"
	case *types.Const:
		return "package constant"
	default:
		return ""
	}
}

func buildProjectCatalog(req request) (*projectCatalog, error) {
	buildContext, err := normalizeGoBuildContext(req)
	if err != nil {
		return nil, err
	}
	packageImporter := newGoTargetImporter(buildContext)
	defer packageImporter.Close()
	return buildProjectCatalogWithImporter(req, packageImporter)
}

func buildProjectCatalogWithImporter(req request, packageImporter types.Importer) (*projectCatalog, error) {
	if len(req.Files) < 1 || len(req.Files) > maxProjectFiles {
		return nil, fmt.Errorf("Go package snapshot requires between 1 and %d source files", maxProjectFiles)
	}
	selectedPath, err := safeGoPath(req.SelectedPath)
	if err != nil {
		return nil, err
	}
	packageDir := path.Dir(selectedPath)
	files := append([]projectFile(nil), req.Files...)
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	sourceSnapshot := make([]projectSourceFile, 0, len(files))
	for _, file := range files {
		sourceSnapshot = append(sourceSnapshot, projectSourceFile{Path: file.Path, Text: file.Source})
	}
	buildContext, err := normalizeGoBuildContext(req)
	if err != nil {
		return nil, err
	}
	files, err = selectGoBuildFiles(files, buildContext)
	if err != nil {
		return nil, err
	}
	fileSet := token.NewFileSet()
	parsed := make([]projectSourceFile, 0, len(files))
	seenPaths := make(map[string]bool, len(files))
	selectedHash := ""
	packageName := ""
	totalBytes := 0
	for _, input := range files {
		filePath, pathErr := safeGoPath(input.Path)
		if pathErr != nil || filePath != input.Path || path.Dir(filePath) != packageDir {
			return nil, fmt.Errorf("Go package files must have unique, normalized paths in the selected source directory")
		}
		pathKey := strings.ToLower(filePath)
		if seenPaths[pathKey] {
			return nil, fmt.Errorf("Go package source paths collide: %s", filePath)
		}
		seenPaths[pathKey] = true
		sourceBytes := len([]byte(input.Source))
		if sourceBytes > maxProjectFileBytes {
			return nil, fmt.Errorf("%s exceeds the 2 MiB safe-project file limit", filePath)
		}
		totalBytes += sourceBytes
		if totalBytes > maxProjectBytes {
			return nil, fmt.Errorf("Go package source exceeds the 8 MiB safe-rename limit")
		}
		fileHash := hashText(input.Source)
		if input.ExpectedHash != "" && strings.ToLower(input.ExpectedHash) != fileHash {
			return nil, fmt.Errorf("Go package source changed for %s", filePath)
		}
		astFile, parseErr := parser.ParseFile(fileSet, filePath, input.Source, parser.AllErrors|parser.ParseComments)
		if parseErr != nil {
			return nil, fmt.Errorf("Go parser rejected %s: %s", filePath, parseErr.Error())
		}
		if packageName == "" {
			packageName = astFile.Name.Name
		} else if astFile.Name.Name != packageName {
			return nil, fmt.Errorf("Go package source files declare different package names")
		}
		parsed = append(parsed, projectSourceFile{Path: filePath, Text: input.Source, AST: astFile})
		if filePath == selectedPath {
			selectedHash = fileHash
		}
	}
	if selectedHash == "" {
		return nil, fmt.Errorf("Selected Go source is missing from the package snapshot")
	}
	astFiles := make([]*ast.File, 0, len(parsed))
	for _, file := range parsed {
		astFiles = append(astFiles, file.AST)
	}
	info := &types.Info{
		Defs: make(map[*ast.Ident]types.Object), Uses: make(map[*ast.Ident]types.Object),
		Scopes: make(map[ast.Node]*types.Scope), Implicits: make(map[ast.Node]types.Object),
	}
	var typeErrors []error
	conf := types.Config{Importer: packageImporter, Error: func(err error) { typeErrors = append(typeErrors, err) }}
	checkPath := req.PackagePath
	if checkPath == "" {
		checkPath = packageName
	}
	pkg, _ := conf.Check(checkPath, fileSet, astFiles, info)
	if len(typeErrors) > 0 || pkg == nil {
		if len(typeErrors) > 0 {
			return nil, fmt.Errorf("Go package has unresolved type or reference errors (%s); cross-file rename requires a complete package type-check", typeErrors[0].Error())
		}
		return nil, fmt.Errorf("Go package has unresolved type or reference errors; cross-file rename requires a complete package type-check")
	}
	projectHash := hashProjectInventory(parsed, buildContext)
	sourceSetHash := hashProjectSources(sourceSnapshot)
	cat := &projectCatalog{
		Hash: selectedHash, SourceSetHash: sourceSetHash, InventoryScopeHash: projectHash, SelectedPath: selectedPath,
		SelectedHash: selectedHash, FileSet: fileSet, Files: parsed, Info: info, Package: pkg,
	}
	cat.Inventory.SourceFileCount = len(parsed)
	useCounts := make(map[types.Object]int, len(info.Uses))
	for _, object := range info.Uses {
		useCounts[object]++
	}
	declarations := make(map[types.Object]*ast.Ident)
	pathsByObject := make(map[types.Object]string)
	for _, file := range parsed {
		ast.Inspect(file.AST, func(node ast.Node) bool {
			ident, ok := node.(*ast.Ident)
			if !ok {
				return true
			}
			object := info.Defs[ident]
			if object == nil || object.Parent() != pkg.Scope() || ident.Name == "_" {
				return true
			}
			if _, exists := declarations[object]; !exists {
				declarations[object] = ident
				pathsByObject[object] = file.Path
			}
			return true
		})
	}
	for _, name := range pkg.Scope().Names() {
		object := pkg.Scope().Lookup(name)
		declaration := declarations[object]
		if declaration == nil {
			continue
		}
		filePath := pathsByObject[object]
		position := fileSet.PositionFor(declaration.Pos(), false)
		entry := projectInventoryEntry{
			ID: shortID(projectHash+"\x00"+filePath, position.Offset, name), Name: name,
			Scope: "package", RelativePath: filePath, DeclarationStart: position.Offset, ReferenceCount: useCounts[object],
			Exported: token.IsExported(name), NameAssessment: "unassessed", Kind: projectPackageObjectKind(object),
		}
		if entry.Kind == "" {
			entry.Kind = "unsupported package object"
		}
		if token.IsExported(name) {
			cat.Inventory.ExportedPackageSymbolCount++
			entry.Classification = "excluded"
			entry.ClassificationReason = "exported-package-api"
		} else if packageName == "main" && name == "main" {
			cat.Inventory.UnsupportedPackageSymbolCount++
			entry.Classification = "unsupported"
			entry.ClassificationReason = "program-entrypoint"
		} else {
			if projectPackageObjectKind(object) == "" {
				entry.Classification = "unsupported"
				entry.ClassificationReason = "unsupported-package-object-kind"
			}
			if entry.Classification != "unsupported" {
				cat.Inventory.PrivatePackageSymbolCount++
				if useCounts[object] > 0 {
					cat.Inventory.ReferencedPrivatePackageSymbols++
					entry.Classification = "eligible"
					entry.ClassificationReason = "private-package-symbol-with-resolved-references"
				} else {
					cat.Inventory.UnreferencedPrivateSymbols++
					entry.Classification = "excluded"
					entry.ClassificationReason = "unreferenced-package-symbol"
				}
			} else {
				cat.Inventory.UnsupportedPackageSymbolCount++
			}
		}
		cat.Inventory.Entries = append(cat.Inventory.Entries, entry)
	}
	for _, file := range parsed {
		for _, spec := range file.AST.Imports {
			var object types.Object
			position := spec.Path.Pos()
			if spec.Name != nil {
				object = info.Defs[spec.Name]
				position = spec.Name.Pos()
			} else {
				object = info.Implicits[spec]
			}
			if object == nil || object.Name() == "_" {
				continue
			}
			offset := fileSet.PositionFor(position, false).Offset
			entry := projectInventoryEntry{
				ID:   shortID(projectHash+"\x00"+file.Path, offset, object.Name()),
				Name: object.Name(), Kind: "file import alias", Scope: "file", RelativePath: file.Path,
				DeclarationStart: offset, ReferenceCount: useCounts[object], NameAssessment: "unassessed",
			}
			cat.Inventory.FileScopeSymbolCount++
			if object.Name() == "." {
				entry.Kind = "dot import"
				entry.Classification = "unsupported"
				entry.ClassificationReason = "dot-import-out-of-scope"
				cat.Inventory.UnsupportedFileScopeSymbolCount++
			} else if _, ok := object.(*types.PkgName); !ok {
				entry.Kind = "unsupported file-scope object"
				entry.Classification = "unsupported"
				entry.ClassificationReason = "unsupported-file-scope-object-kind"
				cat.Inventory.UnsupportedFileScopeSymbolCount++
			} else if useCounts[object] > 0 {
				entry.Classification = "eligible"
				entry.ClassificationReason = "file-import-alias-with-resolved-references"
				cat.Inventory.ReferencedFileScopeSymbols++
			} else {
				entry.Classification = "excluded"
				entry.ClassificationReason = "unreferenced-file-import-alias"
				cat.Inventory.UnreferencedFileScopeSymbols++
			}
			cat.Inventory.Entries = append(cat.Inventory.Entries, entry)
		}
	}
	localDeclarations := make(map[types.Object]*ast.Ident)
	localPathsByObject := make(map[types.Object]string)
	localTypeSwitchObjects := make(map[types.Object]bool)
	collectLocalDefinitions := func(node ast.Node, filePath string) {
		if node == nil {
			return
		}
		ast.Inspect(node, func(node ast.Node) bool {
			ident, ok := node.(*ast.Ident)
			if !ok {
				return true
			}
			object := info.Defs[ident]
			if object == nil || ident.Name == "_" || object.Name() == "_" || object.Parent() == pkg.Scope() {
				return true
			}
			if _, exists := localDeclarations[object]; !exists {
				localDeclarations[object] = ident
				localPathsByObject[object] = filePath
			}
			return true
		})
	}
	for _, file := range parsed {
		for _, declaration := range file.AST.Decls {
			function, ok := declaration.(*ast.FuncDecl)
			if !ok {
				continue
			}
			if function.Recv != nil {
				collectLocalDefinitions(function.Recv, file.Path)
			}
			if function.Type.TypeParams != nil {
				collectLocalDefinitions(function.Type.TypeParams, file.Path)
			}
			if function.Type.Params != nil {
				collectLocalDefinitions(function.Type.Params, file.Path)
			}
			if function.Type.Results != nil {
				collectLocalDefinitions(function.Type.Results, file.Path)
			}
			if function.Body != nil {
				collectLocalDefinitions(function.Body, file.Path)
			}
		}
		ast.Inspect(file.AST, func(node ast.Node) bool {
			function, ok := node.(*ast.FuncLit)
			if !ok {
				return true
			}
			if function.Type.TypeParams != nil {
				collectLocalDefinitions(function.Type.TypeParams, file.Path)
			}
			if function.Type.Params != nil {
				collectLocalDefinitions(function.Type.Params, file.Path)
			}
			if function.Type.Results != nil {
				collectLocalDefinitions(function.Type.Results, file.Path)
			}
			if function.Body != nil {
				collectLocalDefinitions(function.Body, file.Path)
			}
			return true
		})
		ast.Inspect(file.AST, func(node ast.Node) bool {
			function, ok := node.(*ast.FuncType)
			if !ok {
				return true
			}
			if function.TypeParams != nil {
				collectLocalDefinitions(function.TypeParams, file.Path)
			}
			if function.Params != nil {
				collectLocalDefinitions(function.Params, file.Path)
			}
			if function.Results != nil {
				collectLocalDefinitions(function.Results, file.Path)
			}
			return true
		})
		ast.Inspect(file.AST, func(node ast.Node) bool {
			clause, ok := node.(*ast.CaseClause)
			if !ok {
				return true
			}
			object := info.Implicits[clause]
			if object == nil || object.Name() == "_" || object.Parent() == pkg.Scope() {
				return true
			}
			if _, exists := localDeclarations[object]; !exists {
				localDeclarations[object] = &ast.Ident{Name: object.Name(), NamePos: clause.Case}
				localPathsByObject[object] = file.Path
			}
			localTypeSwitchObjects[object] = true
			return true
		})
	}
	for object, declaration := range localDeclarations {
		kind := "unsupported local object"
		unsupportedReason := "unsupported-local-object-kind"
		supported := true
		switch local := object.(type) {
		case *types.Var:
			if localTypeSwitchObjects[object] {
				kind = "local type-switch variable"
			} else if local.IsField() {
				kind = "local struct field"
				unsupportedReason = "local-struct-field-out-of-scope"
				supported = false
			} else {
				kind = "local variable"
			}
		case *types.Const:
			kind = "local constant"
		case *types.TypeName:
			if _, ok := local.Type().(*types.TypeParam); ok {
				kind = "local type parameter"
			} else {
				kind = "local type"
			}
		case *types.Func:
			if local.Signature().Recv() != nil {
				kind = "local interface method"
				unsupportedReason = "local-interface-method-out-of-scope"
				supported = false
			} else {
				kind = "local function"
			}
		case *types.Label:
			kind = "local label"
			unsupportedReason = "local-label-out-of-scope"
			supported = false
		default:
			supported = false
		}
		filePath := localPathsByObject[object]
		position := fileSet.PositionFor(declaration.Pos(), false)
		entry := projectInventoryEntry{
			ID:   shortID(projectHash+"\x00"+filePath, position.Offset, declaration.Name),
			Name: declaration.Name, Kind: kind, Scope: "local", RelativePath: filePath,
			DeclarationStart: position.Offset, ReferenceCount: useCounts[object], NameAssessment: "unassessed",
		}
		cat.Inventory.LocalSymbolCount++
		if !supported {
			cat.Inventory.UnsupportedLocalSymbolCount++
			entry.Classification = "unsupported"
			entry.ClassificationReason = unsupportedReason
		} else if useCounts[object] > 0 {
			cat.Inventory.ReferencedLocalSymbols++
			entry.Classification = "eligible"
			entry.ClassificationReason = "local-symbol-with-resolved-references"
		} else {
			cat.Inventory.UnreferencedLocalSymbols++
			entry.Classification = "excluded"
			entry.ClassificationReason = "unreferenced-local-symbol"
		}
		cat.Inventory.Entries = append(cat.Inventory.Entries, entry)
	}
	memberObjects := make(map[types.Object]bool)
	for identifier, object := range info.Defs {
		if object == nil || identifier.Name == "_" || object.Name() == "_" || object.Pkg() != pkg {
			continue
		}
		if _, alreadyInventoried := localDeclarations[object]; alreadyInventoried || memberObjects[object] {
			continue
		}
		kind := ""
		switch member := object.(type) {
		case *types.Var:
			if member.IsField() {
				kind = "struct field"
			}
		case *types.Func:
			if member.Signature().Recv() != nil {
				kind = "method"
			} else if object.Parent() != pkg.Scope() {
				kind = "interface method"
			}
		case *types.TypeName:
			if _, ok := member.Type().(*types.TypeParam); ok {
				kind = "type parameter"
			}
		}
		if kind == "" {
			continue
		}
		memberObjects[object] = true
		position := fileSet.PositionFor(identifier.Pos(), false)
		entry := projectInventoryEntry{
			ID:   shortID(projectHash+"\x00"+position.Filename, position.Offset, object.Name()),
			Name: object.Name(), Kind: kind, Scope: "member", RelativePath: position.Filename,
			DeclarationStart: position.Offset, ReferenceCount: useCounts[object], Exported: token.IsExported(object.Name()),
			Classification: "unsupported", ClassificationReason: "go-member-not-offered-by-project-inventory", NameAssessment: "unassessed",
		}
		cat.Inventory.MemberSymbolCount++
		cat.Inventory.UnsupportedMemberSymbolCount++
		cat.Inventory.Entries = append(cat.Inventory.Entries, entry)
	}
	for _, file := range parsed {
		for _, declaration := range file.AST.Decls {
			function, ok := declaration.(*ast.FuncDecl)
			if ok && function.Name.Name == "init" {
				cat.Inventory.UnsupportedPackageSymbolCount++
				position := fileSet.PositionFor(function.Name.Pos(), false)
				cat.Inventory.Entries = append(cat.Inventory.Entries, projectInventoryEntry{
					ID:   shortID(projectHash+"\x00"+file.Path, position.Offset, "init"),
					Name: "init", Kind: "initialization function", Scope: "package", RelativePath: file.Path,
					DeclarationStart: position.Offset, Classification: "unsupported",
					ClassificationReason: "special-initialization-function", NameAssessment: "unassessed",
				})
			}
		}
	}
	sort.Slice(cat.Inventory.Entries, func(i, j int) bool {
		if cat.Inventory.Entries[i].RelativePath != cat.Inventory.Entries[j].RelativePath {
			return cat.Inventory.Entries[i].RelativePath < cat.Inventory.Entries[j].RelativePath
		}
		return cat.Inventory.Entries[i].DeclarationStart < cat.Inventory.Entries[j].DeclarationStart
	})
	cat.Inventory.EntryCount = len(cat.Inventory.Entries)
	cat.Inventory.EntriesTruncated = cat.Inventory.EntryCount > maxProjectInventoryEntries
	if cat.Inventory.EntriesTruncated {
		cat.Inventory.Entries = cat.Inventory.Entries[:maxProjectInventoryEntries]
	}
	for object, declaration := range declarations {
		if token.IsExported(declaration.Name) {
			continue
		}
		var kind string
		switch object.(type) {
		case *types.Func:
			kind = "package function"
		case *types.TypeName:
			kind = "package type"
		case *types.Var:
			kind = "package variable"
		case *types.Const:
			kind = "package constant"
		default:
			continue
		}
		uses := []*ast.Ident{declaration}
		for ident, used := range info.Uses {
			if used == object {
				uses = append(uses, ident)
			}
		}
		if len(uses) <= 1 {
			continue
		}
		position := fileSet.PositionFor(declaration.Pos(), false)
		id := shortID(projectHash+"\x00"+pathsByObject[object], position.Offset, declaration.Name)
		cat.Bindings = append(cat.Bindings, binding{
			ID: id, FilePath: pathsByObject[object], Name: declaration.Name, Kind: kind,
			ScopeType: "package", DeclarationStart: position.Offset, ReferenceCount: len(uses) - 1,
			Object: object, Scope: pkg.Scope(), Declaration: declaration, Uses: uses,
		})
	}
	methodObjects := make(map[types.Object]bool)
	for identifier, object := range info.Defs {
		method, ok := object.(*types.Func)
		if !ok || method.Signature().Recv() == nil || method.Pkg() != pkg || token.IsExported(method.Name()) || methodObjects[method] {
			continue
		}
		methodObjects[method] = true
		position := fileSet.PositionFor(identifier.Pos(), false)
		uses := []*ast.Ident{identifier}
		for ident, used := range info.Uses {
			if used == method {
				uses = append(uses, ident)
			}
		}
		if len(uses) <= 1 {
			continue
		}
		sort.Slice(uses[1:], func(i, j int) bool {
			left, right := fileSet.PositionFor(uses[i+1].Pos(), false), fileSet.PositionFor(uses[j+1].Pos(), false)
			if left.Filename != right.Filename {
				return left.Filename < right.Filename
			}
			return left.Offset < right.Offset
		})
		cat.Bindings = append(cat.Bindings, binding{
			ID:       shortID(projectHash+"\x00"+position.Filename, position.Offset, identifier.Name),
			FilePath: position.Filename, Name: identifier.Name, Kind: "method", ScopeType: "member",
			DeclarationStart: position.Offset, ReferenceCount: len(uses) - 1,
			Object: method, Declaration: identifier, Uses: uses,
		})
	}
	for _, file := range parsed {
		for _, spec := range file.AST.Imports {
			if spec.Name == nil {
				continue // Implicit imports have no source declaration identifier to edit.
			}
			object, ok := info.Defs[spec.Name].(*types.PkgName)
			if !ok || object.Name() == "_" || object.Name() == "." {
				continue
			}
			uses := []*ast.Ident{spec.Name}
			for ident, used := range info.Uses {
				if used == object {
					uses = append(uses, ident)
				}
			}
			if len(uses) <= 1 {
				continue
			}
			position := fileSet.PositionFor(spec.Name.Pos(), false)
			sort.Slice(uses[1:], func(i, j int) bool { return uses[i+1].Pos() < uses[j+1].Pos() })
			cat.Bindings = append(cat.Bindings, binding{
				ID:       shortID(projectHash+"\x00"+file.Path, position.Offset, spec.Name.Name),
				FilePath: file.Path, Name: spec.Name.Name, Kind: "file import alias", ScopeType: "file",
				DeclarationStart: position.Offset, ReferenceCount: len(uses) - 1,
				Object: object, Scope: object.Parent(), Declaration: spec.Name, Uses: uses,
			})
		}
	}
	sort.Slice(cat.Bindings, func(i, j int) bool {
		if cat.Bindings[i].FilePath != cat.Bindings[j].FilePath {
			return cat.Bindings[i].FilePath < cat.Bindings[j].FilePath
		}
		return cat.Bindings[i].DeclarationStart < cat.Bindings[j].DeclarationStart
	})
	cat.Truncated = len(cat.Bindings) > maxBindings
	if cat.Truncated {
		cat.Bindings = cat.Bindings[:maxBindings]
	}
	return cat, nil
}

func safeGoPath(value string) (string, error) {
	if value == "" || strings.ContainsAny(value, "\\\r\n\x00") || path.IsAbs(value) {
		return "", fmt.Errorf("Go package source path is invalid")
	}
	clean := path.Clean(value)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") || clean != value {
		return "", fmt.Errorf("Go package source path is invalid")
	}
	return clean, nil
}

func hashProjectSources(files []projectSourceFile) string {
	ordered := append([]projectSourceFile(nil), files...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].Path < ordered[j].Path })
	h := newHash()
	for _, file := range ordered {
		_, _ = io.WriteString(h, file.Path+"\x00"+hashText(file.Text)+"\n")
	}
	return hex.EncodeToString(h.Sum(nil))
}

func listProjectBindings(req request) (map[string]any, error) {
	cat, err := buildProjectCatalog(req)
	if err != nil {
		return nil, err
	}
	bindings := make([]map[string]any, 0, len(cat.Bindings))
	for _, item := range cat.Bindings {
		if item.FilePath != cat.SelectedPath {
			continue
		}
		bindings = append(bindings, map[string]any{
			"id": item.ID, "name": item.Name, "kind": item.Kind, "scopeType": item.ScopeType,
			"declarationStart": item.DeclarationStart, "referenceCount": item.ReferenceCount,
			"relativePath": item.FilePath, "exported": false,
		})
	}
	files := make([]map[string]any, 0, len(cat.Files))
	for _, file := range cat.Files {
		files = append(files, map[string]any{"relative_path": file.Path, "source_sha256": hashText(file.Text)})
	}
	return map[string]any{
		"source_sha256": cat.SelectedHash, "source_set_sha256": cat.SourceSetHash,
		"inventory_scope_sha256": cat.InventoryScopeHash,
		"selected_path":          cat.SelectedPath, "files": files,
		"bindings": bindings, "truncated": cat.Truncated, "parser_version": runtime.Version(),
		"inventory": map[string]any{
			"scope":                               "reviewed-same-directory-go-package-source-snapshot",
			"source_file_count":                   cat.Inventory.SourceFileCount,
			"package_count":                       1,
			"private_package_symbol_count":        cat.Inventory.PrivatePackageSymbolCount,
			"referenced_private_package_symbols":  cat.Inventory.ReferencedPrivatePackageSymbols,
			"unreferenced_private_symbols":        cat.Inventory.UnreferencedPrivateSymbols,
			"exported_package_symbol_count":       cat.Inventory.ExportedPackageSymbolCount,
			"unsupported_package_symbol_count":    cat.Inventory.UnsupportedPackageSymbolCount,
			"file_scope_symbol_count":             cat.Inventory.FileScopeSymbolCount,
			"referenced_file_scope_symbols":       cat.Inventory.ReferencedFileScopeSymbols,
			"unreferenced_file_scope_symbols":     cat.Inventory.UnreferencedFileScopeSymbols,
			"unsupported_file_scope_symbol_count": cat.Inventory.UnsupportedFileScopeSymbolCount,
			"local_symbol_count":                  cat.Inventory.LocalSymbolCount,
			"referenced_local_symbols":            cat.Inventory.ReferencedLocalSymbols,
			"unreferenced_local_symbols":          cat.Inventory.UnreferencedLocalSymbols,
			"unsupported_local_symbol_count":      cat.Inventory.UnsupportedLocalSymbolCount,
			"member_symbol_count":                 cat.Inventory.MemberSymbolCount,
			"unsupported_member_symbol_count":     cat.Inventory.UnsupportedMemberSymbolCount,
			"rename_binding_catalog_truncated":    cat.Truncated,
			"entry_count":                         cat.Inventory.EntryCount,
			"entries_truncated":                   cat.Inventory.EntriesTruncated,
			"entries":                             cat.Inventory.Entries,
		},
	}, nil
}

func listProjectInventory(req request) (map[string]any, error) {
	if len(req.Files) < 1 || len(req.Files) > maxProjectFiles {
		return nil, fmt.Errorf("Go project inventory requires between 1 and %d source files", maxProjectFiles)
	}
	selectedPath, err := safeGoPath(req.SelectedPath)
	if err != nil {
		return nil, err
	}
	if req.ModulePath != "" && !safeGoModuleImportPath(req.ModulePath) {
		return nil, fmt.Errorf("Go module path is invalid")
	}
	if req.ModuleRoot != "" {
		moduleRoot, rootErr := safeGoModuleRoot(req.ModuleRoot)
		if rootErr != nil || moduleRoot != req.ModuleRoot || req.ModulePath == "" {
			return nil, fmt.Errorf("Go module root is invalid")
		}
	}
	files := append([]projectFile(nil), req.Files...)
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	sourceSnapshot := make([]projectSourceFile, 0, len(files))
	for _, file := range files {
		filePath, pathErr := safeGoPath(file.Path)
		if pathErr != nil || filePath != file.Path {
			return nil, fmt.Errorf("Go project inventory requires normalized source paths")
		}
		sourceSnapshot = append(sourceSnapshot, projectSourceFile{Path: file.Path, Text: file.Source})
	}
	buildContext, err := normalizeGoBuildContext(req)
	if err != nil {
		return nil, err
	}
	selectedFiles, err := selectGoBuildFiles(files, buildContext)
	if err != nil {
		return nil, err
	}
	files = selectedFiles
	seenPaths := make(map[string]bool, len(files))
	groups := make(map[string][]projectFile)
	selectedHash := ""
	totalBytes := 0
	for _, file := range files {
		filePath, pathErr := safeGoPath(file.Path)
		if pathErr != nil || filePath != file.Path {
			return nil, fmt.Errorf("Go project inventory requires normalized source paths")
		}
		pathKey := strings.ToLower(filePath)
		if seenPaths[pathKey] {
			return nil, fmt.Errorf("Go project source paths collide: %s", filePath)
		}
		seenPaths[pathKey] = true
		totalBytes += len([]byte(file.Source))
		if totalBytes > maxProjectBytes {
			return nil, fmt.Errorf("Go project source exceeds the 8 MiB inventory limit")
		}
		fileHash := hashText(file.Source)
		if file.ExpectedHash != "" && !strings.EqualFold(file.ExpectedHash, fileHash) {
			return nil, fmt.Errorf("Go project source changed for %s", file.Path)
		}
		fileSet := token.NewFileSet()
		astFile, parseErr := parser.ParseFile(fileSet, filePath, file.Source, parser.AllErrors|parser.ParseComments)
		if parseErr != nil {
			return nil, fmt.Errorf("Go parser rejected %s: %s", filePath, parseErr.Error())
		}
		key := path.Dir(filePath) + "\x00" + astFile.Name.Name
		groups[key] = append(groups[key], file)
		if filePath == selectedPath {
			if req.Source != file.Source {
				return nil, fmt.Errorf("Selected Go source does not match the project inventory snapshot")
			}
			selectedHash = fileHash
		}
	}
	if selectedHash == "" {
		return nil, fmt.Errorf("Selected Go source is missing from the project inventory")
	}
	allSources := make([]projectSourceFile, 0, len(files))
	resultFiles := make([]map[string]any, 0, len(files))
	for _, file := range files {
		allSources = append(allSources, projectSourceFile{Path: file.Path, Text: file.Source})
		resultFiles = append(resultFiles, map[string]any{"relative_path": file.Path, "source_sha256": hashText(file.Source)})
	}
	projectHash := hashProjectInventory(allSources, buildContext)
	groupKeys := make([]string, 0, len(groups))
	for key := range groups {
		groupKeys = append(groupKeys, key)
	}
	sort.Strings(groupKeys)
	packageRequests := make(map[string]request, len(groups))
	importPaths := make(map[string]string, len(groups))
	for _, key := range groupKeys {
		group := groups[key]
		packageDir := path.Dir(group[0].Path)
		importPath, pathErr := projectPackageImportPath(req.ModulePath, req.ModuleRoot, packageDir)
		if pathErr != nil {
			return nil, pathErr
		}
		if importPath == "" {
			continue
		}
		if previous, exists := importPaths[importPath]; exists {
			return nil, fmt.Errorf("Go module package path %s is ambiguous between %s and %s", importPath, previous, packageDir)
		}
		importPaths[importPath] = packageDir
		packageRequests[importPath] = request{
			SelectedPath: group[0].Path, Source: group[0].Source, Files: group, PackagePath: importPath,
			BuildGOOS: buildContext.GOOS, BuildGOARCH: buildContext.GOARCH, BuildCgo: &buildContext.CgoEnabled, BuildTags: buildContext.Tags,
		}
	}
	projectImporter := &goProjectImporter{
		packages: packageRequests, catalogs: make(map[string]*projectCatalog),
		visiting: make(map[string]bool), fallback: newGoTargetImporter(buildContext),
	}
	if closeable, ok := projectImporter.fallback.(interface{ Close() error }); ok {
		defer closeable.Close()
	}
	aggregate := projectInventory{SourceFileCount: len(files), PackageCount: len(groups)}
	entries := make([]projectInventoryEntry, 0)
	packages := make([]map[string]any, 0, len(groups))
	for _, key := range groupKeys {
		group := groups[key]
		groupSelectedPath := group[0].Path
		for _, file := range group {
			if file.Path == selectedPath {
				groupSelectedPath = selectedPath
			}
		}
		groupSelectedSource := ""
		for _, file := range group {
			if file.Path == groupSelectedPath {
				groupSelectedSource = file.Source
			}
		}
		packageDir := path.Dir(groupSelectedPath)
		importPath, pathErr := projectPackageImportPath(req.ModulePath, req.ModuleRoot, packageDir)
		if pathErr != nil {
			return nil, pathErr
		}
		packageRequest := request{
			SelectedPath: groupSelectedPath, Source: groupSelectedSource, Files: group,
			BuildGOOS: buildContext.GOOS, BuildGOARCH: buildContext.GOARCH, BuildCgo: &buildContext.CgoEnabled, BuildTags: buildContext.Tags,
		}
		var catalog *projectCatalog
		var catalogErr error
		if importPath != "" {
			catalog, catalogErr = projectImporter.load(importPath)
		} else {
			catalog, catalogErr = buildProjectCatalog(packageRequest)
		}
		if catalogErr != nil {
			return nil, fmt.Errorf("cannot inventory Go package %s: %s", packageDir, catalogErr.Error())
		}
		addProjectInventoryCounts(&aggregate, catalog.Inventory)
		packageName := catalog.Files[0].AST.Name.Name
		packages = append(packages, map[string]any{
			"directory": path.Dir(groupSelectedPath), "package_name": packageName,
			"source_file_count": len(group), "source_set_sha256": catalog.SourceSetHash,
		})
		for _, entry := range catalog.Inventory.Entries {
			entry.ID = shortID(projectHash+"\x00"+entry.RelativePath, entry.DeclarationStart, entry.Name)
			entries = append(entries, entry)
		}
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].RelativePath != entries[j].RelativePath {
			return entries[i].RelativePath < entries[j].RelativePath
		}
		return entries[i].DeclarationStart < entries[j].DeclarationStart
	})
	aggregate.EntryCount = len(entries)
	aggregate.EntriesTruncated = len(entries) > maxProjectInventoryEntries
	if aggregate.EntriesTruncated {
		entries = entries[:maxProjectInventoryEntries]
	}
	return map[string]any{
		"source_sha256": selectedHash, "source_set_sha256": hashProjectSources(sourceSnapshot),
		"inventory_scope_sha256": projectHash,
		"selected_path":          selectedPath, "module_path": req.ModulePath, "module_root": req.ModuleRoot,
		"go_mod_sha256": buildContext.GoModHash, "go_sum_sha256": buildContext.GoSumHash,
		"build_context": buildContext,
		"files":         resultFiles, "packages": packages,
		"parser_version": runtime.Version(),
		"inventory": map[string]any{
			"scope": "verified-whole-project-go-source-snapshot", "complete": true,
			"source_file_count": aggregate.SourceFileCount, "package_count": aggregate.PackageCount,
			"private_package_symbol_count":        aggregate.PrivatePackageSymbolCount,
			"referenced_private_package_symbols":  aggregate.ReferencedPrivatePackageSymbols,
			"unreferenced_private_symbols":        aggregate.UnreferencedPrivateSymbols,
			"exported_package_symbol_count":       aggregate.ExportedPackageSymbolCount,
			"unsupported_package_symbol_count":    aggregate.UnsupportedPackageSymbolCount,
			"file_scope_symbol_count":             aggregate.FileScopeSymbolCount,
			"referenced_file_scope_symbols":       aggregate.ReferencedFileScopeSymbols,
			"unreferenced_file_scope_symbols":     aggregate.UnreferencedFileScopeSymbols,
			"unsupported_file_scope_symbol_count": aggregate.UnsupportedFileScopeSymbolCount,
			"local_symbol_count":                  aggregate.LocalSymbolCount,
			"referenced_local_symbols":            aggregate.ReferencedLocalSymbols,
			"unreferenced_local_symbols":          aggregate.UnreferencedLocalSymbols,
			"unsupported_local_symbol_count":      aggregate.UnsupportedLocalSymbolCount,
			"member_symbol_count":                 aggregate.MemberSymbolCount,
			"unsupported_member_symbol_count":     aggregate.UnsupportedMemberSymbolCount,
			"entry_count":                         aggregate.EntryCount, "entries_truncated": aggregate.EntriesTruncated,
			"entries": entries,
		},
	}, nil
}

type goBuildContext struct {
	GOOS                string            `json:"goos"`
	GOARCH              string            `json:"goarch"`
	CgoEnabled          bool              `json:"cgo_enabled"`
	Tags                []string          `json:"tags"`
	ArchitectureOptions map[string]string `json:"architecture_options"`
	Toolchain           string            `json:"toolchain"`
	ModulePath          string            `json:"module_path"`
	ModuleRoot          string            `json:"module_root"`
	GoModHash           string            `json:"go_mod_sha256"`
	GoSumHash           string            `json:"go_sum_sha256"`
	GoMod               string            `json:"-"`
	GoSum               string            `json:"-"`
}

func normalizeGoBuildContext(req request) (goBuildContext, error) {
	if err := validateGoModuleReceipt(req); err != nil {
		return goBuildContext{}, err
	}
	goos, goarch := req.BuildGOOS, req.BuildGOARCH
	if goos == "" {
		goos = runtime.GOOS
	}
	if goarch == "" {
		goarch = runtime.GOARCH
	}
	if err := validateGoTarget(goos, goarch); err != nil {
		return goBuildContext{}, err
	}
	tags := append([]string(nil), req.BuildTags...)
	seen := make(map[string]bool, len(tags))
	for _, tag := range tags {
		if !token.IsIdentifier(tag) || seen[tag] {
			return goBuildContext{}, fmt.Errorf("Go build tags must be unique identifiers")
		}
		seen[tag] = true
	}
	sort.Strings(tags)
	cgoEnabled := build.Default.CgoEnabled
	if goos != runtime.GOOS || goarch != runtime.GOARCH {
		cgoEnabled = false
	}
	if req.BuildCgo != nil {
		cgoEnabled = *req.BuildCgo
	}
	architectureOptions, err := goArchitectureOptions(goos, goarch)
	if err != nil {
		return goBuildContext{}, err
	}
	return goBuildContext{
		GOOS: goos, GOARCH: goarch, CgoEnabled: cgoEnabled, Tags: tags,
		ArchitectureOptions: architectureOptions, Toolchain: runtime.Version(),
		ModulePath: req.ModulePath, ModuleRoot: req.ModuleRoot,
		GoModHash: strings.ToLower(req.GoModHash), GoSumHash: strings.ToLower(req.GoSumHash),
		GoMod: req.GoMod, GoSum: req.GoSum,
	}, nil
}

func validateGoModuleReceipt(req request) error {
	if len([]byte(req.GoMod)) > 1024*1024 || len([]byte(req.GoSum)) > 1024*1024 {
		return fmt.Errorf("Go module manifests exceed the 1 MiB limit")
	}
	if req.GoMod == "" {
		if req.GoModHash != "" || req.GoSum != "" || req.GoSumHash != "" || req.ModulePath != "" || req.ModuleRoot != "" {
			return fmt.Errorf("Go module identity requires a complete hash-verified go.mod receipt")
		}
		return nil
	}
	if len(req.GoModHash) != 64 || !strings.EqualFold(req.GoModHash, hashText(req.GoMod)) {
		return fmt.Errorf("Go module manifest hash does not match its receipt")
	}
	if req.GoSum != "" {
		if len(req.GoSumHash) != 64 || !strings.EqualFold(req.GoSumHash, hashText(req.GoSum)) {
			return fmt.Errorf("Go checksum manifest hash does not match its receipt")
		}
	} else if req.GoSumHash != "" {
		return fmt.Errorf("Go checksum manifest hash was provided without go.sum")
	}
	if !safeGoModuleImportPath(req.ModulePath) {
		return fmt.Errorf("Go module path is invalid")
	}
	if req.ModuleRoot != "" {
		moduleRoot, err := safeGoModuleRoot(req.ModuleRoot)
		if err != nil || moduleRoot != req.ModuleRoot {
			return fmt.Errorf("Go module root is invalid")
		}
	}
	modulePath := ""
	for _, line := range strings.Split(req.GoMod, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "module ") {
			continue
		}
		fields := strings.Fields(strings.TrimSpace(strings.TrimPrefix(line, "module ")))
		if len(fields) > 0 {
			modulePath = fields[0]
		}
		modulePath = strings.Trim(modulePath, "\"")
		break
	}
	if modulePath == "" || modulePath != req.ModulePath {
		return fmt.Errorf("Go module path does not match the verified go.mod")
	}
	return nil
}

var supportedGoTargets struct {
	once sync.Once
	set  map[string]bool
	err  error
}

func validateGoTarget(goos, goarch string) error {
	supportedGoTargets.once.Do(func() {
		output, err := exec.Command("go", "tool", "dist", "list").Output()
		if err != nil {
			supportedGoTargets.err = fmt.Errorf("could not read supported targets from the local Go toolchain")
			return
		}
		supportedGoTargets.set = make(map[string]bool)
		for _, target := range strings.Fields(string(output)) {
			supportedGoTargets.set[target] = true
		}
	})
	if supportedGoTargets.err != nil {
		return supportedGoTargets.err
	}
	if !supportedGoTargets.set[goos+"/"+goarch] {
		return fmt.Errorf("Go build target %s/%s is not supported by the local toolchain", goos, goarch)
	}
	return nil
}

var goArchitectureOptionCache sync.Map

func goArchitectureOptions(goos, goarch string) (map[string]string, error) {
	key := goos + "/" + goarch
	if cached, ok := goArchitectureOptionCache.Load(key); ok {
		return cloneStringMap(cached.(map[string]string)), nil
	}
	architectureKeys := []string{"GOARM", "GOARM64", "GO386", "GOAMD64", "GOMIPS", "GOMIPS64", "GOPPC64", "GORISCV64", "GOWASM"}
	context := goBuildContext{GOOS: goos, GOARCH: goarch, ArchitectureOptions: make(map[string]string, len(architectureKeys))}
	for _, key := range architectureKeys {
		context.ArchitectureOptions[key] = ""
	}
	command := exec.Command("go", "env", "-json", "GOARM", "GOARM64", "GO386", "GOAMD64", "GOMIPS", "GOMIPS64", "GOPPC64", "GORISCV64", "GOWASM")
	command.Env = goBuildCommandEnvironment(context)
	output, err := command.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("could not read Go architecture defaults for %s: %s", key, strings.TrimSpace(string(output)))
	}
	options := make(map[string]string)
	if err := json.Unmarshal(output, &options); err != nil {
		return nil, fmt.Errorf("Go returned invalid architecture defaults for %s", key)
	}
	actual, _ := goArchitectureOptionCache.LoadOrStore(key, options)
	return cloneStringMap(actual.(map[string]string)), nil
}

func cloneStringMap(input map[string]string) map[string]string {
	output := make(map[string]string, len(input))
	for key, value := range input {
		output[key] = value
	}
	return output
}

type goTargetImporter struct {
	target    goBuildContext
	moduleDir string
	tempDir   string
	setupErr  error
	importer  types.Importer
}

func newGoTargetImporter(target goBuildContext) *goTargetImporter {
	result := &goTargetImporter{target: target}
	if target.GoMod != "" {
		result.setupErr = result.prepareModuleWorkspace()
	}
	lookup := func(importPath string) (io.ReadCloser, error) {
		if result.setupErr != nil {
			return nil, result.setupErr
		}
		arguments := []string{"list"}
		if target.GoMod != "" {
			arguments = append(arguments, "-mod=readonly")
		}
		arguments = append(arguments, "-export", "-f", "{{.Standard}}\n{{.Export}}")
		if len(target.Tags) > 0 {
			arguments = append(arguments, "-tags="+strings.Join(target.Tags, ","))
		}
		arguments = append(arguments, importPath)
		command := exec.Command("go", arguments...)
		command.Env = goBuildCommandEnvironment(target)
		if result.moduleDir != "" {
			command.Dir = result.moduleDir
		}
		output, err := command.CombinedOutput()
		if err != nil {
			return nil, fmt.Errorf("could not resolve offline Go package %s for %s/%s: %s", importPath, target.GOOS, target.GOARCH, strings.TrimSpace(string(output)))
		}
		fields := strings.SplitN(strings.TrimSpace(string(output)), "\n", 2)
		if len(fields) != 2 || (fields[0] != "true" && target.GoMod == "") {
			return nil, fmt.Errorf("Go package %s is not in the standard library; external modules require verified offline dependency receipts", importPath)
		}
		exportPath := strings.TrimSpace(fields[1])
		if exportPath == "" {
			return nil, fmt.Errorf("Go toolchain returned no export data for %s", importPath)
		}
		file, err := os.Open(exportPath)
		if err != nil {
			return nil, fmt.Errorf("Go export data for %s is unavailable", importPath)
		}
		return file, nil
	}
	result.importer = importer.ForCompiler(token.NewFileSet(), "gc", lookup)
	return result
}

func (i *goTargetImporter) Import(importPath string) (*types.Package, error) {
	return i.importer.Import(importPath)
}

func (i *goTargetImporter) Close() error {
	if i.tempDir == "" {
		return nil
	}
	return os.RemoveAll(i.tempDir)
}

func (i *goTargetImporter) prepareModuleWorkspace() error {
	i.tempDir = ""
	tempDir, err := os.MkdirTemp("", "reamon-go-offline-module-")
	if err != nil {
		return fmt.Errorf("could not prepare isolated Go module workspace")
	}
	i.tempDir = tempDir
	moduleDir := tempDir
	if i.target.ModuleRoot != "" {
		moduleDir = filepath.Join(tempDir, filepath.FromSlash(i.target.ModuleRoot))
		if err := os.MkdirAll(moduleDir, 0700); err != nil {
			return fmt.Errorf("could not prepare isolated Go module root")
		}
	}
	if err := os.WriteFile(filepath.Join(moduleDir, "go.mod"), []byte(i.target.GoMod), 0600); err != nil {
		return fmt.Errorf("could not stage verified go.mod")
	}
	if i.target.GoSum != "" {
		if err := os.WriteFile(filepath.Join(moduleDir, "go.sum"), []byte(i.target.GoSum), 0600); err != nil {
			return fmt.Errorf("could not stage verified go.sum")
		}
	}
	i.moduleDir = moduleDir
	environment := goBuildCommandEnvironment(i.target)
	edit := exec.Command("go", "mod", "edit", "-json")
	edit.Dir, edit.Env = moduleDir, setGoEnvironmentValue(environment, "GOFLAGS", "")
	metadataBytes, err := edit.CombinedOutput()
	if err != nil {
		return fmt.Errorf("Go could not parse the verified module manifest: %s", strings.TrimSpace(string(metadataBytes)))
	}
	var metadata struct {
		Module  struct{ Path string }
		Replace []struct {
			New struct {
				Path    string
				Version string
			}
		}
	}
	if err := json.Unmarshal(metadataBytes, &metadata); err != nil || metadata.Module.Path != i.target.ModulePath {
		return fmt.Errorf("Go module manifest identity does not match the verified module path")
	}
	for _, replacement := range metadata.Replace {
		if replacement.New.Version == "" {
			return fmt.Errorf("local Go module replacements are unsupported in isolated inventory")
		}
	}
	verify := exec.Command("go", "mod", "verify")
	verify.Dir, verify.Env = moduleDir, environment
	if output, err := verify.CombinedOutput(); err != nil {
		return fmt.Errorf("offline Go module cache verification failed: %s", strings.TrimSpace(string(output)))
	}
	return nil
}

func setGoEnvironmentValue(environment []string, key, value string) []string {
	result := make([]string, 0, len(environment)+1)
	for _, entry := range environment {
		entryKey, _, ok := strings.Cut(entry, "=")
		if ok && entryKey == key {
			continue
		}
		result = append(result, entry)
	}
	return append(result, key+"="+value)
}

func goBuildCommandEnvironment(target goBuildContext) []string {
	go111module := "off"
	goFlags := ""
	if target.GoMod != "" {
		go111module = "on"
		goFlags = "-mod=readonly"
	}
	values := map[string]string{
		"GOOS": target.GOOS, "GOARCH": target.GOARCH,
		"GO111MODULE": go111module,
		"GOWORK":      "off", "GOFLAGS": goFlags, "GOPROXY": "off", "GOSUMDB": "off", "GOVCS": "*:off",
		"GOTOOLCHAIN": "local", "GOENV": "off",
	}
	if moduleCache := strings.TrimSpace(os.Getenv("REAMON_GO_MODULE_CACHE")); moduleCache != "" {
		values["GOMODCACHE"] = moduleCache
	}
	for key, value := range target.ArchitectureOptions {
		values[key] = value
	}
	if target.CgoEnabled {
		values["CGO_ENABLED"] = "1"
	} else {
		values["CGO_ENABLED"] = "0"
	}
	environment := make([]string, 0, len(os.Environ())+len(values))
	for _, value := range os.Environ() {
		key, _, ok := strings.Cut(value, "=")
		if _, overridden := values[key]; ok && overridden {
			continue
		}
		environment = append(environment, value)
	}
	for key, value := range values {
		environment = append(environment, key+"="+value)
	}
	return environment
}

func selectGoBuildFiles(files []projectFile, target goBuildContext) ([]projectFile, error) {
	fileSelectionContext := target
	fileSelectionContext.ModulePath = ""
	fileSelectionContext.ModuleRoot = ""
	fileSelectionContext.GoModHash = ""
	fileSelectionContext.GoSumHash = ""
	fileSelectionContext.GoMod = ""
	fileSelectionContext.GoSum = ""
	root, err := os.MkdirTemp("", "reamon-go-build-context-")
	if err != nil {
		return nil, fmt.Errorf("could not prepare Go build-context snapshot")
	}
	defer os.RemoveAll(root)
	for _, file := range files {
		filePath, pathErr := safeGoPath(file.Path)
		if pathErr != nil || filePath != file.Path {
			return nil, fmt.Errorf("Go project inventory requires normalized source paths")
		}
		fullPath := filepath.Join(root, filepath.FromSlash(filePath))
		if err := os.MkdirAll(filepath.Dir(fullPath), 0700); err != nil {
			return nil, fmt.Errorf("could not prepare Go build-context snapshot")
		}
		if err := os.WriteFile(fullPath, []byte(file.Source), 0600); err != nil {
			return nil, fmt.Errorf("could not prepare Go build-context snapshot")
		}
	}
	filesByDirectory := make(map[string][]projectFile)
	for _, file := range files {
		filesByDirectory[path.Dir(file.Path)] = append(filesByDirectory[path.Dir(file.Path)], file)
	}
	directories := make([]string, 0, len(filesByDirectory))
	for directory := range filesByDirectory {
		directories = append(directories, directory)
	}
	sort.Strings(directories)
	selected := make([]projectFile, 0, len(files))
	for _, directory := range directories {
		packageDirectory := filepath.Join(root, filepath.FromSlash(directory))
		arguments := []string{"list", "-e", "-f", `{{range .GoFiles}}{{.}}{{"\n"}}{{end}}{{range .TestGoFiles}}{{.}}{{"\n"}}{{end}}{{if .CgoFiles}}REAMON_CGO_UNSUPPORTED{{end}}`}
		if len(target.Tags) > 0 {
			arguments = append(arguments, "-tags="+strings.Join(target.Tags, ","))
		}
		arguments = append(arguments, ".")
		command := exec.Command("go", arguments...)
		command.Dir = packageDirectory
		command.Env = goBuildCommandEnvironment(fileSelectionContext)
		output, err := command.CombinedOutput()
		if err != nil {
			return nil, fmt.Errorf("Go could not select source files for %s/%s in %s: %s", target.GOOS, target.GOARCH, directory, strings.TrimSpace(string(output)))
		}
		selectedNames := make(map[string]bool)
		for _, name := range strings.Split(strings.TrimSpace(string(output)), "\n") {
			name = strings.TrimSpace(name)
			if name == "" {
				continue
			}
			if name == "REAMON_CGO_UNSUPPORTED" {
				return nil, fmt.Errorf("Go source directory %s includes cgo files that the semantic inventory cannot type-check", directory)
			}
			selectedNames[name] = true
		}
		if len(selectedNames) == 0 {
			return nil, fmt.Errorf("Go source directory %s has no files for build target %s/%s", directory, target.GOOS, target.GOARCH)
		}
		for _, file := range filesByDirectory[directory] {
			if selectedNames[path.Base(file.Path)] {
				selected = append(selected, file)
			}
		}
	}
	sort.Slice(selected, func(i, j int) bool { return selected[i].Path < selected[j].Path })
	return selected, nil
}

func hashProjectInventory(files []projectSourceFile, target goBuildContext) string {
	h := newHash()
	contextBytes, _ := json.Marshal(target)
	_, _ = io.WriteString(h, "go-build-context\x00"+string(contextBytes)+"\n")
	ordered := append([]projectSourceFile(nil), files...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].Path < ordered[j].Path })
	for _, file := range ordered {
		_, _ = io.WriteString(h, file.Path+"\x00"+hashText(file.Text)+"\n")
	}
	return hex.EncodeToString(h.Sum(nil))
}

func projectPackageImportPath(modulePath, moduleRoot, packageDir string) (string, error) {
	if modulePath == "" {
		return "", nil
	}
	moduleRelativeDir := packageDir
	if moduleRoot != "" {
		if packageDir == moduleRoot {
			moduleRelativeDir = "."
		} else if strings.HasPrefix(packageDir, moduleRoot+"/") {
			moduleRelativeDir = strings.TrimPrefix(packageDir, moduleRoot+"/")
		} else {
			return "", fmt.Errorf("Go source directory %s is outside the declared module root", packageDir)
		}
	}
	if moduleRelativeDir == "." {
		return modulePath, nil
	}
	return modulePath + "/" + moduleRelativeDir, nil
}

type goProjectImporter struct {
	packages map[string]request
	catalogs map[string]*projectCatalog
	visiting map[string]bool
	fallback types.Importer
}

func (i *goProjectImporter) Import(importPath string) (*types.Package, error) {
	if _, exists := i.packages[importPath]; exists {
		catalog, err := i.load(importPath)
		if err != nil {
			return nil, err
		}
		return catalog.Package, nil
	}
	return i.fallback.Import(importPath)
}

func (i *goProjectImporter) load(importPath string) (*projectCatalog, error) {
	if catalog := i.catalogs[importPath]; catalog != nil {
		return catalog, nil
	}
	request, exists := i.packages[importPath]
	if !exists {
		return nil, fmt.Errorf("Go project package %s is not in the source snapshot", importPath)
	}
	if i.visiting[importPath] {
		return nil, fmt.Errorf("Go project package import cycle at %s", importPath)
	}
	i.visiting[importPath] = true
	catalog, err := buildProjectCatalogWithImporter(request, i)
	delete(i.visiting, importPath)
	if err != nil {
		return nil, err
	}
	i.catalogs[importPath] = catalog
	return catalog, nil
}

func safeGoModuleImportPath(value string) bool {
	if len(value) == 0 || len(value) > 500 || strings.HasPrefix(value, ".") || strings.HasSuffix(value, ".") {
		return false
	}
	for _, part := range strings.Split(value, "/") {
		if part == "" || part == "." || part == ".." || strings.ContainsAny(part, "\\:@% ") {
			return false
		}
	}
	return true
}

func safeGoModuleRoot(value string) (string, error) {
	if value == "" {
		return "", nil
	}
	clean := path.Clean(value)
	if clean != value || strings.HasPrefix(value, "/") || strings.Contains(value, "\\") ||
		strings.HasPrefix(value, "../") || value == ".." {
		return "", fmt.Errorf("Go module root is invalid")
	}
	for _, part := range strings.Split(value, "/") {
		if part == "" || part == "." || part == ".." {
			return "", fmt.Errorf("Go module root is invalid")
		}
	}
	return value, nil
}

func addProjectInventoryCounts(target *projectInventory, source projectInventory) {
	target.PrivatePackageSymbolCount += source.PrivatePackageSymbolCount
	target.ReferencedPrivatePackageSymbols += source.ReferencedPrivatePackageSymbols
	target.UnreferencedPrivateSymbols += source.UnreferencedPrivateSymbols
	target.ExportedPackageSymbolCount += source.ExportedPackageSymbolCount
	target.UnsupportedPackageSymbolCount += source.UnsupportedPackageSymbolCount
	target.FileScopeSymbolCount += source.FileScopeSymbolCount
	target.ReferencedFileScopeSymbols += source.ReferencedFileScopeSymbols
	target.UnreferencedFileScopeSymbols += source.UnreferencedFileScopeSymbols
	target.UnsupportedFileScopeSymbolCount += source.UnsupportedFileScopeSymbolCount
	target.LocalSymbolCount += source.LocalSymbolCount
	target.ReferencedLocalSymbols += source.ReferencedLocalSymbols
	target.UnreferencedLocalSymbols += source.UnreferencedLocalSymbols
	target.UnsupportedLocalSymbolCount += source.UnsupportedLocalSymbolCount
	target.MemberSymbolCount += source.MemberSymbolCount
	target.UnsupportedMemberSymbolCount += source.UnsupportedMemberSymbolCount
}

func applyProjectRenames(req request) (map[string]any, error) {
	cat, err := buildProjectCatalog(req)
	if err != nil {
		return nil, err
	}
	if len(cat.Files) < 2 {
		return nil, fmt.Errorf("Cross-file Go rename requires at least two source files in the package")
	}
	if len(req.ExpectedHash) != 64 || strings.ToLower(req.ExpectedHash) != cat.SelectedHash || len(req.SourceSetHash) != 64 || strings.ToLower(req.SourceSetHash) != cat.SourceSetHash {
		return nil, fmt.Errorf("Go package source changed after rename suggestions were generated")
	}
	selectedText := ""
	for _, file := range cat.Files {
		if file.Path == cat.SelectedPath {
			selectedText = file.Text
		}
	}
	if req.Source != selectedText {
		return nil, fmt.Errorf("Selected Go source does not match the package snapshot")
	}
	if len(req.Renames) < 1 || len(req.Renames) > maxRenames {
		return nil, fmt.Errorf("Select between 1 and 80 Go bindings to rename")
	}
	byID := make(map[string]binding, len(cat.Bindings))
	for _, item := range cat.Bindings {
		byID[item.ID] = item
	}
	selected := make([]projectRenameChoice, 0, len(req.Renames))
	selectedObjects := make(map[types.Object]bool, len(req.Renames))
	seen := make(map[string]bool)
	for _, choice := range req.Renames {
		item, ok := byID[choice.ID]
		validScope := item.ScopeType == "package" || (item.ScopeType == "member" && item.Kind == "method") || (item.ScopeType == "file" && item.Kind == "file import alias")
		if !ok || !validScope || item.FilePath != cat.SelectedPath || seen[choice.ID] || len(choice.NewName) > 128 || !token.IsIdentifier(choice.NewName) || token.Lookup(choice.NewName).IsKeyword() || choice.NewName == item.Name {
			return nil, fmt.Errorf("A selected Go rename no longer matches a binding in the selected package")
		}
		if types.Universe.Lookup(choice.NewName) != nil {
			return nil, fmt.Errorf("Renaming %s to predeclared Go name %s is not allowed", item.Name, choice.NewName)
		}
		seen[choice.ID] = true
		selectedObjects[item.Object] = true
		selected = append(selected, projectRenameChoice{item: item, newName: choice.NewName, derived: embeddedFieldReferences(cat, item.Object)})
	}
	targets := make(map[string]bool)
	methodTargets := make(map[types.Object]map[string]bool)
	fileAliasTargets := make(map[string]map[string]bool)
	for _, choice := range selected {
		if choice.item.ScopeType == "package" {
			if targets[choice.newName] {
				return nil, fmt.Errorf("Two selected Go bindings cannot share a new package name")
			}
			targets[choice.newName] = true
			if existing := cat.Package.Scope().Lookup(choice.newName); existing != nil && existing != choice.item.Object && !selectedObjects[existing] {
				return nil, fmt.Errorf("Renaming %s to %s would collide with an existing package binding", choice.item.Name, choice.newName)
			}
			for _, ident := range choice.item.Uses {
				if scope := scopeAt(cat.Info.Scopes, ident.Pos()); scope != nil {
					if _, existing := scope.LookupParent(choice.newName, ident.Pos()); existing != nil && existing != choice.item.Object && !selectedObjects[existing] {
						return nil, fmt.Errorf("Renaming %s to %s would capture a Go binding", choice.item.Name, choice.newName)
					}
				}
			}
		} else if choice.item.ScopeType == "file" {
			if fileAliasTargets[choice.item.FilePath] == nil {
				fileAliasTargets[choice.item.FilePath] = make(map[string]bool)
			}
			if fileAliasTargets[choice.item.FilePath][choice.newName] {
				return nil, fmt.Errorf("Two import aliases in the same Go file cannot share a new name")
			}
			fileAliasTargets[choice.item.FilePath][choice.newName] = true
			if existing := choice.item.Object.Parent().Lookup(choice.newName); existing != nil && existing != choice.item.Object && !selectedObjects[existing] {
				return nil, fmt.Errorf("Renaming %s to %s would collide with an import alias in the same file", choice.item.Name, choice.newName)
			}
		} else {
			receiver, ok := receiverNamedObject(choice.item.Object)
			if !ok {
				return nil, fmt.Errorf("The receiver type for method %s could not be resolved", choice.item.Name)
			}
			if methodTargets[receiver] == nil {
				methodTargets[receiver] = make(map[string]bool)
			}
			if methodTargets[receiver][choice.newName] {
				return nil, fmt.Errorf("Two methods on the same receiver cannot share a new name")
			}
			methodTargets[receiver][choice.newName] = true
			if existing := receiverMethodNamed(choice.item.Object, cat.Package, choice.newName); existing != nil && existing != choice.item.Object && !selectedObjects[existing] {
				return nil, fmt.Errorf("Renaming %s to %s would collide with a method on the receiver type", choice.item.Name, choice.newName)
			}
		}
	}
	interfaceContracts := localInterfaceContracts(cat)
	filesByPath := make(map[string]projectSourceFile, len(cat.Files))
	for _, file := range cat.Files {
		filesByPath[file.Path] = file
	}
	editsByPath := make(map[string][]sourceEdit)
	editDetailsByPath := make(map[string][]map[string]any)
	renamed := make([]map[string]any, 0, len(selected))
	for _, choice := range selected {
		for _, ident := range choice.item.Uses {
			position := cat.FileSet.PositionFor(ident.Pos(), false)
			start := position.Offset
			end := cat.FileSet.PositionFor(ident.End(), false).Offset
			editsByPath[position.Filename] = append(editsByPath[position.Filename], sourceEdit{start: start, end: end, text: choice.newName})
			editDetailsByPath[position.Filename] = append(editDetailsByPath[position.Filename], map[string]any{
				"start": start, "end": end, "old_text": ident.Name, "new_text": choice.newName,
			})
		}
		for _, reference := range choice.derived {
			position := cat.FileSet.PositionFor(reference.ident.Pos(), false)
			start := position.Offset
			end := cat.FileSet.PositionFor(reference.ident.End(), false).Offset
			editsByPath[position.Filename] = append(editsByPath[position.Filename], sourceEdit{start: start, end: end, text: choice.newName})
			editDetailsByPath[position.Filename] = append(editDetailsByPath[position.Filename], map[string]any{
				"start": start, "end": end, "old_text": reference.ident.Name, "new_text": choice.newName,
			})
		}
		renamed = append(renamed, map[string]any{
			"bindingId": choice.item.ID, "oldName": choice.item.Name, "newName": choice.newName,
			"kind": choice.item.Kind, "referenceCount": choice.item.ReferenceCount,
			"scopeType": choice.item.ScopeType, "relativePath": choice.item.FilePath,
		})
	}
	outputFiles := make([]projectSourceFile, 0, len(cat.Files))
	manifestFiles := make([]map[string]any, 0, len(editsByPath))
	outputsByPath := make(map[string]string, len(editsByPath))
	for _, file := range cat.Files {
		fileEdits := editsByPath[file.Path]
		if len(fileEdits) == 0 {
			outputFiles = append(outputFiles, file)
			continue
		}
		sort.Slice(fileEdits, func(i, j int) bool { return fileEdits[i].start > fileEdits[j].start })
		output := []byte(file.Text)
		for _, change := range fileEdits {
			output = append(output[:change.start], append([]byte(change.text), output[change.end:]...)...)
		}
		outputText := string(output)
		outputsByPath[file.Path] = outputText
		outputFiles = append(outputFiles, projectSourceFile{Path: file.Path, Text: outputText})
		details := editDetailsByPath[file.Path]
		sort.Slice(details, func(i, j int) bool { return details[i]["start"].(int) < details[j]["start"].(int) })
		manifestFiles = append(manifestFiles, map[string]any{
			"relative_path": file.Path, "input_sha256": hashText(file.Text),
			"output_sha256": hashText(outputText), "source_code": outputText, "edits": details,
		})
	}
	outputReq := request{
		Files: make([]projectFile, 0, len(outputFiles)), SelectedPath: cat.SelectedPath,
		ModulePath: req.ModulePath, ModuleRoot: req.ModuleRoot,
		GoMod: req.GoMod, GoModHash: req.GoModHash, GoSum: req.GoSum, GoSumHash: req.GoSumHash,
		BuildGOOS: req.BuildGOOS, BuildGOARCH: req.BuildGOARCH, BuildCgo: req.BuildCgo,
		BuildTags: append([]string(nil), req.BuildTags...),
	}
	for _, file := range outputFiles {
		outputReq.Files = append(outputReq.Files, projectFile{Path: file.Path, Source: file.Text, ExpectedHash: hashText(file.Text)})
	}
	outputCatalog, err := buildProjectCatalog(outputReq)
	if err != nil {
		return nil, fmt.Errorf("Go package rejected the renamed output: %s", err.Error())
	}
	if !sameLocalInterfaceContracts(interfaceContracts, localInterfaceContracts(outputCatalog), selected) {
		return nil, fmt.Errorf("Go rename would change a local interface implementation contract")
	}
	identifiers := projectIdentifiersByOffset(outputCatalog)
	for _, choice := range selected {
		declarationPosition := cat.FileSet.PositionFor(choice.item.Declaration.Pos(), false)
		declarationOffset := offsetAfterEdits(declarationPosition.Offset, editsByPath[declarationPosition.Filename])
		declaration := identifiers[declarationPosition.Filename][declarationOffset]
		renamedObject := outputCatalog.Info.Defs[declaration]
		if declaration == nil || renamedObject == nil || declaration.Name != choice.newName {
			return nil, fmt.Errorf("Go could not resolve the renamed package declaration for %s", choice.item.Name)
		}
		for _, original := range choice.item.Uses {
			position := cat.FileSet.PositionFor(original.Pos(), false)
			outputOffset := offsetAfterEdits(position.Offset, editsByPath[position.Filename])
			transformed := identifiers[position.Filename][outputOffset]
			var resolved types.Object
			if original == choice.item.Declaration {
				resolved = outputCatalog.Info.Defs[transformed]
			} else {
				resolved = outputCatalog.Info.Uses[transformed]
			}
			if transformed == nil || transformed.Name != choice.newName || resolved != renamedObject {
				return nil, fmt.Errorf("Renaming %s would change a package binding in %s", choice.item.Name, position.Filename)
			}
		}
		for _, original := range choice.derived {
			position := cat.FileSet.PositionFor(original.ident.Pos(), false)
			outputOffset := offsetAfterEdits(position.Offset, editsByPath[position.Filename])
			transformed := identifiers[position.Filename][outputOffset]
			field, ok := outputCatalog.Info.Uses[transformed].(*types.Var)
			if transformed == nil || transformed.Name != choice.newName || !ok || !field.Embedded() || field.Name() != choice.newName || !embeddedFieldTypeMatches(field.Type(), renamedObject.Type()) {
				return nil, fmt.Errorf("Renaming %s would change an embedded field binding in %s", choice.item.Name, position.Filename)
			}
		}
	}
	selectedOutput := outputsByPath[cat.SelectedPath]
	outputManifest := map[string]any{
		"version": 1, "source_set_sha256": cat.SourceSetHash,
		"output_source_set_sha256": outputCatalog.SourceSetHash, "files": manifestFiles,
	}
	return map[string]any{
		"source_sha256": cat.SelectedHash, "source_set_sha256": cat.SourceSetHash,
		"output_source_set_sha256": outputCatalog.SourceSetHash,
		"output_sha256":            hashText(selectedOutput), "source_code": selectedOutput,
		"files": manifestFiles, "edit_manifest": outputManifest,
		"renamed_bindings": renamed, "parser_version": runtime.Version(), "scope": "project",
	}, nil
}

func receiverNamedObject(object types.Object) (*types.TypeName, bool) {
	method, ok := object.(*types.Func)
	if !ok || method.Signature().Recv() == nil {
		return nil, false
	}
	receiver := types.Unalias(method.Signature().Recv().Type())
	if pointer, ok := receiver.(*types.Pointer); ok {
		receiver = types.Unalias(pointer.Elem())
	}
	named, ok := receiver.(*types.Named)
	if !ok {
		return nil, false
	}
	return named.Obj(), true
}

func receiverMethodNamed(object types.Object, pkg *types.Package, name string) types.Object {
	method, ok := object.(*types.Func)
	if !ok || method.Signature().Recv() == nil {
		return nil
	}
	receiver := types.Unalias(method.Signature().Recv().Type())
	if pointer, ok := receiver.(*types.Pointer); ok {
		receiver = types.Unalias(pointer.Elem())
	}
	if _, ok := receiver.(*types.Named); !ok {
		return nil
	}
	selection := types.NewMethodSet(types.NewPointer(receiver)).Lookup(pkg, name)
	if selection == nil {
		return nil
	}
	return selection.Obj()
}

func localInterfaceContracts(cat *projectCatalog) map[string]bool {
	typesByName := make(map[string]*types.Named)
	interfacesByName := make(map[string]*types.Interface)
	for _, name := range cat.Package.Scope().Names() {
		object, ok := cat.Package.Scope().Lookup(name).(*types.TypeName)
		if !ok || object.IsAlias() {
			continue
		}
		named, ok := types.Unalias(object.Type()).(*types.Named)
		if !ok {
			continue
		}
		if iface, ok := named.Underlying().(*types.Interface); ok {
			interfacesByName[name] = iface.Complete()
		} else {
			typesByName[name] = named
		}
	}
	contracts := make(map[string]bool)
	for typeName, named := range typesByName {
		for interfaceName, iface := range interfacesByName {
			if types.Implements(named, iface) {
				contracts[fmt.Sprintf("value\x00%s\x00%s", typeName, interfaceName)] = true
			}
			if types.Implements(types.NewPointer(named), iface) {
				contracts[fmt.Sprintf("pointer\x00%s\x00%s", typeName, interfaceName)] = true
			}
		}
	}
	return contracts
}

func sameLocalInterfaceContracts(before, after map[string]bool, selected []projectRenameChoice) bool {
	expected := make(map[string]bool, len(before))
	for contract := range before {
		parts := strings.Split(contract, "\x00")
		if len(parts) != 3 {
			return false
		}
		for _, choice := range selected {
			if choice.item.ScopeType != "package" || choice.item.Kind != "package type" {
				continue
			}
			if parts[1] == choice.item.Name {
				parts[1] = choice.newName
			}
			if parts[2] == choice.item.Name {
				parts[2] = choice.newName
			}
		}
		expected[strings.Join(parts, "\x00")] = true
	}
	if len(expected) != len(after) {
		return false
	}
	for contract := range after {
		if !expected[contract] {
			return false
		}
	}
	return true
}

func embeddedFieldReferences(cat *projectCatalog, target types.Object) []derivedFieldReference {
	var references []derivedFieldReference
	seen := make(map[*ast.Ident]bool)
	for _, file := range cat.Files {
		ast.Inspect(file.AST, func(node ast.Node) bool {
			typeSpec, ok := node.(*ast.TypeSpec)
			if !ok {
				return true
			}
			structure, ok := typeSpec.Type.(*ast.StructType)
			if !ok {
				return true
			}
			typeObject, ok := cat.Info.Defs[typeSpec.Name].(*types.TypeName)
			if !ok {
				return true
			}
			structType, ok := types.Unalias(typeObject.Type()).Underlying().(*types.Struct)
			if !ok {
				return true
			}
			fieldIndex := 0
			for _, astField := range structure.Fields.List {
				fieldCount := len(astField.Names)
				if fieldCount == 0 {
					fieldCount = 1
					ident := embeddedTypeIdentifier(astField.Type)
					if ident != nil && cat.Info.Uses[ident] == target && fieldIndex < structType.NumFields() {
						field := structType.Field(fieldIndex)
						if field.Embedded() && field.Name() == ident.Name {
							for use, object := range cat.Info.Uses {
								if object == field && !seen[use] {
									seen[use] = true
									references = append(references, derivedFieldReference{ident: use})
								}
							}
						}
					}
				}
				fieldIndex += fieldCount
			}
			return true
		})
	}
	return references
}

func embeddedTypeIdentifier(expr ast.Expr) *ast.Ident {
	switch value := expr.(type) {
	case *ast.Ident:
		return value
	case *ast.StarExpr:
		return embeddedTypeIdentifier(value.X)
	case *ast.IndexExpr:
		return embeddedTypeIdentifier(value.X)
	case *ast.IndexListExpr:
		return embeddedTypeIdentifier(value.X)
	case *ast.ParenExpr:
		return embeddedTypeIdentifier(value.X)
	default:
		return nil
	}
}

func embeddedFieldTypeMatches(fieldType, renamedType types.Type) bool {
	fieldType = types.Unalias(fieldType)
	if pointer, ok := fieldType.(*types.Pointer); ok {
		fieldType = types.Unalias(pointer.Elem())
	}
	if field, ok := fieldType.(*types.Named); ok {
		if renamed, ok := types.Unalias(renamedType).(*types.Named); ok && field.Obj() == renamed.Obj() {
			return true
		}
	}
	return types.Identical(fieldType, types.Unalias(renamedType))
}

func projectIdentifiersByOffset(cat *projectCatalog) map[string]map[int]*ast.Ident {
	identifiers := make(map[string]map[int]*ast.Ident, len(cat.Files))
	for _, file := range cat.Files {
		byOffset := make(map[int]*ast.Ident)
		ast.Inspect(file.AST, func(node ast.Node) bool {
			ident, ok := node.(*ast.Ident)
			if !ok {
				return true
			}
			position := cat.FileSet.PositionFor(ident.Pos(), false)
			byOffset[position.Offset] = ident
			return true
		})
		identifiers[file.Path] = byOffset
	}
	return identifiers
}

func offsetAfterEdits(offset int, edits []sourceEdit) int {
	shift := 0
	for _, change := range edits {
		if change.end <= offset {
			shift += len(change.text) - (change.end - change.start)
		}
	}
	return offset + shift
}

func identifiersByOffset(cat *catalog) map[int]*ast.Ident {
	identifiers := make(map[int]*ast.Ident, len(cat.Info.Defs)+len(cat.Info.Uses))
	ast.Inspect(cat.File, func(node ast.Node) bool {
		ident, ok := node.(*ast.Ident)
		if !ok {
			return true
		}
		if file := cat.FileSet.File(ident.Pos()); file != nil {
			identifiers[file.Offset(ident.Pos())] = ident
		}
		return true
	})
	return identifiers
}

func scopeAt(scopes map[ast.Node]*types.Scope, position token.Pos) *types.Scope {
	var best *types.Scope
	bestWidth := int64(^uint64(0) >> 1)
	for node, scope := range scopes {
		if node.Pos() > position || position > node.End() || scope == nil || scope.Pos() > position || position > scope.End() {
			continue
		}
		width := int64(scope.End() - scope.Pos())
		if width < bestWidth {
			best, bestWidth = scope, width
		}
	}
	return best
}
