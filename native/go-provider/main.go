package main

import (
	"crypto/sha256"
	"encoding/json"
	"flag"
	"fmt"
	"go/ast"
	"go/build"
	"go/importer"
	"go/parser"
	"go/token"
	"go/types"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

type edge struct {
	SourceFile   string `json:"sourceFile"`
	SourceName   string `json:"sourceName"`
	SourceOffset int    `json:"sourceOffset"`
	CallOffset   int    `json:"callOffset"`
	TargetFile   string `json:"targetFile"`
	TargetName   string `json:"targetName"`
	TargetOffset int    `json:"targetOffset"`
}

type output struct {
	Edges       []edge   `json:"edges"`
	Diagnostics []string `json:"diagnostics"`
	Toolchain   string   `json:"toolchain"`
}

type approvedFile struct {
	Path        string `json:"path"`
	SizeBytes   int64  `json:"sizeBytes"`
	ContentHash string `json:"contentHash"`
}

type providerInput struct {
	Files []approvedFile `json:"files"`
}

type checkedPackage struct {
	files []*ast.File
	info  *types.Info
}

type sourcePackage struct {
	directory string
	name      string
	files     []*ast.File
}

type workspaceImporter struct {
	root                  string
	fset                  *token.FileSet
	filesByImportPath     map[string][]*ast.File
	directoryByImportPath map[string]string
	fallback              types.Importer
	packages              map[string]*types.Package
	checked               map[string]checkedPackage
	checking              map[string]bool
	diagnostics           *[]string
}

func relative(root, name string) string {
	value, err := filepath.Rel(root, name)
	if err != nil {
		return filepath.ToSlash(name)
	}
	return filepath.ToSlash(value)
}

func pathInside(root, candidate string) bool {
	relativePath, err := filepath.Rel(root, candidate)
	if err != nil || filepath.IsAbs(relativePath) {
		return false
	}
	return relativePath != ".." && !strings.HasPrefix(relativePath, ".."+string(filepath.Separator))
}

func approvedSourceFiles(root string) ([]approvedFile, error) {
	decoder := json.NewDecoder(io.LimitReader(os.Stdin, 16*1024*1024+1))
	decoder.DisallowUnknownFields()
	var input providerInput
	if err := decoder.Decode(&input); err != nil {
		return nil, fmt.Errorf("invalid approved-file manifest: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return nil, fmt.Errorf("approved-file manifest has trailing data")
	}
	rootReal, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, fmt.Errorf("resolve workspace root: %w", err)
	}
	seen := map[string]bool{}
	approved := make([]approvedFile, 0, len(input.Files))
	for _, entry := range input.Files {
		if entry.Path == "" || strings.Contains(entry.Path, "\\") || filepath.IsAbs(entry.Path) || filepath.VolumeName(entry.Path) != "" {
			return nil, fmt.Errorf("invalid approved relative path %q", entry.Path)
		}
		clean := filepath.Clean(filepath.FromSlash(entry.Path))
		if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) || !strings.EqualFold(filepath.Ext(clean), ".go") {
			return nil, fmt.Errorf("approved path escapes workspace or is not Go source: %q", entry.Path)
		}
		canonical := filepath.ToSlash(clean)
		if seen[canonical] {
			return nil, fmt.Errorf("duplicate approved path %q", entry.Path)
		}
		seen[canonical] = true
		candidate := root
		for _, component := range strings.Split(canonical, "/") {
			candidate = filepath.Join(candidate, component)
			status, statErr := os.Lstat(candidate)
			if statErr != nil {
				return nil, fmt.Errorf("inspect approved path %q: %w", entry.Path, statErr)
			}
			if status.Mode()&os.ModeSymlink != 0 {
				return nil, fmt.Errorf("approved path contains symbolic link: %q", entry.Path)
			}
		}
		status, err := os.Lstat(candidate)
		if err != nil || !status.Mode().IsRegular() || status.Size() != entry.SizeBytes {
			return nil, fmt.Errorf("approved file identity changed: %q", entry.Path)
		}
		candidateReal, err := filepath.EvalSymlinks(candidate)
		if err != nil || !pathInside(rootReal, candidateReal) {
			return nil, fmt.Errorf("approved file leaves workspace: %q", entry.Path)
		}
		content, err := os.ReadFile(candidateReal)
		if err != nil || int64(len(content)) != entry.SizeBytes || fmt.Sprintf("%x", sha256.Sum256(content)) != entry.ContentHash {
			return nil, fmt.Errorf("approved file content changed: %q", entry.Path)
		}
		approved = append(approved, approvedFile{Path: canonical, SizeBytes: entry.SizeBytes, ContentHash: entry.ContentHash})
	}
	sort.Slice(approved, func(i, j int) bool { return approved[i].Path < approved[j].Path })
	return approved, nil
}

