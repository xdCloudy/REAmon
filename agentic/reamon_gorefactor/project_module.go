package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"go/types"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
)

type projectModuleCatalog struct {
	ModulePath         string
	SelectedPath       string
	SelectedHash       string
	SourceSetHash      string
	InventoryScopeHash string
	Files              []projectSourceFile
	SelectedFiles      []projectSourceFile
	Catalogs           []*projectCatalog
	CatalogByFile      map[string]*projectCatalog
	IdentifierCatalog  map[*ast.Ident]*projectCatalog
	Bindings           []binding
	BindingByID        map[string]binding
	Importer           *goProjectImporter
}

func buildProjectModuleCatalog(req request) (*projectModuleCatalog, error) {
	if len(req.Files) < 1 || len(req.Files) > maxProjectFiles {
		return nil, fmt.Errorf("Go module snapshot requires between 1 and %d source files", maxProjectFiles)
	}
	if req.ModulePath == "" || !safeGoModuleImportPath(req.ModulePath) {
		return nil, fmt.Errorf("Go module snapshot requires a valid module path")
	}
	if req.ModuleRoot != "" {
		moduleRoot, err := safeGoModuleRoot(req.ModuleRoot)
		if err != nil || moduleRoot != req.ModuleRoot {
			return nil, fmt.Errorf("Go module root is invalid")
		}
	}
	selectedPath, err := safeGoPath(req.SelectedPath)
	if err != nil {
		return nil, err
	}
	buildContext, err := normalizeGoBuildContext(req)
	if err != nil {
		return nil, err
	}

	files := append([]projectFile(nil), req.Files...)
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	allFiles := make([]projectSourceFile, 0, len(files))
	seenPaths := make(map[string]bool, len(files))
	totalBytes := 0
	selectedHash := ""
	for _, file := range files {
		filePath, pathErr := safeGoPath(file.Path)
		if pathErr != nil || filePath != file.Path {
			return nil, fmt.Errorf("Go module snapshot requires normalized source paths")
		}
		pathKey := strings.ToLower(filePath)
		if seenPaths[pathKey] {
			return nil, fmt.Errorf("Go module source paths collide: %s", filePath)
		}
		seenPaths[pathKey] = true
		totalBytes += len([]byte(file.Source))
		if totalBytes > maxProjectBytes {
			return nil, fmt.Errorf("Go module source exceeds the 8 MiB safe-rename limit")
		}
		fileHash := hashText(file.Source)
		if file.ExpectedHash != "" && !strings.EqualFold(file.ExpectedHash, fileHash) {
			return nil, fmt.Errorf("Go module source changed for %s", file.Path)
		}
		allFiles = append(allFiles, projectSourceFile{Path: file.Path, Text: file.Source})
		if file.Path == selectedPath {
			if req.Source != file.Source {
				return nil, fmt.Errorf("Selected Go source does not match the module snapshot")
			}
			selectedHash = fileHash
		}
	}
	if selectedHash == "" {
		return nil, fmt.Errorf("Selected Go source is missing from the module snapshot")
	}
	selectedInput, err := selectGoBuildFiles(files, buildContext)
	if err != nil {
		return nil, err
	}
	selectedFiles := make([]projectSourceFile, 0, len(selectedInput))
	groups := make(map[string][]projectFile)
	selectedForBuild := false
	for _, file := range selectedInput {
		fileSet := token.NewFileSet()
		parsed, parseErr := parser.ParseFile(fileSet, file.Path, file.Source, parser.AllErrors|parser.ParseComments)
		if parseErr != nil {
			return nil, fmt.Errorf("Go parser rejected %s: %s", file.Path, parseErr.Error())
		}
		key := path.Dir(file.Path) + "\x00" + parsed.Name.Name
		groups[key] = append(groups[key], file)
		selectedFiles = append(selectedFiles, projectSourceFile{Path: file.Path, Text: file.Source})
		if file.Path == selectedPath {
			selectedForBuild = true
		}
	}
	if !selectedForBuild {
		return nil, fmt.Errorf("Selected Go source is excluded by the module build context")
	}

	groupKeys := make([]string, 0, len(groups))
	for key := range groups {
		groupKeys = append(groupKeys, key)
	}
	sort.Strings(groupKeys)
	packageRequests := make(map[string]request, len(groups))
	for _, key := range groupKeys {
		group := groups[key]
		importPath, pathErr := projectPackageImportPath(req.ModulePath, req.ModuleRoot, path.Dir(group[0].Path))
		if pathErr != nil {
			return nil, pathErr
		}
		if previous, exists := packageRequests[importPath]; exists {
			return nil, fmt.Errorf("Go module package path %s is ambiguous between %s and %s", importPath, previous.SelectedPath, group[0].Path)
		}
		packageRequests[importPath] = request{
			SelectedPath: group[0].Path, Source: group[0].Source, Files: group, PackagePath: importPath,
			BuildGOOS: buildContext.GOOS, BuildGOARCH: buildContext.GOARCH,
			BuildCgo: &buildContext.CgoEnabled, BuildTags: append([]string(nil), buildContext.Tags...),
			ModulePath: req.ModulePath, ModuleRoot: req.ModuleRoot,
			GoMod: req.GoMod, GoModHash: req.GoModHash, GoSum: req.GoSum, GoSumHash: req.GoSumHash,
		}
	}
	importPaths := make([]string, 0, len(packageRequests))
	for importPath := range packageRequests {
		importPaths = append(importPaths, importPath)
	}
	sort.Strings(importPaths)
	moduleImporter := &goProjectImporter{
		packages: packageRequests, catalogs: make(map[string]*projectCatalog),
		visiting: make(map[string]bool), fallback: newGoTargetImporter(buildContext),
	}
	catalogs := make([]*projectCatalog, 0, len(importPaths))
	catalogByFile := make(map[string]*projectCatalog)
	for _, importPath := range importPaths {
		catalog, loadErr := moduleImporter.load(importPath)
		if loadErr != nil {
			if closeable, ok := moduleImporter.fallback.(interface{ Close() error }); ok {
				_ = closeable.Close()
			}
			return nil, fmt.Errorf("cannot type-check Go module package %s: %s", importPath, loadErr.Error())
		}
		catalogs = append(catalogs, catalog)
		for _, source := range catalog.Files {
			catalogByFile[source.Path] = catalog
		}
	}
	return &projectModuleCatalog{
		ModulePath:   req.ModulePath,
		SelectedPath: selectedPath, SelectedHash: selectedHash,
		SourceSetHash:      hashProjectSources(allFiles),
		InventoryScopeHash: hashProjectInventory(selectedFiles, buildContext),
		Files:              allFiles, SelectedFiles: selectedFiles, Catalogs: catalogs,
		CatalogByFile: catalogByFile, IdentifierCatalog: make(map[*ast.Ident]*projectCatalog),
		BindingByID: make(map[string]binding),
		Importer:    moduleImporter,
	}, nil
}

