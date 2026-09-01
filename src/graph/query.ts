import type { CodeEdge, CodeNode } from "../types.js";
import type { GraphStore } from "./store.js";

export interface Subgraph {
  nodes: CodeNode[];
  edges: CodeEdge[];
}

/** Higher-level graph traversals over the store: the "intellect" layer. */
export class GraphQuery {
  constructor(private store: GraphStore) {}

  /** BFS neighborhood around a node up to `depth` hops. */
  neighborhood(id: string, depth = 1, direction: "out" | "in" | "both" = "both"): Subgraph {
    const nodes = new Map<string, CodeNode>();
    const edges = new Map<string, CodeEdge>();
    const start = this.store.getNode(id);
    if (!start) return { nodes: [], edges: [] };
    nodes.set(start.id, start);

    let frontier = [id];
    for (let d = 0; d < depth; d++) {
      const next: string[] = [];
      for (const cur of frontier) {
        const outs = direction !== "in" ? this.store.outgoing(cur) : [];
        const ins = direction !== "out" ? this.store.incoming(cur) : [];
        for (const e of [...outs, ...ins]) {
          edges.set(e.id, e);
          const otherId = e.fromId === cur ? e.toId : e.fromId;
          if (!nodes.has(otherId)) {
            const n = this.store.getNode(otherId);
            if (n) {
              nodes.set(n.id, n);
              next.push(otherId);
            }
          }
        }
      }
      frontier = next;
      if (!frontier.length) break;
    }
    return { nodes: [...nodes.values()], edges: [...edges.values()] };
  }

  /**
   * Trace the execution flow starting from a symbol by name, following `calls`
   * edges. Prefers high-confidence, exactly-resolved edges to avoid merging
   * unrelated same-named methods.
   */
  traceFlow(symbolName: string, maxDepth = 6): { root?: CodeNode; chain: FlowStep[] } {
    const candidates = this.store
      .getNodesByName(symbolName)
      .filter((n) => n.kind === "function" || n.kind === "method" || n.kind === "route");
    if (!candidates.length) return { chain: [] };
    const root = candidates[0];

    const visited = new Set<string>();
    const chain: FlowStep[] = [];
    const walk = (nodeId: string, depth: number) => {
      if (depth > maxDepth || visited.has(nodeId)) return;
      visited.add(nodeId);
      const node = this.store.getNode(nodeId);
      if (!node) return;
      const calls = this.store
        .outgoing(nodeId)
        .filter((e) => e.kind === "calls" || e.kind === "handles")
        .sort((a, b) => b.confidence - a.confidence);
      for (const e of calls) {
        const callee = this.store.getNode(e.toId);
        if (!callee) continue;
        chain.push({ from: node, to: callee, kind: e.kind, confidence: e.confidence, depth });
        walk(callee.id, depth + 1);
      }
    };
    walk(root.id, 0);
    return { root, chain };
  }

  /**
   * Impact / blast-radius analysis: everything that transitively depends on the
   * given symbol (incoming calls/imports/references), i.e. what a change breaks.
   */
  impact(symbolName: string, maxDepth = 4): { target?: CodeNode; dependents: CodeNode[] } {
    const candidates = this.store.getNodesByName(symbolName);
    if (!candidates.length) return { dependents: [] };
    const target = candidates[0];

    const dependents = new Map<string, CodeNode>();
    let frontier = candidates.map((c) => c.id);
    const seen = new Set<string>(frontier);
    for (let d = 0; d < maxDepth; d++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const e of this.store.incoming(id)) {
          if (e.kind !== "calls" && e.kind !== "imports" && e.kind !== "references") continue;
          const dep = this.store.getNode(e.fromId);
          if (dep && !dependents.has(dep.id)) {
            dependents.set(dep.id, dep);
            if (!seen.has(dep.id)) {
              seen.add(dep.id);
              next.push(dep.id);
            }
          }
        }
      }
      frontier = next;
      if (!frontier.length) break;
    }
    return { target, dependents: [...dependents.values()] };
  }

  /** Map of web routes -> their resolved handler symbols. */
  routes(): { route: CodeNode; handler?: CodeNode; confidence: number }[] {
    const routeNodes = this.store.db
      .prepare(`SELECT * FROM nodes WHERE kind = 'route' ORDER BY name`)
      .all() as any[];
    return routeNodes.map((row) => {
      const route = {
        id: row.id,
        kind: row.kind,
        name: row.name,
        filePath: row.file_path,
        language: row.language,
        startLine: row.start_line,
        endLine: row.end_line,
        signature: row.signature ?? undefined,
        snippet: row.snippet ?? undefined,
        meta: row.meta ? JSON.parse(row.meta) : undefined,
      } as CodeNode;
      const handles = this.store.outgoing(route.id).find((e) => e.kind === "handles");
      const handler = handles ? this.store.getNode(handles.toId) : undefined;
      return { route, handler, confidence: handles?.confidence ?? 0 };
    });
  }
}

export interface FlowStep {
  from: CodeNode;
  to: CodeNode;
  kind: string;
  confidence: number;
  depth: number;
}
