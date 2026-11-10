// Command reamon-gorefactor provides conservative, single-file Go binding
// catalogs and hash-bound renames for REAmon's source-maintenance workflow.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/importer"
	"go/parser"
	"go/token"
	"go/types"
	"hash"
	"io"
	"os"
	"path"
	"runtime"
	"sort"
	"strings"
)

const maxSourceBytes = 512 * 1024
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
	Hash          string
	SourceSetHash string
	SelectedPath  string
	SelectedHash  string
	Inventory     projectInventory
	FileSet       *token.FileSet
	Files         []projectSourceFile
	Info          *types.Info
	Package       *types.Package
	Bindings      []binding
	Truncated     bool
}

type projectInventory struct {
	SourceFileCount                 int
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
	if len([]byte(req.Source)) > maxSourceBytes && req.Operation != "project_bindings" && req.Operation != "project_rename" {
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
	case "project_rename":
		result, err = applyProjectRenames(req)
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
	if len(req.Files) < 2 || len(req.Files) > maxProjectFiles {
		return nil, fmt.Errorf("Go package rename requires between 2 and %d source files", maxProjectFiles)
	}
	selectedPath, err := safeGoPath(req.SelectedPath)
	if err != nil {
		return nil, err
	}
	packageDir := path.Dir(selectedPath)
	files := append([]projectFile(nil), req.Files...)
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
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
		if sourceBytes > maxSourceBytes {
			return nil, fmt.Errorf("%s exceeds the 512 KiB safe-rename limit", filePath)
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
		for _, commentGroup := range astFile.Comments {
			for _, comment := range commentGroup.List {
				if strings.HasPrefix(comment.Text, "//go:build") || strings.HasPrefix(comment.Text, "// +build") {
					return nil, fmt.Errorf("Go package rename does not support build-constrained source files")
				}
			}
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
	conf := types.Config{Importer: importer.Default(), Error: func(err error) { typeErrors = append(typeErrors, err) }}
	pkg, _ := conf.Check(packageName, fileSet, astFiles, info)
	if len(typeErrors) > 0 || pkg == nil {
		return nil, fmt.Errorf("Go package has unresolved type or reference errors; cross-file rename requires a complete package type-check")
	}
	projectHash := hashProjectSources(parsed)
	cat := &projectCatalog{
		Hash: selectedHash, SourceSetHash: projectHash, SelectedPath: selectedPath,
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
				ID: shortID(projectHash+"\x00"+file.Path, offset, object.Name()),
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
			if object == nil || object.Parent() == pkg.Scope() {
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
			clause, ok := node.(*ast.CaseClause)
			if !ok {
				return true
			}
			object := info.Implicits[clause]
			if object == nil || object.Parent() == pkg.Scope() {
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
			ID: shortID(projectHash+"\x00"+filePath, position.Offset, declaration.Name),
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
	if value == "" || strings.Contains(value, "\\") || path.IsAbs(value) {
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
		"selected_path": cat.SelectedPath, "files": files,
		"bindings": bindings, "truncated": cat.Truncated, "parser_version": runtime.Version(),
		"inventory": map[string]any{
			"scope":                              "reviewed-same-directory-go-package-source-snapshot",
			"source_file_count":                  cat.Inventory.SourceFileCount,
			"private_package_symbol_count":       cat.Inventory.PrivatePackageSymbolCount,
			"referenced_private_package_symbols": cat.Inventory.ReferencedPrivatePackageSymbols,
			"unreferenced_private_symbols":       cat.Inventory.UnreferencedPrivateSymbols,
			"exported_package_symbol_count":      cat.Inventory.ExportedPackageSymbolCount,
			"unsupported_package_symbol_count":   cat.Inventory.UnsupportedPackageSymbolCount,
			"file_scope_symbol_count":            cat.Inventory.FileScopeSymbolCount,
			"referenced_file_scope_symbols":      cat.Inventory.ReferencedFileScopeSymbols,
			"unreferenced_file_scope_symbols":    cat.Inventory.UnreferencedFileScopeSymbols,
			"unsupported_file_scope_symbol_count": cat.Inventory.UnsupportedFileScopeSymbolCount,
			"local_symbol_count":                cat.Inventory.LocalSymbolCount,
			"referenced_local_symbols":           cat.Inventory.ReferencedLocalSymbols,
			"unreferenced_local_symbols":         cat.Inventory.UnreferencedLocalSymbols,
			"unsupported_local_symbol_count":     cat.Inventory.UnsupportedLocalSymbolCount,
			"rename_binding_catalog_truncated":   cat.Truncated,
			"entry_count":                        cat.Inventory.EntryCount,
			"entries_truncated":                  cat.Inventory.EntriesTruncated,
			"entries":                            cat.Inventory.Entries,
		},
	}, nil
}

func applyProjectRenames(req request) (map[string]any, error) {
	cat, err := buildProjectCatalog(req)
	if err != nil {
		return nil, err
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
	selected := make([]struct {
		item    binding
		newName string
		derived []derivedFieldReference
	}, 0, len(req.Renames))
	selectedObjects := make(map[types.Object]bool, len(req.Renames))
	seen := make(map[string]bool)
	for _, choice := range req.Renames {
		item, ok := byID[choice.ID]
		if !ok || item.FilePath != cat.SelectedPath || seen[choice.ID] || len(choice.NewName) > 128 || !token.IsIdentifier(choice.NewName) || token.Lookup(choice.NewName).IsKeyword() || choice.NewName == item.Name {
			return nil, fmt.Errorf("A selected Go rename no longer matches a package binding in the selected source")
		}
		if types.Universe.Lookup(choice.NewName) != nil {
			return nil, fmt.Errorf("Renaming %s to predeclared Go name %s is not allowed", item.Name, choice.NewName)
		}
		seen[choice.ID] = true
		selectedObjects[item.Object] = true
		selected = append(selected, struct {
			item    binding
			newName string
			derived []derivedFieldReference
		}{item, choice.NewName, embeddedFieldReferences(cat, item.Object)})
	}
	targets := make(map[string]bool)
	for _, choice := range selected {
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
	}
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
	outputReq := request{Files: make([]projectFile, 0, len(outputFiles)), SelectedPath: cat.SelectedPath}
	for _, file := range outputFiles {
		outputReq.Files = append(outputReq.Files, projectFile{Path: file.Path, Source: file.Text, ExpectedHash: hashText(file.Text)})
	}
	outputCatalog, err := buildProjectCatalog(outputReq)
	if err != nil {
		return nil, fmt.Errorf("Go package rejected the renamed output: %s", err.Error())
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