func (catalog *projectModuleCatalog) close() {
	if catalog == nil || catalog.Importer == nil {
		return
	}
	if closeable, ok := catalog.Importer.fallback.(interface{ Close() error }); ok {
		_ = closeable.Close()
	}
}

func (catalog *projectModuleCatalog) collectMethodBindings() {
	methods := make(map[types.Object]binding)
	for _, packageCatalog := range catalog.Catalogs {
		for identifier := range packageCatalog.Info.Defs {
			catalog.IdentifierCatalog[identifier] = packageCatalog
		}
		for identifier := range packageCatalog.Info.Uses {
			catalog.IdentifierCatalog[identifier] = packageCatalog
		}
		for identifier, object := range packageCatalog.Info.Defs {
			method, ok := object.(*types.Func)
			if ok && method.Signature().Recv() != nil && method.Pkg() == packageCatalog.Package {
				position := packageCatalog.FileSet.PositionFor(identifier.Pos(), false)
				if position.Filename == catalog.SelectedPath {
					methods[method] = binding{
						FilePath: position.Filename, Name: identifier.Name, Kind: "method", ScopeType: "member",
						DeclarationStart: position.Offset, Exported: token.IsExported(identifier.Name),
						Object: method, Scope: packageCatalog.Package.Scope(), Declaration: identifier,
					}
				}
				continue
			}
			alias, ok := object.(*types.PkgName)
			if !ok || alias.Name() == "_" || alias.Name() == "." {
				continue
			}
			position := packageCatalog.FileSet.PositionFor(identifier.Pos(), false)
			uses := []*ast.Ident{identifier}
			for use, used := range packageCatalog.Info.Uses {
				if used == alias {
					uses = append(uses, use)
				}
			}
			if len(uses) <= 1 {
				continue
			}
			sort.Slice(uses[1:], func(i, j int) bool {
				return packageCatalog.FileSet.PositionFor(uses[i+1].Pos(), false).Offset < packageCatalog.FileSet.PositionFor(uses[j+1].Pos(), false).Offset
			})
			item := binding{
				ID:       shortID(catalog.InventoryScopeHash+"\x00"+position.Filename, position.Offset, identifier.Name),
				FilePath: position.Filename, Name: identifier.Name, Kind: "file import alias", ScopeType: "file",
				DeclarationStart: position.Offset, ReferenceCount: len(uses) - 1,
				Object: alias, Scope: alias.Parent(), Declaration: identifier, Uses: uses,
			}
			catalog.BindingByID[item.ID] = item
			catalog.Bindings = append(catalog.Bindings, item)
		}
	}
	for method, item := range methods {
		item.Uses = append(item.Uses, item.Declaration)
		for _, packageCatalog := range catalog.Catalogs {
			for identifier, used := range packageCatalog.Info.Uses {
				if used == method {
					item.Uses = append(item.Uses, identifier)
				}
			}
		}
		if len(item.Uses) < 2 {
			continue
		}
		sort.Slice(item.Uses[1:], func(i, j int) bool {
			leftCatalog := catalog.IdentifierCatalog[item.Uses[i+1]]
			rightCatalog := catalog.IdentifierCatalog[item.Uses[j+1]]
			left := leftCatalog.FileSet.PositionFor(item.Uses[i+1].Pos(), false)
			right := rightCatalog.FileSet.PositionFor(item.Uses[j+1].Pos(), false)
			if left.Filename != right.Filename {
				return left.Filename < right.Filename
			}
			return left.Offset < right.Offset
		})
		item.ReferenceCount = len(item.Uses) - 1
		item.ID = shortID(catalog.InventoryScopeHash+"\x00"+item.FilePath, item.DeclarationStart, item.Name)
		catalog.BindingByID[item.ID] = item
		catalog.Bindings = append(catalog.Bindings, item)
	}
	sort.Slice(catalog.Bindings, func(i, j int) bool {
		if catalog.Bindings[i].FilePath != catalog.Bindings[j].FilePath {
			return catalog.Bindings[i].FilePath < catalog.Bindings[j].FilePath
		}
		return catalog.Bindings[i].DeclarationStart < catalog.Bindings[j].DeclarationStart
	})
}

func listProjectModuleBindings(req request) (map[string]any, error) {
	catalog, err := buildProjectModuleCatalog(req)
	if err != nil {
		return nil, err
	}
	defer catalog.close()
	catalog.collectMethodBindings()
	bindings := make([]map[string]any, 0, len(catalog.Bindings))
	for _, item := range catalog.Bindings {
		row := map[string]any{
			"id": item.ID, "name": item.Name, "kind": item.Kind, "scopeType": item.ScopeType,
			"relativePath": item.FilePath, "declarationStart": item.DeclarationStart,
			"referenceCount": item.ReferenceCount, "exported": item.Exported,
		}
		if alias, ok := item.Object.(*types.PkgName); ok {
			row["importPath"] = alias.Imported().Path()
		}
		bindings = append(bindings, row)
	}
	files := make([]map[string]any, 0, len(catalog.Files))
	for _, file := range catalog.Files {
		files = append(files, map[string]any{"relative_path": file.Path, "source_sha256": hashText(file.Text)})
	}
	return map[string]any{
		"scope": "verified-go-module-source-snapshot", "selected_path": catalog.SelectedPath,
		"source_sha256": catalog.SelectedHash, "source_set_sha256": catalog.SourceSetHash,
		"inventory_scope_sha256": catalog.InventoryScopeHash,
		"truncated":              false, "bindings": bindings, "files": files,
		"parser_version": runtime.Version(),
	}, nil
}

