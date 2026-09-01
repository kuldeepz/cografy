import { createRequire } from "node:module";
import { dirname, join, extname } from "node:path";
import TreeSitter from "web-tree-sitter";
import type { CallSite, CodeEdge, CodeNode, ParseResult } from "../types.js";
import { nodeId, edgeId } from "../core/hasher.js";
import { extractRoutes } from "./routes.js";

// web-tree-sitter@0.24 ships a default-exported Parser class with a Language namespace.
const Parser: any = (TreeSitter as any).default ?? TreeSitter;

const require = createRequire(import.meta.url);
const WASM_DIR = join(dirname(require.resolve("tree-sitter-wasms/package.json")), "out");

/** Our language name (+ file extension) -> tree-sitter-wasms grammar file stem. */
function grammarName(language: string, filePath: string): string | undefined {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".tsx") return "tsx";
  if (ext === ".jsx") return "javascript";
  const map: Record<string, string> = {
    typescript: "typescript",
    javascript: "javascript",
    python: "python",
    go: "go",
    rust: "rust",
    java: "java",
    kotlin: "kotlin",
    csharp: "c_sharp",
    ruby: "ruby",
    php: "php",
    c: "c",
    cpp: "cpp",
    swift: "swift",
    scala: "scala",
    lua: "lua",
    dart: "dart",
    vue: "vue",
  };
  return map[language];
}

const CLASS_TYPES = new Set([
  "class_declaration",
  "class_definition",
  "class_specifier",
  "interface_declaration",
  "type_alias_declaration",
  "struct_item",
  "trait_item",
  "impl_item",
  "enum_item",
  "enum_declaration",
  "object_declaration",
  "record_declaration",
]);

const INTERFACE_TYPES = new Set(["interface_declaration", "trait_item", "protocol_declaration"]);

const FUNC_TYPES = new Set([
  "function_declaration",
  "function_definition",
  "function_item",
  "method_definition",
  "method_declaration",
  "constructor_declaration",
  "local_function_statement",
  "function",
]);

const ANON_FUNC_TYPES = new Set(["arrow_function", "function_expression", "lambda"]);

const CALL_TYPES = new Set([
  "call_expression",
  "call",
  "method_invocation",
  "function_call_expression",
  "member_call_expression",
  "scoped_call_expression",
  "invocation_expression",
]);

const IMPORT_TYPES = new Set([
  "import_statement",
  "import_from_statement",
  "import_declaration",
  "use_declaration",
  "using_directive",
  "require",
]);

let initPromise: Promise<void> | null = null;
const languageCache = new Map<string, any>();
const failed = new Set<string>();

async function ensureInit(): Promise<void> {
  if (!initPromise) initPromise = Parser.init();
  await initPromise;
}

async function loadLanguage(grammar: string): Promise<any | undefined> {
  if (languageCache.has(grammar)) return languageCache.get(grammar);
  if (failed.has(grammar)) return undefined;
  try {
    const lang = await Parser.Language.load(join(WASM_DIR, `tree-sitter-${grammar}.wasm`));
    languageCache.set(grammar, lang);
    return lang;
  } catch {
    failed.add(grammar);
    return undefined;
  }
}

/**
 * Precise, AST-based extractor built on tree-sitter. Produces class-scoped
 * symbol names (so `A.getName` and `B.getName` are distinct), exact line
 * boundaries, import nodes, and unresolved call sites for the cross-file
 * resolver. Returns null if no grammar is available so the caller can fall back
 * to the heuristic parser.
 */
