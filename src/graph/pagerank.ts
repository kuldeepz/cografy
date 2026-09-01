import type { GraphStore } from "./store.js";

/**
 * Weighted PageRank over the resolved symbol graph (calls/handles/extends/
 * implements). Importance flows from callers to callees, so heavily-depended-on
 * symbols score highest — the same signal aider uses to build a ranked repo map.
 * Edge weights are the resolution confidences, so precise edges count more.
 */
export function computePageRank(
  store: GraphStore,
  opts: { damping?: number; iterations?: number } = {},
): Map<string, number> {
  const damping = opts.damping ?? 0.85;
  const iterations = opts.iterations ?? 25;

  const symbols = store.allNodesOfKinds(["function", "method", "class", "interface", "route"]);
  const ids = symbols.map((s) => s.id);
  const N = ids.length;
  const ranks = new Map<string, number>();
  if (N === 0) return ranks;

  const index = new Map(ids.map((id, i) => [id, i]));
  const edges = store.allEdgesOfKinds(["calls", "handles", "extends", "implements", "references"]);

  // Build weighted adjacency (from -> [{to, w}]) restricted to symbol nodes.
  const out: { to: number; w: number }[][] = Array.from({ length: N }, () => []);
  const outWeight = new Float64Array(N);
  for (const e of edges) {
    const f = index.get(e.fromId);
    const t = index.get(e.toId);
    if (f === undefined || t === undefined) continue;
    const w = e.confidence > 0 ? e.confidence : 0.1;
    out[f].push({ to: t, w });
    outWeight[f] += w;
  }

  let rank = new Float64Array(N).fill(1 / N);
  const base = (1 - damping) / N;

  for (let iter = 0; iter < iterations; iter++) {
    const next = new Float64Array(N).fill(base);
    let dangling = 0;
    for (let i = 0; i < N; i++) {
      if (outWeight[i] === 0) {
        dangling += rank[i];
        continue;
      }
      const share = (damping * rank[i]) / outWeight[i];
      for (const { to, w } of out[i]) next[to] += share * w;
    }
    // redistribute dangling mass uniformly
    const danglingShare = (damping * dangling) / N;
    for (let i = 0; i < N; i++) next[i] += danglingShare;
    rank = next;
  }

  // Normalize to 0..1 for stable downstream blending.
  let max = 0;
  for (let i = 0; i < N; i++) max = Math.max(max, rank[i]);
  const scale = max > 0 ? 1 / max : 1;
  for (let i = 0; i < N; i++) ranks.set(ids[i], rank[i] * scale);
  return ranks;
}