func readModulePath(root string) string {
	content, err := os.ReadFile(filepath.Join(root, "go.mod"))
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(content), "\n") {
		fields := strings.Fields(strings.SplitN(line, "//", 2)[0])
		if len(fields) >= 2 && fields[0] == "module" {
			return strings.Trim(fields[1], "\"")
		}
	}
	return ""
}

func packageImportPath(root, modulePath, directory string) string {
	relativeDirectory := relative(root, directory)
	if modulePath != "" {
		if relativeDirectory == "." {
			return modulePath
		}
		return strings.TrimSuffix(modulePath, "/") + "/" + strings.TrimPrefix(relativeDirectory, "./")
	}
	if relativeDirectory == "." {
		return "contextmesh.local/root"
	}
	return "contextmesh.local/" + relativeDirectory
}

func newTypesInfo() *types.Info {
	return &types.Info{
		Uses:       map[*ast.Ident]types.Object{},
		Selections: map[*ast.SelectorExpr]*types.Selection{},
	}
}

func (loader *workspaceImporter) Import(importPath string) (*types.Package, error) {
	if checked := loader.packages[importPath]; checked != nil {
		return checked, nil
	}
	files := loader.filesByImportPath[importPath]
	if files == nil {
		return loader.fallback.Import(importPath)
	}
	if loader.checking[importPath] {
		return nil, fmt.Errorf("local import cycle at %s", importPath)
	}
	loader.checking[importPath] = true
	defer delete(loader.checking, importPath)
	info := newTypesInfo()
	directory := loader.directoryByImportPath[importPath]
	config := &types.Config{
		Importer: loader,
		Error: func(typeErr error) {
			*loader.diagnostics = append(*loader.diagnostics, relative(loader.root, directory)+": "+typeErr.Error())
		},
	}
	checked, checkErr := config.Check(importPath, loader.fset, files, info)
	if checked != nil {
		loader.packages[importPath] = checked
		loader.checked[importPath] = checkedPackage{files: files, info: info}
	}
	return checked, checkErr
}