export async function treeSitterParse(
  filePath: string,
  source: string,
  language: string,
): Promise<ParseResult | null> {
  const grammar = grammarName(language, filePath);
  if (!grammar) return null;
  await ensureInit();
  const lang = await loadLanguage(grammar);
  if (!lang) return null;

  let tree: any;
  try {
    const parser = new Parser();
    parser.setLanguage(lang);
    tree = parser.parse(source);
  } catch {
    return null;
  }
  if (!tree?.rootNode) return null;

  const nodes: CodeNode[] = [];
  const edges: CodeEdge[] = [];
  const callSites: CallSite[] = [];

  const fileNode: CodeNode = {
    id: nodeId(filePath, "file", filePath, 0),
    kind: "file",
    name: filePath,
    filePath,
    language,
    startLine: 1,
    endLine: source.split(/\r?\n/).length,
  };
  nodes.push(fileNode);

  const classScope: { name: string }[] = [];
  const funcScope: CodeNode[] = [];

  const visit = (node: any): void => {
    const type: string = node.type;
    let pushedClass = false;
    let pushedFunc = false;
    let defNode: CodeNode | undefined;

    if (CLASS_TYPES.has(type)) {
      const name = extractName(node, type);
      if (name) {
        const kind = INTERFACE_TYPES.has(type) ? "interface" : "class";
        defNode = makeNode(filePath, language, kind, name, node, classScope.at(-1)?.name);
        nodes.push(defNode);
        edges.push(edge("contains", fileNode.id, defNode.id, 1.0));
        addInheritanceEdges(node, defNode, edges);
        classScope.push({ name });
        pushedClass = true;
      }
    } else if (FUNC_TYPES.has(type)) {
      const name = extractName(node, type);
      if (name) {
        const parent = classScope.at(-1)?.name;
        const kind = parent ? "method" : "function";
        defNode = makeNode(filePath, language, kind, name, node, parent);
        nodes.push(defNode);
        edges.push(edge("contains", fileNode.id, defNode.id, 1.0));
        funcScope.push(defNode);
        pushedFunc = true;
      }
    } else if (ANON_FUNC_TYPES.has(type)) {
      const name = nameFromAssignment(node);
      if (name) {
        const parent = classScope.at(-1)?.name;
        defNode = makeNode(filePath, language, "function", name, node, parent);
        nodes.push(defNode);
        edges.push(edge("contains", fileNode.id, defNode.id, 1.0));
        funcScope.push(defNode);
        pushedFunc = true;
      }
    } else if (CALL_TYPES.has(type)) {
      const caller = funcScope.at(-1);
      if (caller) {
        const callee = extractCallee(node);
        if (callee?.name) {
          callSites.push({
            callerId: caller.id,
            calleeName: callee.name,
            receiver: callee.receiver,
            filePath,
            line: node.startPosition.row + 1,
          });
        }
      }
    } else if (IMPORT_TYPES.has(type)) {
      const spec = extractImportSpecifier(node);
      if (spec) {
        const impNode: CodeNode = {
          id: nodeId(filePath, "import", spec, node.startPosition.row + 1),
          kind: "import",
          name: spec,
          filePath,
          language,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          signature: node.text.slice(0, 200),
        };
        nodes.push(impNode);
        edges.push(edge("imports", fileNode.id, impNode.id, 1.0));
      }
    }

    for (let i = 0; i < node.namedChildCount; i++) visit(node.namedChild(i));

    if (pushedClass) classScope.pop();
    if (pushedFunc) funcScope.pop();
  };

  visit(tree.rootNode);

  // Language-agnostic route detection (framework calls the AST doesn't label).
  for (const r of extractRoutes(filePath, source, language)) {
    nodes.push(r);
    edges.push(edge("contains", fileNode.id, r.id, 1.0));
  }

  tree.delete?.();
  return { filePath, language, nodes, edges, callSites };
}

function makeNode(
  filePath: string,
  language: string,
  kind: CodeNode["kind"],
  name: string,
  node: any,
  parent?: string,
): CodeNode {
  const startLine = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;
  const text: string = node.text ?? "";
  const firstLine = text.split("\n", 1)[0].slice(0, 200);
  const snippet = capSnippet(text);
  return {
    id: nodeId(filePath, kind, parent ? `${parent}.${name}` : name, startLine),
    kind,
    name,
    filePath,
    language,
    startLine,
    endLine,
    signature: firstLine,
    snippet,
    meta: parent ? { parent } : undefined,
  };
}

function capSnippet(text: string): string {
  const lines = text.split("\n");
  return lines.length > 60 ? lines.slice(0, 60).join("\n") + "\n// … truncated …" : text;
}

