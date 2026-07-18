use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::io::{self, BufRead, Write};
use std::path::Path;
use std::sync::mpsc;
use tree_sitter::{Node, Parser, Point};

const PROTOCOL: &str = "contextmesh.graph-kernel/v1";

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", rename_all_fields = "camelCase")]
enum Request {
    Hello { request_id: String },
    ExtractPython { request_id: String, files: Vec<InputFile> },
    Watch { request_id: String, root_path: String },
    ProbeTypescript { request_id: String, content: String },
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InputFile { relative_path: String, content: String }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response<T: Serialize> {
    protocol: &'static str,
    request_id: String,
    status: &'static str,
    data: T,
    diagnostics: Vec<Diagnostic>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Diagnostic { code: String, severity: &'static str, message: String, path: Option<String> }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HelloData { kernel_version: &'static str, grammar_registry: Vec<Grammar> }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Grammar { language: &'static str, provider: &'static str, version: &'static str }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TypeScriptProbe {
    declarations: usize, imports: usize, calls: usize, nodes: usize, has_error: bool, rss_bytes: u64,
    declaration_names: Vec<String>, import_specifiers: Vec<String>, call_names: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PythonBatch { files: Vec<PythonFacts>, rss_bytes: u64 }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PythonFacts {
    relative_path: String,
    has_error: bool,
    declarations: Vec<Declaration>,
    imports: Vec<ImportFact>,
    inheritances: Vec<ReferenceFact>,
    calls: Vec<ReferenceFact>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Span { start_byte: usize, end_byte: usize, start_line: usize, start_column: usize, end_line: usize, end_column: usize }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Declaration {
    native_kind: String, name: String, symbol_path: String, container_kind: String,
    container_start_byte: Option<usize>, is_async: bool, signature: String, content: String, span: Span,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportedName { name: String, alias: Option<String> }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportFact { from_import: bool, raw_module: String, names: Vec<ImportedName>, span: Span, raw_text: String }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReferenceFact { owner_start_byte: Option<usize>, raw_name: String, simple_identifier: bool, span: Span }

fn span(node: Node) -> Span {
    let Point { row: sr, column: sc } = node.start_position();
    let Point { row: er, column: ec } = node.end_position();
    Span { start_byte: node.start_byte(), end_byte: node.end_byte(), start_line: sr + 1, start_column: sc + 1, end_line: er + 1, end_column: ec + 1 }
}

fn text<'a>(node: Node, source: &'a [u8]) -> &'a str { node.utf8_text(source).unwrap_or("") }

fn named_children(node: Node) -> Vec<Node> {
    let mut cursor = node.walk();
    node.named_children(&mut cursor).collect()
}

fn unwrap_definition(node: Node) -> Option<Node> {
    if node.kind() != "decorated_definition" { return Some(node); }
    named_children(node).into_iter().rev().find(|child| matches!(child.kind(), "function_definition" | "class_definition"))
}

fn import_name(node: Node, source: &[u8]) -> Option<ImportedName> {
    if node.kind() == "aliased_import" {
        let name = node.child_by_field_name("name").map(|item| text(item, source).trim().to_string())?;
        let alias = node.child_by_field_name("alias").map(|item| text(item, source).trim().to_string());
        return Some(ImportedName { name, alias });
    }
    let name = text(node, source).trim().to_string();
    (!name.is_empty()).then_some(ImportedName { name, alias: None })
}

fn declaration_signature(content: &str) -> String {
    for (index, character) in content.char_indices() {
        if character != ':' { continue; }
        let tail = &content[index + 1..];
        let Some(line_end) = tail.find('\n') else { continue; };
        let after_colon = tail[..line_end].trim_end_matches('\r').trim();
        if after_colon.is_empty() || after_colon.starts_with('#') {
            return content[..index].chars().take(1_000).collect();
        }
    }
    content.chars().take(1_000).collect()
}

fn walk(node: Node, source: &[u8], names: &[String], container_kind: &str, owner: Option<usize>, facts: &mut PythonFacts) {
    if node.kind() == "decorated_definition" {
        if let Some(definition) = unwrap_definition(node) { walk(definition, source, names, container_kind, owner, facts); }
        return;
    }
    let mut active_names = names.to_vec();
    let mut active_kind = container_kind.to_string();
    let mut active_owner = owner;
    if matches!(node.kind(), "function_definition" | "class_definition") {
        if let Some(name_node) = node.child_by_field_name("name") {
            let name = text(name_node, source).to_string();
            active_names.push(name.clone());
            let kind = if node.kind() == "class_definition" { "class" } else if container_kind == "class" { "method" } else { "function" };
            let content = text(node, source).to_string();
            let signature = declaration_signature(&content);
            facts.declarations.push(Declaration {
                native_kind: node.kind().to_string(), name, symbol_path: active_names.join("."), container_kind: kind.to_string(),
                container_start_byte: owner, is_async: content.trim_start().starts_with("async "),
                signature, content, span: span(node),
            });
            active_kind = kind.to_string();
            active_owner = Some(node.start_byte());
        }
    }
    if matches!(node.kind(), "import_statement" | "import_from_statement") {
        let children = named_children(node);
        let from_import = node.kind() == "import_from_statement";
        let raw_module = if from_import { children.first().map(|item| text(*item, source).trim().to_string()).unwrap_or_default() } else { String::new() };
        let offset = usize::from(from_import && !children.is_empty());
        let names = children.into_iter().skip(offset).filter_map(|child| import_name(child, source)).collect();
        facts.imports.push(ImportFact { from_import, raw_module, names, span: span(node), raw_text: text(node, source).to_string() });
    }
    if node.kind() == "class_definition" {
        if let Some(supers) = node.child_by_field_name("superclasses") {
            for base in named_children(supers) {
                facts.inheritances.push(ReferenceFact { owner_start_byte: active_owner, raw_name: text(base, source).to_string(), simple_identifier: base.kind() == "identifier", span: span(base) });
            }
        }
    }
    if node.kind() == "call" {
        if let Some(callable) = node.child_by_field_name("function") {
            facts.calls.push(ReferenceFact { owner_start_byte: active_owner, raw_name: text(callable, source).to_string(), simple_identifier: callable.kind() == "identifier", span: span(callable) });
        }
    }
    for child in named_children(node) { walk(child, source, &active_names, &active_kind, active_owner, facts); }
}

fn extract_file(input: &InputFile) -> Result<PythonFacts, Diagnostic> {
    let mut parser = Parser::new();
    parser.set_language(&tree_sitter_python::LANGUAGE.into()).map_err(|error| Diagnostic {
        code: "KERNEL_GRAMMAR_INIT_FAILED".into(), severity: "error", message: error.to_string(), path: Some(input.relative_path.clone()),
    })?;
    let tree = parser.parse(&input.content, None).ok_or_else(|| Diagnostic {
        code: "KERNEL_PARSE_FAILED".into(), severity: "error", message: "tree-sitter returned no tree".into(), path: Some(input.relative_path.clone()),
    })?;
    let root = tree.root_node();
    let mut facts = PythonFacts { relative_path: input.relative_path.clone(), has_error: root.has_error(), declarations: vec![], imports: vec![], inheritances: vec![], calls: vec![] };
    walk(root, input.content.as_bytes(), &[], "module", None, &mut facts);
    facts.declarations.sort_by_key(|item| (item.span.start_byte, item.span.end_byte));
    facts.imports.sort_by_key(|item| (item.span.start_byte, item.span.end_byte));
    facts.inheritances.sort_by_key(|item| (item.span.start_byte, item.span.end_byte));
    facts.calls.sort_by_key(|item| (item.span.start_byte, item.span.end_byte));
    Ok(facts)
}

fn probe_typescript(content: &str) -> Result<TypeScriptProbe, String> {
    let mut parser = Parser::new();
    parser.set_language(&tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()).map_err(|error| error.to_string())?;
    let tree = parser.parse(content, None).ok_or_else(|| "tree-sitter returned no TypeScript tree".to_string())?;
    let root = tree.root_node();
    let mut probe = TypeScriptProbe {
        declarations: 0, imports: 0, calls: 0, nodes: 0, has_error: root.has_error(), rss_bytes: 0,
        declaration_names: vec![], import_specifiers: vec![], call_names: vec![],
    };
    let mut stack = vec![root];
    while let Some(node) = stack.pop() {
        probe.nodes += 1;
        match node.kind() {
            "function_declaration" | "class_declaration" | "method_definition" | "interface_declaration" | "type_alias_declaration" => {
                probe.declarations += 1;
                if let Some(name) = node.child_by_field_name("name") { probe.declaration_names.push(text(name, content.as_bytes()).to_string()); }
            }
            "import_statement" => {
                probe.imports += 1;
                if let Some(source) = node.child_by_field_name("source") {
                    probe.import_specifiers.push(text(source, content.as_bytes()).trim_matches(|character| character == '\"' || character == '\'').to_string());
                }
            }
            "call_expression" | "new_expression" => {
                probe.calls += 1;
                if let Some(function) = node.child_by_field_name("function").or_else(|| node.child_by_field_name("constructor")) {
                    probe.call_names.push(text(function, content.as_bytes()).to_string());
                }
            }
            _ => {}
        }
        stack.extend(named_children(node));
    }
    let system = sysinfo::System::new_all();
    probe.rss_bytes = sysinfo::get_current_pid().ok().and_then(|pid| system.process(pid)).map(|process| process.memory()).unwrap_or(0);
    probe.declaration_names.sort(); probe.import_specifiers.sort(); probe.call_names.sort();
    Ok(probe)
}

fn emit<T: Serialize>(response: &Response<T>) {
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, response).expect("serialize response");
    stdout.write_all(b"\n").expect("write response"); stdout.flush().expect("flush response");
}

fn watch(request_id: String, root_path: String) {
    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
    let mut watcher = match RecommendedWatcher::new(move |event| { let _ = tx.send(event); }, Config::default()) {
        Ok(value) => value,
        Err(error) => { emit(&Response { protocol: PROTOCOL, request_id, status: "error", data: serde_json::json!({}), diagnostics: vec![Diagnostic { code: "WATCH_INIT_FAILED".into(), severity: "error", message: error.to_string(), path: Some(root_path) }] }); return; }
    };
    if let Err(error) = watcher.watch(Path::new(&root_path), RecursiveMode::Recursive) {
        emit(&Response { protocol: PROTOCOL, request_id, status: "error", data: serde_json::json!({}), diagnostics: vec![Diagnostic { code: "WATCH_START_FAILED".into(), severity: "error", message: error.to_string(), path: Some(root_path) }] }); return;
    }
    emit(&Response { protocol: PROTOCOL, request_id: request_id.clone(), status: "ready", data: serde_json::json!({"rootPath": root_path}), diagnostics: vec![] });
    for event in rx {
        match event {
            Ok(event) => {
                let mut paths: Vec<String> = event.paths.iter().map(|item| item.to_string_lossy().replace('\\', "/")).collect(); paths.sort(); paths.dedup();
                emit(&Response { protocol: PROTOCOL, request_id: request_id.clone(), status: "event", data: serde_json::json!({"kind": format!("{:?}", event.kind), "paths": paths}), diagnostics: vec![] });
            }
            Err(error) => emit(&Response { protocol: PROTOCOL, request_id: request_id.clone(), status: "error", data: serde_json::json!({}), diagnostics: vec![Diagnostic { code: "WATCH_EVENT_FAILED".into(), severity: "error", message: error.to_string(), path: None }] }),
        }
    }
}

fn main() {
    let stdin = io::stdin();
    for line in stdin.lock().lines().map_while(Result::ok) {
        let request: Request = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => { emit(&Response { protocol: PROTOCOL, request_id: "invalid".into(), status: "error", data: serde_json::json!({}), diagnostics: vec![Diagnostic { code: "PROTOCOL_INVALID_JSON".into(), severity: "error", message: error.to_string(), path: None }] }); continue; }
        };
        match request {
            Request::Hello { request_id } => emit(&Response { protocol: PROTOCOL, request_id, status: "ok", data: HelloData { kernel_version: env!("CARGO_PKG_VERSION"), grammar_registry: vec![Grammar { language: "python", provider: "tree-sitter-python", version: "0.25.0" }, Grammar { language: "typescript-benchmark-only", provider: "tree-sitter-typescript", version: "0.23.2" }] }, diagnostics: vec![] }),
            Request::ExtractPython { request_id, files } => {
                let results: Vec<Result<PythonFacts, Diagnostic>> = files.par_iter().map(extract_file).collect();
                let mut data = vec![]; let mut diagnostics = vec![];
                for result in results { match result { Ok(facts) => data.push(facts), Err(diagnostic) => diagnostics.push(diagnostic) } }
                data.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
                let status = if diagnostics.is_empty() { "ok" } else { "error" };
                let system = sysinfo::System::new_all();
                let rss_bytes = sysinfo::get_current_pid().ok().and_then(|pid| system.process(pid)).map(|process| process.memory()).unwrap_or(0);
                emit(&Response { protocol: PROTOCOL, request_id, status, data: PythonBatch { files: data, rss_bytes }, diagnostics });
            }
            Request::Watch { request_id, root_path } => { watch(request_id, root_path); break; }
            Request::ProbeTypescript { request_id, content } => match probe_typescript(&content) {
                Ok(data) => emit(&Response { protocol: PROTOCOL, request_id, status: "ok", data, diagnostics: vec![] }),
                Err(message) => emit(&Response { protocol: PROTOCOL, request_id, status: "error", data: serde_json::json!({}), diagnostics: vec![Diagnostic { code: "TS_PROBE_FAILED".into(), severity: "error", message, path: None }] }),
            },
        }
    }
}
