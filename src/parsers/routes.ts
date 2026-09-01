import type { CodeNode } from "../types.js";
import { nodeId } from "../core/hasher.js";

const ROUTE_PATTERNS: { re: RegExp; methodIdx: number; pathIdx: number }[] = [
  {
    re: /\b(?:app|router|api|server|route[r]?)\.(get|post|put|patch|delete|options|head|all)\s*\(\s*['"`]([^'"`]+)['"`]/,
    methodIdx: 1,
    pathIdx: 2,
  },
  {
    re: /@\w+\.(get|post|put|patch|delete|route)\s*\(\s*['"`]([^'"`]+)['"`]/,
    methodIdx: 1,
    pathIdx: 2,
  },
  {
    re: /@(Get|Post|Put|Patch|Delete|Request)Mapping\s*\(\s*(?:value\s*=\s*)?['"]([^'"]+)['"]/,
    methodIdx: 1,
    pathIdx: 2,
  },
];

/** Language-agnostic web-route detection with best-effort handler-name capture. */
export function extractRoutes(filePath: string, source: string, language: string): CodeNode[] {
  const lines = source.split(/\r?\n/);
  const routes: CodeNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const rp of ROUTE_PATTERNS) {
      const m = rp.re.exec(line);
      if (!m) continue;
      const method = (m[rp.methodIdx] ?? "get").toUpperCase();
      const path = m[rp.pathIdx];
      const handlerName = extractHandlerName(line, lines, i);
      routes.push({
        id: nodeId(filePath, "route", `${method} ${path}`, i + 1),
        kind: "route",
        name: `${method} ${path}`,
        filePath,
        language,
        startLine: i + 1,
        endLine: i + 1,
        signature: line.trim().slice(0, 200),
        meta: { method, path, handlerName },
      });
    }
  }
  return routes;
}

function extractHandlerName(
  line: string,
  lines: string[],
  idx: number,
): string | undefined {
  // inline: app.get('/x', handler) or app.get('/x', ctrl.method)
  const m = /,\s*([A-Za-z_$][\w$.]*)\s*\)?\s*;?\s*$/.exec(line);
  if (m) return m[1].split(".").pop();
  // decorator style: handler is the function defined on the next non-empty line
  for (let j = idx + 1; j < Math.min(idx + 4, lines.length); j++) {
    const d = /(?:def|function|async def|fn)\s+([A-Za-z_$][\w$]*)/.exec(lines[j]);
    if (d) return d[1];
  }
  return undefined;
}
