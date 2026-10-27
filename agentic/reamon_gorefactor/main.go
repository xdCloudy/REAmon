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
	"runtime"
	"sort"
	"strings"
)

const maxSourceBytes = 512 * 1024
const maxBindings = 5000
const maxRenames = 80

type request struct {
	Operation    string            `json:"operation"`
	Source       string            `json:"source_code"`
	ExpectedHash string            `json:"expected_sha256"`
	Renames      []renameSelection `json:"renames"`
}

type renameSelection struct {
	ID      string `json:"binding_id"`
	NewName string `json:"new_name"`
}

type binding struct {
	ID               string       `json:"id"`
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

type sourceEdit struct {
	start, end int
	text       string
}

func main() {
	input, err := io.ReadAll(io.LimitReader(os.Stdin, maxSourceBytes*3+2*1024*1024))
	if err != nil {
		writeError("Could not read request", 400)
		return
	}
	var req request
	if err := json.Unmarshal(input, &req); err != nil {
		writeError("Invalid Go refactor request", 400)
		return
	}
	if len([]byte(req.Source)) > maxSourceBytes {
		writeError("Go source exceeds the 512 KiB safe-rename limit", 413)
		return
	}
	var result any
	switch req.Operation {
	case "bindings":
		result, err = listBindings(req.Source)
	case "rename":
		result, err = applyRenames(req)
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
