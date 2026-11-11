package main

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"go/types"
	"path"
	"runtime"
	"sort"
	"strings"
)

type projectModuleCatalog struct {
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
		"parser_version": runtime.Version(), "scope": "module",
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
