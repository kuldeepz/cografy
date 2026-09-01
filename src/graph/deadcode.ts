import type { CodeNode } from "../types.js";
import type { GraphStore } from "./store.js";

const ENTRY_FILE = /(?:^|\/)(index|main|app|server|cli|__main__|program)\.[A-Za-z]+$/;

/**
 * Reachability-based dead-code detection. Roots are route handlers and entry
 * files; anything reachable from them via calls/handles/extends is "live". A
 * function/method that is neither reachable nor called by anything is reported
 * as a dead-code candidate. Heuristic (dynamic dispatch/reflection can hide
 * real uses), so treat as a hint.
 */
export function findDeadCode(store: GraphStore): CodeNode[] {
  const funcs = store.allNodesOfKinds(["function", "method"]);
  if (!funcs.length) return [];
  const byId = new Map(funcs.map((f) => [f.id, f]));

  const roots = new Set<string>();
  // Route handlers are entry points.
  for (const e of store.allEdgesOfKinds(["handles"])) {
    if (byId.has(e.toId)) roots.add(e.toId);
  }
  // Symbols defined in entry files are entry points.
  for (const f of funcs) {
    if (ENTRY_FILE.test(f.filePath)) roots.add(f.id);
  }

  // BFS reachability along outgoing call/inheritance edges.
  const reachable = new Set<string>(roots);
  let frontier = [...roots];
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const e of store.outgoing(id)) {
        if ((e.kind === "calls" || e.kind === "extends" || e.kind === "implements") && byId.has(e.toId) && !reachable.has(e.toId)) {
          reachable.add(e.toId);
          next.push(e.toId);
        }
      }
    }
    frontier = next;
  }

  const dead: CodeNode[] = [];
  for (const f of funcs) {
    if (reachable.has(f.id)) continue;
    // Constructors/lifecycle are invoked implicitly (new/framework), not by name.
    if (f.name === "constructor" || f.name === "__init__" || f.name === "main") continue;
    const incoming = store
      .incoming(f.id)
      .filter((e) => e.kind === "calls" || e.kind === "handles" || e.kind === "references");
    if (incoming.length === 0) dead.push(f);
  }
  return dead.sort((a, b) => (a.filePath < b.filePath ? -1 : 1));
}
