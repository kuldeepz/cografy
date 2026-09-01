import type { LanguageParser } from "./base.js";
import type { CallSite, CodeEdge, CodeNode, ParseResult } from "../types.js";
import { nodeId, edgeId } from "../core/hasher.js";
import { extractRoutes } from "./routes.js";

/**
 * Dependency-free fallback parser for languages without a tree-sitter grammar.
 * Emits the same contract as the tree-sitter parser: symbol nodes (class-scoped),
 * import nodes, route nodes, and unresolved call sites. It does NOT emit final
 * calls/handles/extends edges — the cross-file resolver owns those so precision
 * is consistent across both parsers.
 */

interface RawSymbol {
  kind: CodeNode["kind"];
  name: string;
  startLine: number;
  endLine: number;
  signature: string;
  parent?: string;
  supers?: string[];
}

const CLASS_RE =
  /^\s*(?:export\s+|public\s+|private\s+|internal\s+|abstract\s+|final\s+|sealed\s+|data\s+)*(class|interface|struct|trait|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/;
const EXTENDS_RE = /\bextends\s+([A-Za-z_][A-Za-z0-9_.,\s]*?)(?:\s+implements|\s*\{|$)/;
const IMPLEMENTS_RE = /\bimplements\s+([A-Za-z_][A-Za-z0-9_.,\s]*?)(?:\s*\{|$)/;
const PY_CLASS_RE = /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(([^)]*)\))?\s*:/;

const FUNC_PATTERNS: RegExp[] = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?\(?[^=]*=>/,
  /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*[(:]/,
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)\s*\(/,
  /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)\s*[(<]/,
  /^\s*(?:public|private|protected|internal|static|final|override|virtual|async|fun|suspend|\s)+[A-Za-z_<>\[\].,\s]*?\b([A-Za-z_][\w]*)\s*\([^;]*\)\s*(?::\s*[^;{=]+)?\s*(?:\{|=>|throws|where|$)/,
  /^\s+(?:async\s+|get\s+|set\s+|static\s+|\*\s*)*([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*:\s*[^;{=]+\{/,
];

const IMPORT_PATTERNS: RegExp[] = [
  /^\s*import\s+.*?from\s+['"]([^'"]+)['"]/,
  /^\s*import\s+['"]([^'"]+)['"]/,
  /^\s*(?:from\s+([A-Za-z_][\w.]*)\s+import|import\s+([A-Za-z_][\w.]*))/,
  /^\s*(?:require|use)\s+['"]([^'"]+)['"]/,
  /^\s*import\s+"([^"]+)"/,
  /^\s*use\s+([A-Za-z_][\w:]+)/,
  /^\s*import\s+([A-Za-z_][\w.]+)\s*;?/,
  /^\s*using\s+([A-Za-z_][\w.]+)\s*;/,
];

const KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "function", "class", "new",
  "typeof", "await", "yield", "super", "this", "def", "elif", "with", "print",
  "console", "require", "import", "export", "const", "let", "var",
]);

function indentOf(line: string): number {
  const m = line.match(/^(\s*)/);
  return m ? m[1].replace(/\t/g, "  ").length : 0;
}

function findBlockEnd(lines: string[], start: number, indentBased: boolean): number {
  if (indentBased) {
    const baseIndent = indentOf(lines[start]);
    for (let i = start + 1; i < lines.length; i++) {
      if (lines[i].trim() === "") continue;
      if (indentOf(lines[i]) <= baseIndent) return i - 1;
    }
    return lines.length - 1;
  }
  let depth = 0;
  let seen = false;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") {
        depth++;
        seen = true;
      } else if (ch === "}") {
        depth--;
        if (seen && depth <= 0) return i;
      }
    }
    if (!seen && i === start && /=>\s*[^{].*$/.test(lines[i])) return i;
  }
  return Math.min(start + 40, lines.length - 1);
}

export class UniversalParser implements LanguageParser {
  languages: "*" = "*";

  parse(filePath: string, source: string, language: string): ParseResult {
    const lines = source.split(/\r?\n/);
    const indentBased = language === "python" || language === "ruby";
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
      endLine: lines.length,
    };
    nodes.push(fileNode);

    const symbols: RawSymbol[] = [];
    const classStack: { name: string; endLine: number }[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNo = i + 1;
      while (classStack.length && lineNo > classStack[classStack.length - 1].endLine) {
        classStack.pop();
      }
      const parent = classStack.length ? classStack[classStack.length - 1].name : undefined;

      const pyClass = indentBased ? PY_CLASS_RE.exec(line) : null;
      const genClass = !pyClass ? CLASS_RE.exec(line) : null;
      if (pyClass || genClass) {
        const name = pyClass ? pyClass[1] : genClass![2];
        const kind: CodeNode["kind"] =
          genClass && genClass[1] === "interface" ? "interface" : "class";
        const end = findBlockEnd(lines, i, indentBased) + 1;
        const supers: string[] = [];
        if (pyClass && pyClass[2]) supers.push(...pyClass[2].split(",").map((s) => s.trim()).filter(Boolean));
        const extM = EXTENDS_RE.exec(line);
        if (extM) supers.push(...extM[1].split(",").map((s) => s.trim()).filter(Boolean));
        const impM = IMPLEMENTS_RE.exec(line);
        if (impM) supers.push(...impM[1].split(",").map((s) => s.trim()).filter(Boolean));
        symbols.push({ kind, name, startLine: lineNo, endLine: end, signature: line.trim().slice(0, 200), supers });
        classStack.push({ name, endLine: end });
        continue;
      }

      let fname: string | undefined;
      for (const re of FUNC_PATTERNS) {
        const m = re.exec(line);
        if (m && m[1] && !KEYWORDS.has(m[1])) {
          fname = m[1];
          break;
        }
      }
      if (fname) {
        const end = findBlockEnd(lines, i, indentBased) + 1;
        symbols.push({
          kind: parent ? "method" : "function",
          name: fname,
          startLine: lineNo,
          endLine: end,
          signature: line.trim().slice(0, 200),
          parent,
        });
      }

      for (const re of IMPORT_PATTERNS) {
        const m = re.exec(line);
        if (m) {
          const target = (m[1] ?? m[2])?.trim();
          if (target) {
            const impNode: CodeNode = {
              id: nodeId(filePath, "import", target, lineNo),
              kind: "import",
              name: target,
              filePath,
              language,
              startLine: lineNo,
              endLine: lineNo,
              signature: line.trim().slice(0, 200),
            };
            nodes.push(impNode);
            edges.push(edge("imports", fileNode.id, impNode.id, 1.0));
          }
          break;
        }
      }
    }

    // Materialize symbol nodes + contains edges + snippets.
    for (const s of symbols) {
      const snippet = lines
        .slice(s.startLine - 1, Math.min(s.endLine, s.startLine - 1 + 60))
        .join("\n");
      const meta: Record<string, unknown> = {};
      if (s.parent) meta.parent = s.parent;
      if (s.supers && s.supers.length) meta.supers = s.supers;
      const node: CodeNode = {
        id: nodeId(filePath, s.kind, s.parent ? `${s.parent}.${s.name}` : s.name, s.startLine),
        kind: s.kind,
        name: s.name,
        filePath,
        language,
        startLine: s.startLine,
        endLine: s.endLine,
        signature: s.signature,
        snippet,
        meta: Object.keys(meta).length ? meta : undefined,
      };
      nodes.push(node);
      edges.push(edge("contains", fileNode.id, node.id, 1.0));
    }

    // Call sites: scan each function body for `recv.callee(` / `callee(`.
    const funcNodes = nodes.filter((n) => n.kind === "function" || n.kind === "method");
    for (const f of funcNodes) {
      const body = lines.slice(f.startLine - 1, f.endLine).join("\n");
      const seen = new Set<string>();
      for (const m of body.matchAll(/(?:([A-Za-z_$][\w$]*)\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\(/g)) {
        const receiver = m[1];
        const callee = m[2];
        if (callee === f.name || KEYWORDS.has(callee)) continue;
        const key = `${receiver ?? ""}.${callee}`;
        if (seen.has(key)) continue;
        seen.add(key);
        callSites.push({ callerId: f.id, calleeName: callee, receiver, filePath, line: f.startLine });
      }
    }

    // Routes (shared, language-agnostic).
    for (const r of extractRoutes(filePath, source, language)) {
      nodes.push(r);
      edges.push(edge("contains", fileNode.id, r.id, 1.0));
    }

    return { filePath, language, nodes, edges, callSites };
  }
}

function edge(kind: CodeEdge["kind"], fromId: string, toId: string, confidence: number): CodeEdge {
  return { id: edgeId(kind, fromId, toId), kind, fromId, toId, confidence };
}
