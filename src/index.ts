import type {
  CografyConfig,
  ContextBundle,
  CodeNode,
  SearchHit,
} from "./types.js";
import { resolveConfig } from "./config.js";
import { GraphStore } from "./graph/store.js";
import { GraphQuery, type Subgraph, type FlowStep } from "./graph/query.js";
import { findDeadCode } from "./graph/deadcode.js";
import { buildGraphData, renderHtml, renderHtmlInline, renderDot, type ExportOptions, type GraphData } from "./graph/export.js";
import { Indexer, type IndexStats } from "./core/indexer.js";
import { Watcher } from "./core/watcher.js";
import { HybridSearch } from "./search/hybrid.js";
import {
  LocalEmbeddingProvider,
  type EmbeddingProvider,
} from "./search/embeddings.js";
import { createEmbeddingProvider } from "./search/providers.js";
import { packContext, type ContextFormat } from "./context/budget.js";

export * from "./types.js";
export { resolveConfig } from "./config.js";
export { GraphStore } from "./graph/store.js";
export { GraphQuery } from "./graph/query.js";
export { Indexer } from "./core/indexer.js";
export { Watcher } from "./core/watcher.js";
export { HybridSearch } from "./search/hybrid.js";
export { packContext } from "./context/budget.js";
export { buildGraphData, renderHtml, renderHtmlInline, renderDot } from "./graph/export.js";

export interface EngineOptions extends Partial<CografyConfig> {
  embeddingProvider?: EmbeddingProvider;
}

/**
 * Cografy — the unified engine. Combines:
 *  - real-time incremental indexing (Merkle + file watcher),
 *  - a resolved code graph (nodes/edges, routes, call/impact tracing),
 *  - hybrid BM25 + vector retrieval,
 *  - a token-budgeted context gateway.
 */
export class Cografy {
  readonly config: CografyConfig;
  readonly store: GraphStore;
  readonly query: GraphQuery;
  readonly indexer: Indexer;
  search: HybridSearch;
  private embeddings: EmbeddingProvider;
  private watcher?: Watcher;
  private providerReady = false;
  private explicitProvider: boolean;

  constructor(root: string, options: EngineOptions = {}) {
    this.config = resolveConfig(root, options);
    this.store = new GraphStore(this.config.dbPath);
    this.explicitProvider = !!options.embeddingProvider;
    this.embeddings =
      options.embeddingProvider ?? new LocalEmbeddingProvider(this.config.embeddingDim);
    this.indexer = new Indexer(this.config, this.store, this.embeddings);
    this.query = new GraphQuery(this.store);
    this.search = new HybridSearch(this.store, this.embeddings);
  }

  /**
   * Resolve the configured embedding provider (local | transformers | ollama)
   * once. If the provider changed since the last run, stored embeddings are
   * cleared so they get recomputed with the new model.
   */
  private async ensureProvider(): Promise<void> {
    if (this.providerReady || this.explicitProvider) {
      this.providerReady = true;
      return;
    }
    const { provider, signature } = await createEmbeddingProvider(
      this.config.embeddingDim,
      this.config.embeddings,
    );
    const prev = this.store.getMeta("embedSignature");
    if (prev && prev !== signature) this.store.clearEmbeddings();
    this.store.setMeta("embedSignature", signature);
    this.embeddings = provider;
    this.indexer.setEmbeddings(provider);
    this.search = new HybridSearch(this.store, provider);
    this.providerReady = true;
  }

  async index(): Promise<IndexStats> {
    await this.ensureProvider();
    return this.indexer.indexAll();
  }

  startWatch(onChange?: (s: { upserts: number; removes: number }) => void): void {
    if (this.watcher) return;
    this.watcher = new Watcher(this.config, this.indexer, onChange);
    this.watcher.start();
  }

  async stopWatch(): Promise<void> {
    await this.watcher?.stop();
    this.watcher = undefined;
  }

  find(query: string, limit = 12): Promise<SearchHit[]> {
    return this.searchReady().then((s) => s.search(query, limit));
  }

  private async searchReady(): Promise<HybridSearch> {
    await this.ensureProvider();
    return this.search;
  }

  async context(
    query: string,
    opts: { budget?: number; format?: ContextFormat; limit?: number } = {},
  ): Promise<ContextBundle> {
    await this.ensureProvider();
    const hits = await this.search.search(query, opts.limit ?? 16);
    return packContext(query, hits, {
      tokenBudget: opts.budget ?? this.config.tokenBudget,
      format: opts.format ?? "markdown",
    });
  }

  /** Ranked repo map: the most important symbols by PageRank. */
  importantSymbols(limit = 25): { node: CodeNode; rank: number }[] {
    const symbols = this.store.allNodesOfKinds(["function", "method", "class", "interface"]);
    return symbols
      .map((node) => ({ node, rank: this.store.getRank(node.id) }))
      .sort((a, b) => b.rank - a.rank)
      .slice(0, limit);
  }

  /** Dead-code candidates: unreachable, uncalled functions/methods. */
  deadCode(): CodeNode[] {
    return findDeadCode(this.store);
  }

  /** Visualization payload; render with renderHtml/renderDot. */
  graphData(opts: ExportOptions = {}): GraphData {
    return buildGraphData(this.store, opts);
  }

  /** Render an interactive HTML graph (or DOT). */
  renderGraph(opts: ExportOptions & { format?: "html" | "dot" | "json" } = {}): string {
    const data = buildGraphData(this.store, opts);
    if (opts.format === "dot") return renderDot(data);
    if (opts.format === "json") return JSON.stringify(data, null, 2);
    const title = `Cografy — ${this.config.root}`;
    return this.config.viewer === "cdn" ? renderHtml(data, title) : renderHtmlInline(data, title);
  }

  traceFlow(symbol: string): { root?: import("./types.js").CodeNode; chain: FlowStep[] } {
    return this.query.traceFlow(symbol);
  }

  impact(symbol: string) {
    return this.query.impact(symbol);
  }

  routes() {
    return this.query.routes();
  }

  neighborhood(symbolOrId: string, depth = 1): Subgraph {
    const direct = this.store.getNode(symbolOrId);
    if (direct) return this.query.neighborhood(direct.id, depth);
    const byName = this.store.getNodesByName(symbolOrId);
    if (byName.length) return this.query.neighborhood(byName[0].id, depth);
    return { nodes: [], edges: [] };
  }

  stats() {
    return {
      ...this.store.stats(),
      merkleRoot: this.store.getMeta("merkleRoot"),
      lastIndex: this.store.getMeta("lastIndex"),
      root: this.config.root,
    };
  }

  /** Call-graph resolution quality metrics. */
  metrics() {
    return {
      ...this.store.stats(),
      callGraph: this.store.callGraphMetrics(),
      embedProvider: this.store.getMeta("embedSignature") ?? "local",
    };
  }

  close(): void {
    this.store.close();
  }
}