func main() {
	rootFlag := flag.String("root", ".", "workspace root")
	filesStdin := flag.Bool("files-stdin", false, "read scanner-approved Go files from standard input")
	flag.Parse()
	root, err := filepath.Abs(*rootFlag)
	if err != nil {
		panic(err)
	}
	fset := token.NewFileSet()
	groups := map[string]*sourcePackage{}
	diagnostics := []string{}
	if !*filesStdin {
		fmt.Fprintln(os.Stderr, "scanner-approved file manifest is required")
		os.Exit(2)
	}
	approved, err := approvedSourceFiles(root)
	if err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(2)
	}
	for _, entry := range approved {
		name := filepath.Join(root, filepath.FromSlash(entry.Path))
		matches, matchErr := build.Default.MatchFile(filepath.Dir(name), filepath.Base(name))
		if matchErr != nil {
			diagnostics = append(diagnostics, entry.Path+": "+matchErr.Error())
			continue
		}
		if !matches {
			diagnostics = append(diagnostics, entry.Path+": excluded by local Go build constraints")
			continue
		}
		content, readErr := os.ReadFile(name)
		if readErr != nil || int64(len(content)) != entry.SizeBytes || fmt.Sprintf("%x", sha256.Sum256(content)) != entry.ContentHash {
			fmt.Fprintln(os.Stderr, "approved file changed before parse: "+entry.Path)
			os.Exit(2)
		}
		file, parseErr := parser.ParseFile(fset, name, content, parser.SkipObjectResolution)
		if parseErr != nil {
			diagnostics = append(diagnostics, relative(root, name)+": "+parseErr.Error())
		}
		if file != nil {
			directory := filepath.Dir(name)
			packageName := file.Name.Name
			key := directory + "\x00" + packageName
			group := groups[key]
			if group == nil {
				group = &sourcePackage{directory: directory, name: packageName}
				groups[key] = group
			}
			group.files = append(group.files, file)
		}
	}

	edges := []edge{}
	groupKeys := make([]string, 0, len(groups))
	for key := range groups {
		groupKeys = append(groupKeys, key)
	}
	sort.Strings(groupKeys)
	modulePath := readModulePath(root)
	filesByImportPath := map[string][]*ast.File{}
	directoryByImportPath := map[string]string{}
	for _, key := range groupKeys {
		group := groups[key]
		files := group.files
		sort.Slice(files, func(i, j int) bool {
			return fset.Position(files[i].Pos()).Filename < fset.Position(files[j].Pos()).Filename
		})
		baseImportPath := packageImportPath(root, modulePath, group.directory)
		importPath := baseImportPath
		if strings.HasSuffix(group.name, "_test") {
			importPath = baseImportPath + "_test"
		} else if existing := filesByImportPath[importPath]; existing != nil && existing[0].Name.Name != group.name {
			diagnostics = append(diagnostics, relative(root, group.directory)+": multiple non-test packages in one directory")
			importPath = baseImportPath + "__" + group.name
		}
		filesByImportPath[importPath] = files
		directoryByImportPath[importPath] = group.directory
	}
	loader := &workspaceImporter{
		root: root, fset: fset, filesByImportPath: filesByImportPath,
		directoryByImportPath: directoryByImportPath, fallback: importer.Default(),
		packages: map[string]*types.Package{}, checked: map[string]checkedPackage{},
		checking: map[string]bool{}, diagnostics: &diagnostics,
	}
	importPaths := make([]string, 0, len(filesByImportPath))
	for importPath := range filesByImportPath {
		importPaths = append(importPaths, importPath)
	}
	sort.Strings(importPaths)
	for _, importPath := range importPaths {
		_, _ = loader.Import(importPath)
	}
	for _, importPath := range importPaths {
		checked, ok := loader.checked[importPath]
		if !ok {
			continue
		}
		for _, file := range checked.files {
			for _, declaration := range file.Decls {
				function, ok := declaration.(*ast.FuncDecl)
				if !ok || function.Body == nil {
					continue
				}
				sourcePosition := fset.Position(function.Name.Pos())
				sourceFile := relative(root, sourcePosition.Filename)
				ast.Inspect(function.Body, func(node ast.Node) bool {
					call, ok := node.(*ast.CallExpr)
					if !ok {
						return true
					}
					var object types.Object
					switch callable := call.Fun.(type) {
					case *ast.Ident:
						object = checked.info.Uses[callable]
					case *ast.SelectorExpr:
						if selection := checked.info.Selections[callable]; selection != nil {
							object = selection.Obj()
						} else {
							object = checked.info.Uses[callable.Sel]
						}
					}
					target, ok := object.(*types.Func)
					if !ok || !target.Pos().IsValid() {
						return true
					}
					targetPosition := fset.Position(target.Pos())
					if targetPosition.Filename == "" {
						return true
					}
					targetFile, relErr := filepath.Rel(root, targetPosition.Filename)
					if relErr != nil || strings.HasPrefix(targetFile, "..") {
						return true
					}
					callPosition := fset.Position(call.Fun.Pos())
					edges = append(edges, edge{
						SourceFile: sourceFile, SourceName: function.Name.Name, SourceOffset: sourcePosition.Offset,
						CallOffset: callPosition.Offset,
						TargetFile: filepath.ToSlash(targetFile), TargetName: target.Name(), TargetOffset: targetPosition.Offset,
					})
					return true
				})
			}
		}
	}
	sort.Slice(edges, func(i, j int) bool {
		left := fmt.Sprintf("%s\x00%012d\x00%s\x00%012d", edges[i].SourceFile, edges[i].SourceOffset, edges[i].TargetFile, edges[i].TargetOffset)
		right := fmt.Sprintf("%s\x00%012d\x00%s\x00%012d", edges[j].SourceFile, edges[j].SourceOffset, edges[j].TargetFile, edges[j].TargetOffset)
		return left < right
	})
	sort.Strings(diagnostics)
	encoded, err := json.Marshal(output{Edges: edges, Diagnostics: diagnostics, Toolchain: runtime.Version()})
	if err != nil {
		panic(err)
	}
	_, _ = os.Stdout.Write(append(encoded, '\n'))
}
