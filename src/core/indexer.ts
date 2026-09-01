import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { CografyConfig, CodeNode } from "../types.js";
import { effectiveModes } from "../config.js";
import { GraphStore } from "../graph/store.js";
import { resolveAll, ResolutionIndex } from "../graph/resolver.js";
import { computePageRank } from "../graph/pagerank.js";
import { MerkleIndex } from "./merkle.js";
import { scanFiles } from "./scanner.js";
import { ParsePool } from "./pool.js";
import { parseFile } from "../parsers/registry.js";
import { detectLanguage, isAsset } from "../parsers/languages.js";
import {
  LocalEmbeddingProvider,
  textForEmbedding,
  type EmbeddingProvider,
} from "../search/embeddings.js";

export interface IndexStats {
  scanned: number;
  added: number;
  changed: number;
  removed: number;
  embedded: number;
  durationMs: number;
  root: string;
}

/**
 * Orchestrates incremental indexing: hash files, diff against the Merkle index,
 * re-parse only what changed, update the graph store, then link multimodal
 * assets and (re)compute embeddings for new/changed symbols.
 */
export class Indexer {
  private merkle: MerkleIndex;
  private resIndex?: ResolutionIndex;
  private prTimer?: NodeJS.Timeout;

  constructor(
    private config: CografyConfig,
    private store: GraphStore,
    private embeddings: EmbeddingProvider = new LocalEmbeddingProvider(config.embeddingDim),
  ) {
    this.merkle = new MerkleIndex(store.loadLeaves());
  }

  get root(): string {
    return this.config.root;
  }

  setEmbeddings(provider: EmbeddingProvider): void {
    this.embeddings = provider;
  }

  /** Full/incremental index pass over the whole repo. */
  async indexAll(): Promise<IndexStats> {
    const start = Date.now();
    const files = scanFiles(this.config);
    const snapshot = new Map<string, string>();
    for (const rel of files) snapshot.set(rel, this.hashFile(rel));

    const { added, changed, removed } = this.merkle.diff(snapshot);

    for (const rel of removed) {
      this.store.removeFile(rel);
      this.merkle.delete(rel);
    }

    const toIndex = [...added, ...changed];
    const { parsing } = effectiveModes(this.config, files.length);
    if (parsing === "workers" && toIndex.length > 200) {
      await this.indexManyParallel(toIndex, snapshot);
    } else {
      for (const rel of toIndex) await this.indexOne(rel, snapshot.get(rel)!);
    }

    this.linkAssets();
    this.resIndex = resolveAll(this.store);
    this.store.replaceRanks(computePageRank(this.store));
    const embedded = await this.embedPending();

    this.store.setMeta("merkleRoot", this.merkle.root());
    this.store.setMeta("lastIndex", new Date().toISOString());

    return {
      scanned: files.length,
      added: added.length,
      changed: changed.length,
      removed: removed.length,
      embedded,
      durationMs: Date.now() - start,
      root: this.config.root,
    };
  }

  /** Re-index a single file (used by the watcher). */
  async indexFile(rel: string): Promise<void> {
    let hash: string;
    try {
      hash = this.hashFile(rel);
    } catch {
      this.removeFile(rel);
      return;
    }
    if (!this.merkle.set(rel, hash)) return; // unchanged
    await this.indexOne(rel, hash);
    this.linkAssets();
    this.reResolveIncremental(rel);
    this.schedulePageRank();
    await this.embedFile(rel);
  }

  removeFile(rel: string): void {
    this.store.removeFile(rel);
    this.merkle.delete(rel);
    this.reResolveIncremental(rel);
    this.schedulePageRank();
  }

  /** Re-resolve only the files affected by a single-file change. */
  private reResolveIncremental(rel: string): void {
    if (!this.resIndex) {
      this.resIndex = resolveAll(this.store);
      return;
    }
    const affected = this.resIndex.updateFile(this.store, rel);
    this.resIndex.resolveFiles(this.store, affected);
  }

  /** Debounced PageRank recompute so ranks refresh without blocking every save. */
  private schedulePageRank(delay = 1500): void {
    if (this.prTimer) clearTimeout(this.prTimer);
    this.prTimer = setTimeout(() => {
      this.store.replaceRanks(computePageRank(this.store));
    }, delay);
    this.prTimer.unref?.();
  }

  private async indexOne(rel: string, hash: string): Promise<void> {
    const source = this.readSource(rel);
    if (source === null) return;
    const result = await parseFile(rel, source);
    this.writeParsed(rel, hash, result);
  }