func downstreamFallbackManifest(goMod, consumerModulePath, importedModulePath string, build goBuildContext) (string, error) {
	root, err := os.MkdirTemp("", "reamon-go-downstream-mod-")
	if err != nil {
		return "", fmt.Errorf("cannot prepare downstream Go dependency manifest")
	}
	defer os.RemoveAll(root)
	manifestPath := filepath.Join(root, "go.mod")
	if err := os.WriteFile(manifestPath, []byte(goMod), 0600); err != nil {
		return "", fmt.Errorf("cannot stage downstream Go dependency manifest")
	}
	inspect := exec.Command("go", "mod", "edit", "-json")
	inspect.Dir = root
	inspect.Env = goBuildCommandEnvironment(build)
	manifestJSON, err := inspect.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("cannot inspect downstream Go dependency manifest: %s", strings.TrimSpace(string(manifestJSON)))
	}
	var metadata struct {
		Module  struct{ Path string }
		Require []struct{ Path string }
	}
	if err := json.Unmarshal(manifestJSON, &metadata); err != nil || metadata.Module.Path != consumerModulePath {
		return "", fmt.Errorf("downstream Go module path does not match its verified go.mod")
	}
	declaresImportedModule := false
	for _, requirement := range metadata.Require {
		if requirement.Path == importedModulePath {
			declaresImportedModule = true
			break
		}
	}
	if !declaresImportedModule {
		return "", fmt.Errorf("downstream Go module does not declare a dependency on %s", importedModulePath)
	}
	command := exec.Command("go", "mod", "edit", "-droprequire="+importedModulePath, "-dropreplace="+importedModulePath)
	command.Dir = root
	command.Env = goBuildCommandEnvironment(build)
	if output, err := command.CombinedOutput(); err != nil {
		return "", fmt.Errorf("cannot prepare downstream Go dependency lookup: %s", strings.TrimSpace(string(output)))
	}
	contents, err := os.ReadFile(manifestPath)
	if err != nil {
		return "", fmt.Errorf("cannot read downstream Go dependency manifest")
	}
	return string(contents), nil
}

func receiverSyntaxName(expression ast.Expr) string {
	switch receiver := expression.(type) {
	case *ast.Ident:
		return receiver.Name
	case *ast.StarExpr:
		return receiverSyntaxName(receiver.X)
	case *ast.IndexExpr:
		return receiverSyntaxName(receiver.X)
	case *ast.IndexListExpr:
		return receiverSyntaxName(receiver.X)
	case *ast.ParenExpr:
		return receiverSyntaxName(receiver.X)
	default:
		return ""
	}
}

func unselectedMethodVariant(catalog *projectModuleCatalog, method *types.Func) (string, error) {
	receiver, ok := receiverNamedObject(method)
	if !ok {
		return "", fmt.Errorf("the receiver type for method %s could not be resolved", method.Name())
	}
	selectedDir := ""
	for filePath, packageCatalog := range catalog.CatalogByFile {
		if packageCatalog.Package == method.Pkg() {
			selectedDir = path.Dir(filePath)
			break
		}
	}
	if selectedDir == "" {
		return "", fmt.Errorf("the source package for method %s could not be resolved", method.Name())
	}
	for _, file := range catalog.Files {
		if path.Dir(file.Path) != selectedDir || catalog.CatalogByFile[file.Path] != nil {
			continue
		}
		fileSet := token.NewFileSet()
		parsed, err := parser.ParseFile(fileSet, file.Path, file.Text, parser.AllErrors|parser.ParseComments)
		if err != nil {
			return "", fmt.Errorf("cannot inspect inactive Go source %s for platform-specific method variants", file.Path)
		}
		if parsed.Name.Name != method.Pkg().Name() {
			continue
		}
		for _, declaration := range parsed.Decls {
			function, ok := declaration.(*ast.FuncDecl)
			if !ok || function.Recv == nil || function.Name.Name != method.Name() {
				continue
			}
			for _, field := range function.Recv.List {
				if receiverSyntaxName(field.Type) == receiver.Name() {
					return file.Path, nil
				}
			}
		}
	}
	return "", nil
}

func projectValidationBuildContexts(current goBuildContext) []goBuildContext {
	contexts := []goBuildContext{current}
	for _, target := range [][2]string{{"linux", "amd64"}, {"windows", "amd64"}, {"linux", "arm64"}, {"windows", "arm64"}, {"js", "wasm"}} {
		context := current
		context.GOOS, context.GOARCH = target[0], target[1]
		if context.GOOS == current.GOOS && context.GOARCH == current.GOARCH {
			continue
		}
		duplicate := false
		for _, existing := range contexts {
			if existing.GOOS == context.GOOS && existing.GOARCH == context.GOARCH && existing.CgoEnabled == context.CgoEnabled && strings.Join(existing.Tags, "\x00") == strings.Join(context.Tags, "\x00") {
				duplicate = true
				break
			}
		}
		if !duplicate {
			contexts = append(contexts, context)
		}
	}
	return contexts
}

