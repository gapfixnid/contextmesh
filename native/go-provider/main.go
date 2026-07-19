package main

import (
	"encoding/json"
	"flag"
	"go/ast"
	"go/importer"
	"go/parser"
	"go/token"
	"go/types"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type edge struct {
	SourceFile string `json:"sourceFile"`
	SourceName string `json:"sourceName"`
	TargetFile string `json:"targetFile"`
	TargetName string `json:"targetName"`
}

type output struct {
	Edges       []edge   `json:"edges"`
	Diagnostics []string `json:"diagnostics"`
}

func relative(root, name string) string {
	value, err := filepath.Rel(root, name)
	if err != nil { return filepath.ToSlash(name) }
	return filepath.ToSlash(value)
}

func main() {
	rootFlag := flag.String("root", ".", "workspace root")
	flag.Parse()
	root, err := filepath.Abs(*rootFlag)
	if err != nil { panic(err) }
	fset := token.NewFileSet()
	groups := map[string][]*ast.File{}
	diagnostics := []string{}
	_ = filepath.WalkDir(root, func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil { diagnostics = append(diagnostics, walkErr.Error()); return nil }
		if entry.IsDir() {
			base := entry.Name()
			if name != root && (base == ".git" || base == ".contextmesh" || base == "vendor" || base == "node_modules" || strings.HasPrefix(base, ".")) { return filepath.SkipDir }
			return nil
		}
		if !strings.HasSuffix(strings.ToLower(name), ".go") { return nil }
		file, parseErr := parser.ParseFile(fset, name, nil, parser.SkipObjectResolution)
		if parseErr != nil { diagnostics = append(diagnostics, relative(root, name)+": "+parseErr.Error()) }
		if file != nil { groups[filepath.Dir(name)] = append(groups[filepath.Dir(name)], file) }
		return nil
	})

	edges := []edge{}
	directories := make([]string, 0, len(groups))
	for directory := range groups { directories = append(directories, directory) }
	sort.Strings(directories)
	for _, directory := range directories {
		files := groups[directory]
		sort.Slice(files, func(i, j int) bool { return fset.Position(files[i].Pos()).Filename < fset.Position(files[j].Pos()).Filename })
		info := &types.Info{Uses: map[*ast.Ident]types.Object{}, Selections: map[*ast.SelectorExpr]*types.Selection{}}
		config := &types.Config{Importer: importer.Default(), Error: func(typeErr error) { diagnostics = append(diagnostics, relative(root, directory)+": "+typeErr.Error()) }}
		packagePath := relative(root, directory)
		if packagePath == "." { packagePath = "contextmesh.local/root" } else { packagePath = "contextmesh.local/"+packagePath }
		_, _ = config.Check(packagePath, fset, files, info)
		for _, file := range files {
			for _, declaration := range file.Decls {
				function, ok := declaration.(*ast.FuncDecl)
				if !ok || function.Body == nil { continue }
				sourceFile := relative(root, fset.Position(function.Pos()).Filename)
				ast.Inspect(function.Body, func(node ast.Node) bool {
					call, ok := node.(*ast.CallExpr)
					if !ok { return true }
					var object types.Object
					switch callable := call.Fun.(type) {
					case *ast.Ident:
						object = info.Uses[callable]
					case *ast.SelectorExpr:
						if selection := info.Selections[callable]; selection != nil { object = selection.Obj() } else { object = info.Uses[callable.Sel] }
					}
					target, ok := object.(*types.Func)
					if !ok || !target.Pos().IsValid() { return true }
					targetPosition := fset.Position(target.Pos())
					if targetPosition.Filename == "" { return true }
					targetFile, relErr := filepath.Rel(root, targetPosition.Filename)
					if relErr != nil || strings.HasPrefix(targetFile, "..") { return true }
					edges = append(edges, edge{SourceFile: sourceFile, SourceName: function.Name.Name, TargetFile: filepath.ToSlash(targetFile), TargetName: target.Name()})
					return true
				})
			}
		}
	}
	sort.Slice(edges, func(i, j int) bool {
		left := edges[i].SourceFile+"\x00"+edges[i].SourceName+"\x00"+edges[i].TargetFile+"\x00"+edges[i].TargetName
		right := edges[j].SourceFile+"\x00"+edges[j].SourceName+"\x00"+edges[j].TargetFile+"\x00"+edges[j].TargetName
		return left < right
	})
	encoded, err := json.Marshal(output{Edges: edges, Diagnostics: diagnostics})
	if err != nil { panic(err) }
	_, _ = os.Stdout.Write(append(encoded, '\n'))
}