  /** Parse many files across a worker pool, then write results serially. */
  private async indexManyParallel(files: string[], snapshot: Map<string, string>): Promise<void> {
    const pool = new ParsePool();
    try {
      const jobs = files.map(async (rel) => {
        const source = this.readSource(rel);
        if (source === null) return;
        let result = await pool.parse(rel, source);
        if (!result) result = await parseFile(rel, source); // worker failed → inline fallback
        this.writeParsed(rel, snapshot.get(rel)!, result);
      });
      await Promise.all(jobs);
    } finally {
      await pool.close();
    }
  }

  private readSource(rel: string): string | null {
    try {
      return isAsset(rel) ? this.readAsset(rel) : readFileSync(this.abs(rel), "utf8");
    } catch {
      return null;
    }
  }

  private writeParsed(rel: string, hash: string, result: import("../types.js").ParseResult): void {
    this.store.replaceFileGraph(rel, result.nodes, result.edges);
    this.store.replaceFileCallSites(rel, result.callSites ?? []);
    const st = statSync(this.abs(rel));
    this.store.upsertFile({
      path: rel,
      hash,
      size: st.size,
      mtimeMs: st.mtimeMs,
      language: detectLanguage(rel),
    });
    this.merkle.set(rel, hash);
  }

  /**
   * Link text assets (markdown/docs) to code symbols they mention by name,
   * creating `documents` edges — the multimodal context bridge.
   */
  private linkAssets(): void {
    const assets = this.store.db
      .prepare(`SELECT id, snippet, meta FROM nodes WHERE kind = 'asset'`)
      .all() as { id: string; snippet: string | null; meta: string | null }[];
    if (!assets.length) return;

    const symbolNames = this.store.db
      .prepare(
        `SELECT DISTINCT name FROM nodes WHERE kind IN ('function','method','class','interface') AND length(name) > 3`,
      )
      .all() as { name: string }[];
    const nameSet = new Map(symbolNames.map((s) => [s.name.toLowerCase(), s.name]));

    const insEdge = this.store.db.prepare(
      `INSERT OR REPLACE INTO edges (id, kind, from_id, to_id, confidence, file_path, meta)
       VALUES (?, 'documents', ?, ?, 0.7, ?, NULL)`,
    );
    const findNodes = this.store.db.prepare(`SELECT id, file_path FROM nodes WHERE name = ?`);

    for (const asset of assets) {
      const text = (asset.snippet ?? "").toLowerCase();
      if (!text) continue;
      const mentioned = new Set<string>();
      for (const word of text.split(/[^A-Za-z0-9_]+/)) {
        const real = nameSet.get(word.toLowerCase());
        if (real) mentioned.add(real);
      }
      for (const name of mentioned) {
        const targets = findNodes.all(name) as { id: string; file_path: string }[];
        for (const t of targets) {
          const edgeId = createHash("sha1")
            .update(`documents${asset.id}${t.id}`)
            .digest("hex")
            .slice(0, 20);
          insEdge.run(edgeId, asset.id, t.id, asset.id);
        }
      }
    }
  }

  private async embedPending(): Promise<number> {
    return this.embedNodes(this.store.allNodesMissingEmbedding());
  }

  private async embedFile(rel: string): Promise<number> {
    return this.embedNodes(this.store.nodesMissingEmbeddingForFile(rel));
  }

  private async embedNodes(pending: CodeNode[]): Promise<number> {
    if (!pending.length) return 0;
    const batchSize = 128;
    for (let i = 0; i < pending.length; i += batchSize) {
      const batch = pending.slice(i, i + batchSize);
      const texts = batch.map((n) => textForEmbedding(n.name, n.signature, n.snippet));
      const vecs = await this.embeddings.embed(texts);
      for (let j = 0; j < batch.length; j++) {
        this.store.storeEmbedding(batch[j].id, vecs[j]);
      }
    }
    return pending.length;
  }

  private hashFile(rel: string): string {
    const buf = readFileSync(this.abs(rel));
    return createHash("sha1").update(buf).digest("hex");
  }

  private readAsset(rel: string): string {
    // Only text-like assets are read as text; binaries contribute a name-only node.
    if (/\.(md|mdx|rst|txt)$/i.test(rel)) return readFileSync(this.abs(rel), "utf8");
    return "";
  }

  private abs(rel: string): string {
    return join(this.config.root, rel);
  }
}