func unselectedMethodReference(req request, catalog *projectModuleCatalog, method *types.Func) (string, error) {
	targetReceiver, ok := receiverNamedObject(method)
	if !ok {
		return "", fmt.Errorf("the receiver type for method %s could not be resolved", method.Name())
	}
	candidates := make(map[string]bool)
	for _, file := range catalog.Files {
		if catalog.CatalogByFile[file.Path] != nil {
			continue
		}
		fileSet := token.NewFileSet()
		parsed, err := parser.ParseFile(fileSet, file.Path, file.Text, parser.AllErrors|parser.ParseComments)
		if err != nil {
			return "", fmt.Errorf("cannot inspect inactive Go source %s for method references", file.Path)
		}
		ast.Inspect(parsed, func(node ast.Node) bool {
			selector, ok := node.(*ast.SelectorExpr)
			if ok && selector.Sel.Name == method.Name() {
				candidates[file.Path] = true
			}
			return true
		})
	}
	if len(candidates) == 0 {
		return "", nil
	}
	current, err := normalizeGoBuildContext(req)
	if err != nil {
		return "", err
	}
	targets := projectValidationBuildContexts(current)
	currentPaths := make(map[string]bool, len(catalog.CatalogByFile))
	for filePath := range catalog.CatalogByFile {
		currentPaths[filePath] = true
	}
	for _, target := range targets[1:] {
		selected, selectErr := selectGoBuildFiles(req.Files, target)
		if selectErr != nil {
			continue
		}
		selectedPaths := make(map[string]bool, len(selected))
		for _, file := range selected {
			selectedPaths[file.Path] = true
		}
		if !selectedPaths[catalog.SelectedPath] {
			continue
		}
		candidateSelected := false
		for filePath := range candidates {
			if selectedPaths[filePath] && !currentPaths[filePath] {
				candidateSelected = true
				break
			}
		}
		if !candidateSelected {
			continue
		}
		alternateRequest := req
		alternateRequest.BuildGOOS, alternateRequest.BuildGOARCH = target.GOOS, target.GOARCH
		alternate, buildErr := buildProjectModuleCatalog(alternateRequest)
		if buildErr != nil {
			return "", fmt.Errorf("cannot type-check inactive Go source under %s/%s: %s", target.GOOS, target.GOARCH, buildErr.Error())
		}
		alternate.collectMethodBindings()
		for _, binding := range alternate.Bindings {
			candidate, ok := binding.Object.(*types.Func)
			if !ok || binding.Kind != "method" || candidate.Name() != method.Name() || candidate.Pkg().Path() != method.Pkg().Path() {
				continue
			}
			receiver, ok := receiverNamedObject(candidate)
			if !ok || receiver.Name() != targetReceiver.Name() {
				continue
			}
			for _, identifier := range binding.Uses {
				packageCatalog := alternate.IdentifierCatalog[identifier]
				if packageCatalog == nil {
					continue
				}
				position := packageCatalog.FileSet.PositionFor(identifier.Pos(), false)
				if candidates[position.Filename] && !currentPaths[position.Filename] {
					alternate.close()
					return position.Filename, nil
				}
			}
		}
		alternate.close()
	}
	return "", nil
}

func downstreamModuleImportsTarget(downstream downstreamModuleSnapshot, importedModulePath string, build goBuildContext) (bool, error) {
	selected, err := selectDownstreamBuildFiles(downstream.Files, build)
	if err != nil {
		return false, err
	}
	for _, file := range selected {
		parsed, parseErr := parser.ParseFile(token.NewFileSet(), file.Path, file.Source, parser.AllErrors|parser.ParseComments)
		if parseErr != nil {
			return false, fmt.Errorf("downstream Go parser rejected %s: %s", file.Path, parseErr.Error())
		}
		for _, spec := range parsed.Imports {
			importPath, unquoteErr := strconv.Unquote(spec.Path.Value)
			if unquoteErr == nil && (importPath == importedModulePath || strings.HasPrefix(importPath, importedModulePath+"/")) {
				return true, nil
			}
		}
	}
	return false, nil
}

func selectDownstreamBuildFiles(files []projectFile, build goBuildContext) ([]projectFile, error) {
	groups := make(map[string][]projectFile)
	for _, file := range files {
		groups[path.Dir(file.Path)] = append(groups[path.Dir(file.Path)], file)
	}
	directories := make([]string, 0, len(groups))
	for directory := range groups {
		directories = append(directories, directory)
	}
	sort.Strings(directories)
	selected := make([]projectFile, 0, len(files))
	for _, directory := range directories {
		packageFiles, err := selectGoBuildFiles(groups[directory], build)
		if err != nil {
			if strings.Contains(err.Error(), "has no files for build target") {
				continue
			}
			return nil, err
		}
		selected = append(selected, packageFiles...)
	}
	sort.Slice(selected, func(i, j int) bool { return selected[i].Path < selected[j].Path })
	return selected, nil
}

