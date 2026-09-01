import type { SearchHit } from "../types.js";
import type { GraphStore } from "../graph/store.js";
import { VectorSearch } from "./vector.js";
import type { EmbeddingProvider } from "./embeddings.js";

/**
 * Hybrid retrieval: fuse BM25 (lexical) and vector (semantic) rankings via
 * Reciprocal Rank Fusion, then apply a light graph-centrality boost so
 * well-connected, high-confidence symbols surface first.
 */
export class HybridSearch {
  private vector: VectorSearch;

  constructor(
    private store: GraphStore,
    provider: EmbeddingProvider,
  ) {
    this.vector = new VectorSearch(store, provider);
  }

  async search(query: string, limit = 12): Promise<SearchHit[]> {
    const pool = Math.max(limit * 4, 40);
    const [bm, vec] = await Promise.all([
      Promise.resolve(this.store.bm25(query, pool)),
      this.vector.search(query, pool),
    ]);

    const bmRank = new Map(bm.map((r, i) => [r.id, i]));
    const vecRank = new Map(vec.map((r, i) => [r.id, i]));
    const bmScore = new Map(bm.map((r) => [r.id, r.score]));
    const vecScore = new Map(vec.map((r) => [r.id, r.score]));

    const ids = new Set<string>([...bmRank.keys(), ...vecRank.keys()]);
    const K = 60; // RRF damping
    const fused: { id: string; score: number }[] = [];
    for (const id of ids) {
      const rb = bmRank.has(id) ? 1 / (K + bmRank.get(id)!) : 0;
      const rv = vecRank.has(id) ? 1 / (K + vecRank.get(id)!) : 0;
      fused.push({ id, score: rb + rv });
    }
    fused.sort((a, b) => b.score - a.score);

    const top = fused.slice(0, limit * 2);
    const hits: SearchHit[] = [];
    for (const f of top) {
      const node = this.store.getNode(f.id);
      if (!node || node.kind === "import") continue;
      const degree =
        this.store.outgoing(node.id).length + this.store.incoming(node.id).length;
      const graphBoost = Math.log2(2 + degree) * 0.02;
      // Importance prior from PageRank: depended-on symbols rank higher.
      const rankBoost = this.store.getRank(node.id) * 0.05;
      hits.push({
        node,
        score: f.score + graphBoost + rankBoost,
        bm25: bmScore.get(f.id),
        vector: vecScore.get(f.id),
        graph: graphBoost + rankBoost,
      });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }
}
