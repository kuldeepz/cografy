import type { GraphStore } from "../graph/store.js";
import { cosine, type EmbeddingProvider } from "./embeddings.js";

/** In-memory cosine vector search over stored node embeddings. */
export class VectorSearch {
  constructor(
    private store: GraphStore,
    private provider: EmbeddingProvider,
  ) {}

  async search(query: string, limit: number): Promise<{ id: string; score: number }[]> {
    const [qvec] = await this.provider.embed([query]);
    const all = this.store.allEmbeddings();
    const scored = all.map((e) => ({ id: e.id, score: cosine(qvec, e.vec) }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }
}