func checkDownstreamModuleCompatibility(app *projectModuleCatalog, downstream downstreamModuleSnapshot, build goBuildContext) (bool, error) {
	if downstream.ModulePath == "" || !safeGoModuleImportPath(downstream.ModulePath) || downstream.ModulePath == app.ModulePath {
		return false, fmt.Errorf("downstream Go module identity is invalid")
	}
	if downstream.ModuleRoot != "" {
		root, err := safeGoModuleRoot(downstream.ModuleRoot)
		if err != nil || root != downstream.ModuleRoot {
			return false, fmt.Errorf("downstream Go module root is invalid")
		}
	}
	if len(downstream.Files) == 0 || len(downstream.Files) > maxProjectFiles {
		return false, fmt.Errorf("downstream Go module requires between 1 and %d source files", maxProjectFiles)
	}
	if len(downstream.GoMod) == 0 || len(downstream.GoModHash) != 64 || !strings.EqualFold(hashText(downstream.GoMod), downstream.GoModHash) {
		return false, fmt.Errorf("downstream Go module requires a matching go.mod receipt")
	}
	if (downstream.GoSum == "") != (downstream.GoSumHash == "") || (downstream.GoSum != "" && (len(downstream.GoSumHash) != 64 || !strings.EqualFold(hashText(downstream.GoSum), downstream.GoSumHash))) {
		return false, fmt.Errorf("downstream Go module go.sum receipt is invalid")
	}
	consumerBase := request{
		ModulePath: downstream.ModulePath, ModuleRoot: downstream.ModuleRoot,
		GoMod: downstream.GoMod, GoModHash: downstream.GoModHash, GoSum: downstream.GoSum, GoSumHash: downstream.GoSumHash,
		BuildGOOS: build.GOOS, BuildGOARCH: build.GOARCH, BuildCgo: &build.CgoEnabled, BuildTags: append([]string(nil), build.Tags...),
	}
	fallbackManifest, err := downstreamFallbackManifest(downstream.GoMod, downstream.ModulePath, app.ModulePath, build)
	if err != nil {
		return false, err
	}
	consumerBase.GoMod = fallbackManifest
	consumerBase.GoModHash = hashText(fallbackManifest)
	context, err := normalizeGoBuildContext(consumerBase)
	if err != nil {
		return false, fmt.Errorf("downstream Go build context is invalid: %w", err)
	}
	files := append([]projectFile(nil), downstream.Files...)
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	seenPaths := make(map[string]bool, len(files))
	totalBytes := 0
	importsTarget := false
	groups := make(map[string][]projectFile)
	for _, file := range files {
		filePath, pathErr := safeGoPath(file.Path)
		if pathErr != nil || filePath != file.Path || (downstream.ModuleRoot != "" && filePath != downstream.ModuleRoot && !strings.HasPrefix(filePath, downstream.ModuleRoot+"/")) {
			return false, fmt.Errorf("downstream Go source path is outside its module root")
		}
		pathKey := strings.ToLower(filePath)
		if seenPaths[pathKey] {
			return false, fmt.Errorf("downstream Go module source paths collide: %s", filePath)
		}
		seenPaths[pathKey] = true
		totalBytes += len([]byte(file.Source))
		if totalBytes > maxProjectBytes || len([]byte(file.Source)) > maxProjectFileBytes {
			return false, fmt.Errorf("downstream Go module source exceeds the safe-check limit")
		}
		if file.ExpectedHash != "" && !strings.EqualFold(hashText(file.Source), file.ExpectedHash) {
			return false, fmt.Errorf("downstream Go source changed for %s", file.Path)
		}
		fileSet := token.NewFileSet()
		parsed, parseErr := parser.ParseFile(fileSet, file.Path, file.Source, parser.AllErrors|parser.ParseComments)
		if parseErr != nil {
			return false, fmt.Errorf("downstream Go parser rejected %s: %s", file.Path, parseErr.Error())
		}
		for _, spec := range parsed.Imports {
			importPath, unquoteErr := strconv.Unquote(spec.Path.Value)
			if unquoteErr == nil && (importPath == app.ModulePath || strings.HasPrefix(importPath, app.ModulePath+"/")) {
				importsTarget = true
			}
		}
		key := path.Dir(file.Path) + "\x00" + parsed.Name.Name
		groups[key] = append(groups[key], file)
	}
	if !importsTarget {
		return false, nil
	}
	selectedFiles, err := selectDownstreamBuildFiles(files, context)
	if err != nil {
		return true, fmt.Errorf("cannot select downstream Go build files: %w", err)
	}
	packageRequests := make(map[string]request, len(groups))
	groupKeys := make([]string, 0, len(groups))
	for key := range groups {
		groupKeys = append(groupKeys, key)
	}
	sort.Strings(groupKeys)
	for _, key := range groupKeys {
		group := groups[key]
		var active []projectFile
		for _, file := range selectedFiles {
			if path.Dir(file.Path) == path.Dir(group[0].Path) {
				active = append(active, file)
			}
		}
		if len(active) == 0 {
			continue
		}
		importPath, pathErr := projectPackageImportPath(downstream.ModulePath, downstream.ModuleRoot, path.Dir(active[0].Path))
		if pathErr != nil {
			return true, pathErr
		}
		if _, collision := app.Importer.packages[importPath]; collision {
			return true, fmt.Errorf("downstream Go package path collides with target module: %s", importPath)
		}
		if _, duplicate := packageRequests[importPath]; duplicate {
			return true, fmt.Errorf("downstream Go module has ambiguous package path: %s", importPath)
		}
		packageRequests[importPath] = request{
			SelectedPath: active[0].Path, Source: active[0].Source, Files: active, PackagePath: importPath,
			BuildGOOS: context.GOOS, BuildGOARCH: context.GOARCH, BuildCgo: &context.CgoEnabled, BuildTags: append([]string(nil), context.Tags...),
			ModulePath: downstream.ModulePath, ModuleRoot: downstream.ModuleRoot,
			GoMod: downstream.GoMod, GoModHash: downstream.GoModHash, GoSum: downstream.GoSum, GoSumHash: downstream.GoSumHash,
		}
	}
	if len(packageRequests) == 0 {
		return false, nil
	}
	fallback := newGoTargetImporter(context)
	if fallback.setupErr != nil {
		_ = fallback.Close()
		return true, fallback.setupErr
	}
	defer fallback.Close()
	packages := make(map[string]request, len(app.Importer.packages)+len(packageRequests))
	catalogs := make(map[string]*projectCatalog, len(app.Importer.catalogs)+len(app.Importer.packages))
	for importPath, packageRequest := range app.Importer.packages {
		packages[importPath] = packageRequest
	}
	for importPath, catalog := range app.Importer.catalogs {
		catalogs[importPath] = catalog
	}
	for importPath, packageRequest := range packageRequests {
		if _, exists := packages[importPath]; exists {
			return true, fmt.Errorf("downstream Go module package path is ambiguous: %s", importPath)
		}
		packages[importPath] = packageRequest
	}
	consumerImporter := &goProjectImporter{
		packages: packages, catalogs: catalogs, visiting: make(map[string]bool), fallback: fallback,
	}
	importsTarget = false
	consumerPaths := make([]string, 0, len(packageRequests))
	for importPath := range packageRequests {
		consumerPaths = append(consumerPaths, importPath)
	}
	sort.Strings(consumerPaths)
	for _, importPath := range consumerPaths {
		catalog, loadErr := consumerImporter.load(importPath)
		if loadErr != nil {
			return true, fmt.Errorf("downstream Go module %s does not type-check: %s", downstream.ModulePath, loadErr.Error())
		}
		for _, file := range catalog.Files {
			for _, spec := range file.AST.Imports {
				imported, unquoteErr := strconv.Unquote(spec.Path.Value)
				if unquoteErr == nil && (imported == app.ModulePath || strings.HasPrefix(imported, app.ModulePath+"/")) {
					importsTarget = true
				}
			}
		}
	}
	return importsTarget, nil
}

