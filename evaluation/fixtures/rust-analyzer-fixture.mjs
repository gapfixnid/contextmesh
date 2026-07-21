if (process.argv.includes("--version")) {
  process.stdout.write("rust-analyzer deterministic fixture v1\n");
  process.exit(0);
}

let buffer = Buffer.alloc(0);
const documents = new Map();

function send(value) {
  const body = Buffer.from(JSON.stringify(value));
  process.stdout.write(Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),
    body,
  ]));
}

function identifierAt(text, line, character) {
  const sourceLine = text.split(/\r?\n/)[line] ?? "";
  for (const match of sourceLine.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    const start = match.index ?? -1;
    if (start <= character && character <= start + match[0].length) return match[0];
  }
  return null;
}

function definitions(name, preferredUri) {
  const matches = [];
  const expression = new RegExp(`\\bfn\\s+${name}\\b`);
  for (const [uri, text] of documents) {
    const lines = text.split(/\r?\n/);
    const line = lines.findIndex((item) => expression.test(item));
    if (line >= 0) matches.push({ uri, line, character: lines[line].indexOf(name) });
  }
  const local = matches.filter((item) => item.uri === preferredUri);
  return local.length === 1 ? local : matches;
}

function handle(message) {
  if (message.method === "textDocument/didOpen") {
    documents.set(message.params.textDocument.uri, message.params.textDocument.text);
    return;
  }
  if (message.method === "exit") process.exit(0);
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { capabilities: { definitionProvider: true } } });
    return;
  }
  if (message.method === "shutdown") {
    send({ jsonrpc: "2.0", id: message.id, result: null });
    return;
  }
  if (message.method === "textDocument/definition") {
    const uri = message.params.textDocument.uri;
    const text = documents.get(uri) ?? "";
    const name = identifierAt(text, message.params.position.line, message.params.position.character);
    const targets = name ? definitions(name, uri) : [];
    const result = targets.length === 1
      ? { uri: targets[0].uri, range: { start: { line: targets[0].line, character: targets[0].character }, end: { line: targets[0].line, character: targets[0].character + name.length } } }
      : null;
    send({ jsonrpc: "2.0", id: message.id, result });
    return;
  }
  send({ jsonrpc: "2.0", id: message.id, result: null });
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) break;
    const length = Number(buffer.subarray(0, headerEnd).toString().match(/Content-Length:\s*(\d+)/i)?.[1]);
    if (!Number.isSafeInteger(length) || buffer.length < headerEnd + 4 + length) break;
    const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString();
    buffer = buffer.subarray(headerEnd + 4 + length);
    handle(JSON.parse(body));
  }
});