function extractName(node: any, type: string): string | undefined {
  if (type === "impl_item") {
    const t = node.childForFieldName?.("type");
    if (t) return t.text;
  }
  const nameField = node.childForFieldName?.("name");
  if (nameField?.text) return nameField.text;
  // fallback: first identifier-like named child
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (/identifier|constant|name/.test(c.type)) return c.text;
  }
  return undefined;
}

function nameFromAssignment(node: any): string | undefined {
  // const foo = () => {}  |  foo: () => {}  |  foo = function(){}
  const parent = node.parent;
  if (!parent) return undefined;
  if (parent.type === "variable_declarator" || parent.type === "assignment_expression") {
    const n = parent.childForFieldName?.("name") ?? parent.childForFieldName?.("left");
    if (n?.text && /^[A-Za-z_$][\w$]*$/.test(n.text)) return n.text;
  }
  if (parent.type === "pair" || parent.type === "property") {
    const k = parent.childForFieldName?.("key") ?? parent.childForFieldName?.("name");
    if (k?.text && /^[A-Za-z_$][\w$]*$/.test(k.text)) return k.text;
  }
  return undefined;
}

function extractCallee(node: any): { name: string; receiver?: string } | undefined {
  // Java: method_invocation has name/object fields.
  if (node.type === "method_invocation") {
    const name = node.childForFieldName?.("name")?.text;
    const receiver = node.childForFieldName?.("object")?.text;
    return name ? { name, receiver } : undefined;
  }
  const fn = node.childForFieldName?.("function") ?? node.namedChild(0);
  if (!fn) return undefined;
  if (/^identifier$/.test(fn.type)) return { name: fn.text };
  // member/attribute/selector access
  if (/member_expression|attribute|selector_expression|member_access_expression|scoped_identifier|field_expression/.test(fn.type)) {
    const prop =
      fn.childForFieldName?.("property") ??
      fn.childForFieldName?.("attribute") ??
      fn.childForFieldName?.("field") ??
      fn.childForFieldName?.("name");
    const recv =
      fn.childForFieldName?.("object") ??
      fn.childForFieldName?.("operand") ??
      fn.childForFieldName?.("argument");
    if (prop?.text) return { name: prop.text, receiver: recv?.text };
  }
  // fallback: rightmost identifier token
  const ids = fn.text.match(/[A-Za-z_$][\w$]*/g);
  if (ids?.length) return { name: ids[ids.length - 1], receiver: ids.length > 1 ? ids[ids.length - 2] : undefined };
  return undefined;
}

function extractImportSpecifier(node: any): string | undefined {
  // Prefer a quoted module string; else a dotted/scoped path; else raw text.
  const findString = (n: any): string | undefined => {
    if (/string|string_literal|interpreted_string_literal/.test(n.type)) {
      return n.text.replace(/^['"`]|['"`]$/g, "");
    }
    for (let i = 0; i < n.namedChildCount; i++) {
      const r = findString(n.namedChild(i));
      if (r) return r;
    }
    return undefined;
  };
  const str = findString(node);
  if (str) return str;
  const mod =
    node.childForFieldName?.("module_name")?.text ??
    node.childForFieldName?.("name")?.text;
  if (mod) return mod;
  return node.text.replace(/^(import|from|use|using|require)\s+/, "").slice(0, 120).trim() || undefined;
}

function addInheritanceEdges(node: any, defNode: CodeNode, edges: CodeEdge[]): void {
  // Record superclass/interface names as low-confidence edges; the resolver
  // upgrades them once target ids are known. We only stash names in meta here.
  const supers: string[] = [];
  const collect = (fieldName: string) => {
    const f = node.childForFieldName?.(fieldName);
    if (f) for (const id of f.text.match(/[A-Za-z_][\w]*/g) ?? []) supers.push(id);
  };
  collect("superclass");
  collect("interfaces");
  collect("bases");
  if (supers.length) {
    defNode.meta = { ...(defNode.meta ?? {}), supers };
  }
}

function edge(kind: CodeEdge["kind"], fromId: string, toId: string, confidence: number): CodeEdge {
  return { id: edgeId(kind, fromId, toId), kind, fromId, toId, confidence };
}