func applyProjectModuleRenames(req request) (map[string]any, error) {
	catalog, err := buildProjectModuleCatalog(req)
	if err != nil {
		return nil, err
	}
	defer catalog.close()
	catalog.collectMethodBindings()
	if len(req.ExpectedHash) != 64 || !strings.EqualFold(req.ExpectedHash, catalog.SelectedHash) ||
		len(req.SourceSetHash) != 64 || !strings.EqualFold(req.SourceSetHash, catalog.SourceSetHash) {
		return nil, fmt.Errorf("Go module source changed after rename suggestions were generated")
	}
	if len(req.Renames) < 1 || len(req.Renames) > maxRenames {
		return nil, fmt.Errorf("Select between 1 and 80 Go module bindings to rename")
	}
	selected := make([]projectRenameChoice, 0, len(req.Renames))
	selectedObjects := make(map[types.Object]bool, len(req.Renames))
	seen := make(map[string]bool)
	for _, rename := range req.Renames {
		item, ok := catalog.BindingByID[rename.ID]
		if !ok || (item.FilePath != catalog.SelectedPath && item.Kind != "file import alias") || seen[rename.ID] ||
			len(rename.NewName) > 128 || !token.IsIdentifier(rename.NewName) ||
			token.Lookup(rename.NewName).IsKeyword() || rename.NewName == item.Name {
			return nil, fmt.Errorf("A selected Go rename no longer matches a binding in the module snapshot")
		}
		if item.Kind == "method" && token.IsExported(rename.NewName) != token.IsExported(item.Name) {
			return nil, fmt.Errorf("Go rename cannot change whether method %s is exported", item.Name)
		}
		if types.Universe.Lookup(rename.NewName) != nil {
			return nil, fmt.Errorf("Renaming %s to predeclared Go name %s is not allowed", item.Name, rename.NewName)
		}
		seen[rename.ID] = true
		selectedObjects[item.Object] = true
		selected = append(selected, projectRenameChoice{item: item, newName: rename.NewName})
	}
	for _, choice := range selected {
		if choice.item.Kind != "method" || !choice.item.Exported {
			continue
		}
		variant, variantErr := unselectedMethodVariant(catalog, choice.item.Object.(*types.Func))
		if variantErr != nil {
			return nil, variantErr
		}
		if variant != "" {
			return nil, fmt.Errorf("cannot safely rename exported method %s: another build-specific declaration exists in %s", choice.item.Name, variant)
		}
		reference, referenceErr := unselectedMethodReference(req, catalog, choice.item.Object.(*types.Func))
		if referenceErr != nil {
			return nil, referenceErr
		}
		if reference != "" {
			return nil, fmt.Errorf("cannot safely rename exported method %s: an inactive build-specific reference exists in %s", choice.item.Name, reference)
		}
	}
	methodTargets := make(map[types.Object]map[string]bool)
	fileAliasTargets := make(map[string]map[string]bool)
	for _, choice := range selected {
		if choice.item.ScopeType == "file" && choice.item.Kind == "file import alias" {
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
			continue
		}
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
		if existing := receiverMethodNamed(choice.item.Object, choice.item.Object.Pkg(), choice.newName); existing != nil && existing != choice.item.Object && !selectedObjects[existing] {
			return nil, fmt.Errorf("Renaming %s to %s would collide with a method on the receiver type", choice.item.Name, choice.newName)
		}
	}
	interfaceContracts, err := moduleInterfaceContracts(catalog)
	if err != nil {
		return nil, err
	}
	filesByPath := make(map[string]projectSourceFile, len(catalog.Files))
	for _, file := range catalog.Files {
		filesByPath[file.Path] = file
	}
	editsByPath := make(map[string][]sourceEdit)
	detailsByPath := make(map[string][]map[string]any)
	for _, choice := range selected {
		for _, identifier := range choice.item.Uses {
			packageCatalog := catalog.IdentifierCatalog[identifier]
			position := packageCatalog.FileSet.PositionFor(identifier.Pos(), false)
			editsByPath[position.Filename] = append(editsByPath[position.Filename], sourceEdit{start: position.Offset, end: packageCatalog.FileSet.PositionFor(identifier.End(), false).Offset, text: choice.newName})
			detailsByPath[position.Filename] = append(detailsByPath[position.Filename], map[string]any{
				"start": position.Offset, "end": packageCatalog.FileSet.PositionFor(identifier.End(), false).Offset,
				"old_text": identifier.Name, "new_text": choice.newName,
			})
		}
	}
	outputsByPath := make(map[string]string, len(editsByPath))
	outputFiles := make([]projectFile, 0, len(catalog.Files))
	manifestFiles := make([]map[string]any, 0, len(editsByPath))
	for _, file := range catalog.Files {
		output := file.Text
		fileEdits := editsByPath[file.Path]
		if len(fileEdits) > 0 {
			sort.Slice(fileEdits, func(i, j int) bool { return fileEdits[i].start > fileEdits[j].start })
			outputBytes := []byte(file.Text)
			for _, edit := range fileEdits {
				outputBytes = append(outputBytes[:edit.start], append([]byte(edit.text), outputBytes[edit.end:]...)...)
			}
			output = string(outputBytes)
			outputsByPath[file.Path] = output
			details := detailsByPath[file.Path]
			sort.Slice(details, func(i, j int) bool { return details[i]["start"].(int) < details[j]["start"].(int) })
			manifestFiles = append(manifestFiles, map[string]any{
				"relative_path": file.Path, "input_sha256": hashText(file.Text),
				"output_sha256": hashText(output), "source_code": output, "edits": details,
			})
		}
		outputFiles = append(outputFiles, projectFile{Path: file.Path, Source: output, ExpectedHash: hashText(output)})
	}
	outputRequest := req
	outputRequest.Files = outputFiles
	outputRequest.Source = outputsByPath[catalog.SelectedPath]
	if outputRequest.Source == "" {
		outputRequest.Source = filesByPath[catalog.SelectedPath].Text
	}
	outputRequest.ExpectedHash = ""
	outputRequest.SourceSetHash = ""
	outputCatalog, err := buildProjectModuleCatalog(outputRequest)
	if err != nil {
		return nil, fmt.Errorf("Go module rejected the renamed output: %s", err.Error())
	}
	defer outputCatalog.close()
	if !sameModuleInterfaceContracts(interfaceContracts, outputCatalog) {
		return nil, fmt.Errorf("Go rename would change a module or imported interface implementation contract")
	}
	outputCatalog.collectMethodBindings()
	identifierMaps := make(map[string]map[int]*ast.Ident, len(outputCatalog.Catalogs))
	for _, packageCatalog := range outputCatalog.Catalogs {
		for filePath, identifiers := range projectIdentifiersByOffset(packageCatalog) {
			identifierMaps[filePath] = identifiers
		}
	}
	for _, choice := range selected {
		declarationPosition := catalog.CatalogByFile[choice.item.FilePath].FileSet.PositionFor(choice.item.Declaration.Pos(), false)
		declarationOffset := offsetAfterEdits(declarationPosition.Offset, editsByPath[declarationPosition.Filename])
		declaration := identifierMaps[declarationPosition.Filename][declarationOffset]
		outputPackage := outputCatalog.CatalogByFile[declarationPosition.Filename]
		renamedObject := outputPackage.Info.Defs[declaration]
		if declaration == nil || renamedObject == nil || declaration.Name != choice.newName {
			return nil, fmt.Errorf("Go could not resolve the renamed declaration for %s", choice.item.Name)
		}
		for _, original := range choice.item.Uses {
			originalPackage := catalog.IdentifierCatalog[original]
			position := originalPackage.FileSet.PositionFor(original.Pos(), false)
			outputOffset := offsetAfterEdits(position.Offset, editsByPath[position.Filename])
			transformed := identifierMaps[position.Filename][outputOffset]
			resolvedPackage := outputCatalog.CatalogByFile[position.Filename]
			var resolved types.Object
			if original == choice.item.Declaration {
				resolved = resolvedPackage.Info.Defs[transformed]
			} else {
				resolved = resolvedPackage.Info.Uses[transformed]
			}
			if transformed == nil || transformed.Name != choice.newName || resolved != renamedObject {
				return nil, fmt.Errorf("Renaming %s would change a module binding in %s", choice.item.Name, position.Filename)
			}
		}
	}
	downstreamCompatibility := map[string]any{"status": "not_required", "checked_modules": 0}
	needsDownstreamCheck := false
	for _, choice := range selected {
		if choice.item.Kind == "method" && choice.item.Exported {
			needsDownstreamCheck = true
			break
		}
	}
	if needsDownstreamCheck {
		if req.DownstreamModules == nil {
			downstreamCompatibility["status"] = "not_supplied"
		} else if len(req.DownstreamModules) > 32 {
			return nil, fmt.Errorf("downstream Go compatibility is limited to 32 module snapshots")
		} else {
			downstreamPaths := make(map[string]bool, len(req.DownstreamModules))
			downstreamFiles, downstreamBytes := 0, 0
			for _, downstream := range req.DownstreamModules {
				if downstreamPaths[downstream.ModulePath] {
					return nil, fmt.Errorf("downstream Go module paths are ambiguous: %s", downstream.ModulePath)
				}
				downstreamPaths[downstream.ModulePath] = true
				downstreamFiles += len(downstream.Files)
				for _, file := range downstream.Files {
					downstreamBytes += len([]byte(file.Source))
				}
			}
			if downstreamFiles > maxProjectFiles || downstreamBytes > maxProjectBytes {
				return nil, fmt.Errorf("downstream Go compatibility exceeds the %d-file or 8 MiB safe-check limit", maxProjectFiles)
			}
			buildContext, contextErr := normalizeGoBuildContext(req)
			if contextErr != nil {
				return nil, contextErr
			}
			checkedModules := make(map[string]bool)
			checkedContexts := make([]map[string]any, 0, len(projectValidationBuildContexts(buildContext)))
			for contextIndex, target := range projectValidationBuildContexts(buildContext) {
				beforeCatalog, afterCatalog := catalog, outputCatalog
				if contextIndex > 0 {
					candidateCount := 0
					for _, downstream := range req.DownstreamModules {
						importsTarget, inspectErr := downstreamModuleImportsTarget(downstream, catalog.ModulePath, target)
						if inspectErr != nil {
							return nil, fmt.Errorf("cannot inspect downstream module %s for %s/%s: %s", downstream.ModulePath, target.GOOS, target.GOARCH, inspectErr.Error())
						}
						if importsTarget {
							candidateCount++
						}
					}
					if candidateCount == 0 {
						continue
					}
					targetFiles, selectErr := selectGoBuildFiles(req.Files, target)
					if selectErr != nil {
						continue
					}
					targetSelected := false
					for _, file := range targetFiles {
						if file.Path == catalog.SelectedPath {
							targetSelected = true
							break
						}
					}
					if !targetSelected {
						continue
					}
					alternateRequest := req
					alternateRequest.BuildGOOS, alternateRequest.BuildGOARCH = target.GOOS, target.GOARCH
					alternateCatalog, buildErr := buildProjectModuleCatalog(alternateRequest)
					if buildErr != nil {
						return nil, fmt.Errorf("cannot type-check original target module under %s/%s: %s", target.GOOS, target.GOARCH, buildErr.Error())
					}
					defer alternateCatalog.close()
					alternateOutputRequest := alternateRequest
					alternateOutputRequest.Files = outputFiles
					alternateOutputRequest.Source = outputsByPath[catalog.SelectedPath]
					if alternateOutputRequest.Source == "" {
						alternateOutputRequest.Source = filesByPath[catalog.SelectedPath].Text
					}
					alternateOutputRequest.ExpectedHash, alternateOutputRequest.SourceSetHash = "", ""
					alternateOutputCatalog, outputBuildErr := buildProjectModuleCatalog(alternateOutputRequest)
					if outputBuildErr != nil {
						return nil, fmt.Errorf("Go module rejected renamed output under %s/%s: %s", target.GOOS, target.GOARCH, outputBuildErr.Error())
					}
					defer alternateOutputCatalog.close()
					alternateContracts, contractErr := moduleInterfaceContracts(alternateCatalog)
					if contractErr != nil || !sameModuleInterfaceContracts(alternateContracts, alternateOutputCatalog) {
						return nil, fmt.Errorf("Go rename would change a module or imported interface implementation contract under %s/%s", target.GOOS, target.GOARCH)
					}
					beforeCatalog, afterCatalog = alternateCatalog, alternateOutputCatalog
				}
				checkedForContext := false
				for _, downstream := range req.DownstreamModules {
					if contextIndex > 0 {
						importsTarget, inspectErr := downstreamModuleImportsTarget(downstream, catalog.ModulePath, target)
						if inspectErr != nil {
							return nil, fmt.Errorf("cannot inspect downstream module %s for %s/%s: %s", downstream.ModulePath, target.GOOS, target.GOARCH, inspectErr.Error())
						}
						if !importsTarget {
							continue
						}
					}
					importsTarget, checkErr := checkDownstreamModuleCompatibility(beforeCatalog, downstream, target)
					if checkErr != nil {
						return nil, fmt.Errorf("cannot verify downstream compatibility for %s against original module under %s/%s: %s", downstream.ModulePath, target.GOOS, target.GOARCH, checkErr.Error())
					}
					if !importsTarget {
						continue
					}
					checkedForContext = true
					checkedModules[downstream.ModulePath] = true
					if _, checkErr := checkDownstreamModuleCompatibility(afterCatalog, downstream, target); checkErr != nil {
						return nil, fmt.Errorf("Go rename breaks downstream module %s or leaves it untype-checkable under %s/%s: %s", downstream.ModulePath, target.GOOS, target.GOARCH, checkErr.Error())
					}
				}
				if checkedForContext {
					checkedContexts = append(checkedContexts, map[string]any{"goos": target.GOOS, "goarch": target.GOARCH, "build_tags": append([]string{}, target.Tags...)})
				}
			}
			if len(checkedModules) > 0 {
				status := "checked"
				if !req.DownstreamModulesComplete {
					status = "partial"
				}
				downstreamCompatibility = map[string]any{"status": status, "checked_modules": len(checkedModules), "build_goos": buildContext.GOOS, "build_goarch": buildContext.GOARCH, "checked_build_contexts": checkedContexts}
			} else {
				if req.DownstreamModulesComplete {
					downstreamCompatibility["status"] = "no_consumers"
				} else {
					downstreamCompatibility["status"] = "incomplete"
				}
			}
		}
	}
	selectedOutput := outputsByPath[catalog.SelectedPath]
	if selectedOutput == "" {
		selectedOutput = filesByPath[catalog.SelectedPath].Text
	}
	renamed := make([]map[string]any, 0, len(selected))
	for _, choice := range selected {
		renamed = append(renamed, map[string]any{
			"bindingId": choice.item.ID, "oldName": choice.item.Name, "newName": choice.newName,
			"kind": choice.item.Kind, "referenceCount": choice.item.ReferenceCount,
			"scopeType": choice.item.ScopeType, "relativePath": choice.item.FilePath,
			"exported": choice.item.Exported,
		})
	}
	outputSourceSet := make([]projectSourceFile, 0, len(outputFiles))
	for _, file := range outputFiles {
		outputSourceSet = append(outputSourceSet, projectSourceFile{Path: file.Path, Text: file.Source})
	}
	return map[string]any{
		"source_sha256": catalog.SelectedHash, "source_set_sha256": catalog.SourceSetHash,
		"inventory_scope_sha256":        catalog.InventoryScopeHash,
		"output_source_set_sha256":      hashProjectSources(outputSourceSet),
		"output_inventory_scope_sha256": outputCatalog.InventoryScopeHash,
		"output_sha256":                 hashText(selectedOutput), "source_code": selectedOutput,
		"files": manifestFiles, "renamed_bindings": renamed,
		"downstream_compatibility": downstreamCompatibility,
		"parser_version":           runtime.Version(), "scope": "module",
	}, nil
}

func moduleInterfaceContracts(catalog *projectModuleCatalog) (map[string]bool, error) {
	typesByID := make(map[string]*types.Named)
	interfacesByID := make(map[string]*types.Interface)
	for _, packageCatalog := range catalog.Catalogs {
		for _, name := range packageCatalog.Package.Scope().Names() {
			object, ok := packageCatalog.Package.Scope().Lookup(name).(*types.TypeName)
			if !ok {
				continue
			}
			named, ok := types.Unalias(object.Type()).(*types.Named)
			if !ok {
				continue
			}
			id := named.Obj().Pkg().Path() + "\x00" + named.Obj().Name()
			if iface, ok := named.Underlying().(*types.Interface); ok {
				interfacesByID[id] = iface.Complete()
			} else {
				typesByID[id] = named
			}
		}
	}
	packages := make(map[string]*types.Package)
	encodingContracts, err := catalog.Importer.fallback.Import("encoding")
	if err != nil {
		return nil, fmt.Errorf("cannot load Go encoding interface contracts: %s", err.Error())
	}
	queue := []*types.Package{encodingContracts}
	for _, packageCatalog := range catalog.Catalogs {
		queue = append(queue, packageCatalog.Package)
	}
	for len(queue) > 0 {
		pkg := queue[0]
		queue = queue[1:]
		if pkg == nil || packages[pkg.Path()] != nil {
			continue
		}
		if len(packages) >= 4096 {
			return nil, fmt.Errorf("Go module interface check exceeds its 4096-package bound")
		}
		packages[pkg.Path()] = pkg
		for _, imported := range pkg.Imports() {
			queue = append(queue, imported)
		}
	}
	for _, pkg := range packages {
		for _, name := range pkg.Scope().Names() {
			object, ok := pkg.Scope().Lookup(name).(*types.TypeName)
			if !ok {
				continue
			}
			named, ok := types.Unalias(object.Type()).(*types.Named)
			if !ok {
				continue
			}
			iface, ok := named.Underlying().(*types.Interface)
			if !ok {
				continue
			}
			id := named.Obj().Pkg().Path() + "\x00" + named.Obj().Name()
			interfacesByID[id] = iface.Complete()
		}
	}
	if errorType, ok := types.Universe.Lookup("error").(*types.TypeName); ok {
		if iface, ok := errorType.Type().Underlying().(*types.Interface); ok {
			interfacesByID["builtin\x00error"] = iface.Complete()
		}
	}
	contracts := make(map[string]bool)
	for typeID, named := range typesByID {
		for interfaceID, iface := range interfacesByID {
			if types.Implements(named, iface) {
				contracts["value\x00"+typeID+"\x00"+interfaceID] = true
			}
			if types.Implements(types.NewPointer(named), iface) {
				contracts["pointer\x00"+typeID+"\x00"+interfaceID] = true
			}
		}
	}
	return contracts, nil
}

func sameModuleInterfaceContracts(before map[string]bool, afterCatalog *projectModuleCatalog) bool {
	after, err := moduleInterfaceContracts(afterCatalog)
	if err != nil || len(before) != len(after) {
		return false
	}
	for contract := range before {
		if !after[contract] {
			return false
		}
	}
	return true
}
