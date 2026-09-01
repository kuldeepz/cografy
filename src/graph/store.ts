import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CallSite, CodeEdge, CodeNode, IndexedFile } from "../types.js";

/**
 * Embedded graph + search store backed by SQLite. Holds the code graph
 * (nodes/edges), an FTS5 index for BM25 keyword search, and a vector table for
 * semantic search. No external server required.
 */
export class GraphStore {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime REAL NOT NULL,
        language TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        language TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        signature TEXT,
        snippet TEXT,
        meta TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(file_path);
      CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
      CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);

      CREATE TABLE IF NOT EXISTS edges (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1.0,
        file_path TEXT NOT NULL,
        meta TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id);
      CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_id);
      CREATE INDEX IF NOT EXISTS idx_edges_file ON edges(file_path);

      CREATE TABLE IF NOT EXISTS embeddings (
        node_id TEXT PRIMARY KEY,
        dim INTEGER NOT NULL,
        vec BLOB NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
        id UNINDEXED,
        name,
        signature,
        snippet,
        tokenize = 'porter unicode61'
      );

      CREATE TABLE IF NOT EXISTS call_sites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        caller_id TEXT NOT NULL,
        callee_name TEXT NOT NULL,
        receiver TEXT,
        line INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_callsites_file ON call_sites(file_path);
      CREATE INDEX IF NOT EXISTS idx_callsites_callee ON call_sites(callee_name);

      CREATE TABLE IF NOT EXISTS ranks (
        node_id TEXT PRIMARY KEY,
        rank REAL NOT NULL
      );

      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);
  }

  // ---- Merkle leaves ---------------------------------------------------

  loadLeaves(): Map<string, string> {
    const rows = this.db.prepare(`SELECT path, hash FROM files`).all() as {
      path: string;
      hash: string;
    }[];
    return new Map(rows.map((r) => [r.path, r.hash]));
  }

  upsertFile(f: IndexedFile): void {
    this.db
      .prepare(
        `INSERT INTO files (path, hash, size, mtime, language)
         VALUES (@path, @hash, @size, @mtime, @language)
         ON CONFLICT(path) DO UPDATE SET
           hash=excluded.hash, size=excluded.size,
           mtime=excluded.mtime, language=excluded.language`,
      )
      .run({
        path: f.path,
        hash: f.hash,
        size: f.size,
        mtime: f.mtimeMs,
        language: f.language,
      });
  }

  /** Remove a file and everything it produced (nodes, edges, fts, vectors). */
  removeFile(path: string): void {
    const tx = this.db.transaction((p: string) => {
      const nodeIds = this.db
        .prepare(`SELECT id FROM nodes WHERE file_path = ?`)
        .all(p) as { id: string }[];
      const delFts = this.db.prepare(`DELETE FROM nodes_fts WHERE id = ?`);
      const delEmb = this.db.prepare(`DELETE FROM embeddings WHERE node_id = ?`);
      for (const { id } of nodeIds) {
        delFts.run(id);
        delEmb.run(id);
      }
      this.db.prepare(`DELETE FROM edges WHERE file_path = ?`).run(p);
      this.db.prepare(`DELETE FROM nodes WHERE file_path = ?`).run(p);
      this.db.prepare(`DELETE FROM call_sites WHERE file_path = ?`).run(p);
      this.db.prepare(`DELETE FROM files WHERE path = ?`).run(p);
    });
    tx(path);
  }

  // ---- Nodes / edges ---------------------------------------------------

  replaceFileGraph(filePath: string, nodes: CodeNode[], edges: CodeEdge[]): void {
    const insNode = this.db.prepare(
      `INSERT OR REPLACE INTO nodes
       (id, kind, name, file_path, language, start_line, end_line, signature, snippet, meta)
       VALUES (@id, @kind, @name, @file_path, @language, @start_line, @end_line, @signature, @snippet, @meta)`,
    );
    const insEdge = this.db.prepare(
      `INSERT OR REPLACE INTO edges
       (id, kind, from_id, to_id, confidence, file_path, meta)
       VALUES (@id, @kind, @from_id, @to_id, @confidence, @file_path, @meta)`,
    );
    const insFts = this.db.prepare(
      `INSERT INTO nodes_fts (id, name, signature, snippet) VALUES (?, ?, ?, ?)`,
    );
    const delFts = this.db.prepare(`DELETE FROM nodes_fts WHERE id = ?`);

    const tx = this.db.transaction(() => {
      // clear existing graph for this file first
      const existing = this.db
        .prepare(`SELECT id FROM nodes WHERE file_path = ?`)
        .all(filePath) as { id: string }[];
      for (const { id } of existing) delFts.run(id);
      this.db.prepare(`DELETE FROM edges WHERE file_path = ?`).run(filePath);
      this.db.prepare(`DELETE FROM nodes WHERE file_path = ?`).run(filePath);

      for (const n of nodes) {
        insNode.run({
          id: n.id,
          kind: n.kind,
          name: n.name,
          file_path: n.filePath,
          language: n.language,
          start_line: n.startLine,
          end_line: n.endLine,
          signature: n.signature ?? null,
          snippet: n.snippet ?? null,
          meta: n.meta ? JSON.stringify(n.meta) : null,
        });
        insFts.run(n.id, n.name, n.signature ?? "", n.snippet ?? "");
      }
      for (const e of edges) {
        insEdge.run({
          id: e.id,
          kind: e.kind,
          from_id: e.fromId,
          to_id: e.toId,
          confidence: e.confidence,
          file_path: filePath,
          meta: e.meta ? JSON.stringify(e.meta) : null,
        });
      }
    });
    tx();
  }

  // ---- Reads -----------------------------------------------------------

  getNode(id: string): CodeNode | undefined {
    const row = this.db.prepare(`SELECT * FROM nodes WHERE id = ?`).get(id);
    return row ? rowToNode(row) : undefined;
  }

  getNodesByName(name: string): CodeNode[] {
    const rows = this.db.prepare(`SELECT * FROM nodes WHERE name = ?`).all(name);
    return rows.map(rowToNode);
  }

  outgoing(id: string): CodeEdge[] {
    return (this.db.prepare(`SELECT * FROM edges WHERE from_id = ?`).all(id) as any[]).map(
      rowToEdge,
    );
  }

  incoming(id: string): CodeEdge[] {
    return (this.db.prepare(`SELECT * FROM edges WHERE to_id = ?`).all(id) as any[]).map(
      rowToEdge,
    );
  }

  allNodesMissingEmbedding(): CodeNode[] {
    const rows = this.db
      .prepare(
        `SELECT n.* FROM nodes n
         LEFT JOIN embeddings e ON e.node_id = n.id
         WHERE e.node_id IS NULL AND n.kind != 'import'`,
      )
      .all();
    return rows.map(rowToNode);
  }

  nodesMissingEmbeddingForFile(filePath: string): CodeNode[] {
    const rows = this.db
      .prepare(
        `SELECT n.* FROM nodes n
         LEFT JOIN embeddings e ON e.node_id = n.id
         WHERE e.node_id IS NULL AND n.kind != 'import' AND n.file_path = ?`,
      )
      .all(filePath);
    return rows.map(rowToNode);
  }

  // ---- Search ----------------------------------------------------------

  bm25(query: string, limit: number): { id: string; score: number }[] {
    const match = toFtsQuery(query);
    if (!match) return [];
    try {
      const rows = this.db
        .prepare(
          `SELECT id, bm25(nodes_fts) AS score
           FROM nodes_fts WHERE nodes_fts MATCH ?
           ORDER BY score LIMIT ?`,
        )
        .all(match, limit) as { id: string; score: number }[];
      // bm25 returns lower = better; convert to higher = better
      return rows.map((r) => ({ id: r.id, score: 1 / (1 + Math.max(0, r.score)) }));
    } catch {
      return [];
    }
  }

  // ---- Embeddings ------------------------------------------------------

  storeEmbedding(nodeId: string, vec: Float32Array): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO embeddings (node_id, dim, vec) VALUES (?, ?, ?)`,
      )
      .run(nodeId, vec.length, Buffer.from(vec.buffer.slice(0)));
  }

  clearEmbeddings(): void {
    this.db.prepare(`DELETE FROM embeddings`).run();
  }

  allEmbeddings(): { id: string; vec: Float32Array }[] {
    const rows = this.db.prepare(`SELECT node_id, dim, vec FROM embeddings`).all() as {
      node_id: string;
      dim: number;
      vec: Buffer;
    }[];
    return rows.map((r) => ({
      id: r.node_id,
      vec: new Float32Array(
        r.vec.buffer,
        r.vec.byteOffset,
        r.vec.byteLength / Float32Array.BYTES_PER_ELEMENT,
      ),
    }));
  }

  // ---- Call sites (for cross-file resolution) -------------------------

  replaceFileCallSites(filePath: string, sites: CallSite[]): void {
    const del = this.db.prepare(`DELETE FROM call_sites WHERE file_path = ?`);
    const ins = this.db.prepare(
      `INSERT INTO call_sites (file_path, caller_id, callee_name, receiver, line)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction(() => {
      del.run(filePath);
      for (const s of sites) {
        ins.run(filePath, s.callerId, s.calleeName, s.receiver ?? null, s.line);
      }
    });
    tx();
  }

  allCallSites(): CallSite[] {
    const rows = this.db
      .prepare(`SELECT file_path, caller_id, callee_name, receiver, line FROM call_sites`)
      .all() as any[];
    return rows.map((r) => ({
      filePath: r.file_path,
      callerId: r.caller_id,
      calleeName: r.callee_name,
      receiver: r.receiver ?? undefined,
      line: r.line,
    }));
  }

  callSitesForFile(filePath: string): CallSite[] {
    const rows = this.db
      .prepare(`SELECT file_path, caller_id, callee_name, receiver, line FROM call_sites WHERE file_path = ?`)
      .all(filePath) as any[];
    return rows.map((r) => ({
      filePath: r.file_path,
      callerId: r.caller_id,
      calleeName: r.callee_name,
      receiver: r.receiver ?? undefined,
      line: r.line,
    }));
  }

  allNodesOfKinds(kinds: string[]): CodeNode[] {
    const placeholders = kinds.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM nodes WHERE kind IN (${placeholders})`)
      .all(...kinds);
    return rows.map(rowToNode);
  }

  deleteEdgesByKind(kinds: string[]): void {
    const placeholders = kinds.map(() => "?").join(",");
    this.db.prepare(`DELETE FROM edges WHERE kind IN (${placeholders})`).run(...kinds);
  }

  deleteEdgesForFileByKind(filePath: string, kinds: string[]): void {
    const placeholders = kinds.map(() => "?").join(",");
    this.db
      .prepare(`DELETE FROM edges WHERE file_path = ? AND kind IN (${placeholders})`)
      .run(filePath, ...kinds);
  }

  /** Remove edges whose target node no longer exists (left dangling by a change). */
  deleteDanglingEdges(kinds: string[]): void {
    const placeholders = kinds.map(() => "?").join(",");
    this.db
      .prepare(
        `DELETE FROM edges WHERE kind IN (${placeholders})
         AND to_id NOT IN (SELECT id FROM nodes)`,
      )
      .run(...kinds);
  }

  allEdgesOfKinds(kinds: string[]): CodeEdge[] {
    const placeholders = kinds.map(() => "?").join(",");
    return (
      this.db.prepare(`SELECT * FROM edges WHERE kind IN (${placeholders})`).all(...kinds) as any[]
    ).map(rowToEdge);
  }

  insertEdges(edges: CodeEdge[]): void {
    const ins = this.db.prepare(
      `INSERT OR REPLACE INTO edges
       (id, kind, from_id, to_id, confidence, file_path, meta)
       VALUES (@id, @kind, @from_id, @to_id, @confidence, @file_path, @meta)`,
    );
    const tx = this.db.transaction((list: CodeEdge[]) => {
      for (const e of list) {
        ins.run({
          id: e.id,
          kind: e.kind,
          from_id: e.fromId,
          to_id: e.toId,
          confidence: e.confidence,
          file_path: (e.meta?.filePath as string) ?? "",
          meta: e.meta ? JSON.stringify(e.meta) : null,
        });
      }
    });
    tx(edges);
  }

  // ---- Importance ranks (PageRank) ------------------------------------

  replaceRanks(ranks: Map<string, number>): void {
    const ins = this.db.prepare(
      `INSERT OR REPLACE INTO ranks (node_id, rank) VALUES (?, ?)`,
    );
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM ranks`).run();
      for (const [id, r] of ranks) ins.run(id, r);
    });
    tx();
  }

  getRank(nodeId: string): number {
    const row = this.db.prepare(`SELECT rank FROM ranks WHERE node_id = ?`).get(nodeId) as
      | { rank: number }
      | undefined;
    return row?.rank ?? 0;
  }

  /** Resolution-quality metrics: how precise the call graph is. */
  callGraphMetrics(): {
    callEdges: number;
    highConfidence: number;
    mediumConfidence: number;
    lowConfidence: number;
    precisePct: number;
  } {
    const q = (sql: string) => (this.db.prepare(sql).get() as { c: number }).c;
    const callEdges = q(`SELECT COUNT(*) c FROM edges WHERE kind = 'calls'`);
    const high = q(`SELECT COUNT(*) c FROM edges WHERE kind = 'calls' AND confidence >= 0.8`);
    const med = q(
      `SELECT COUNT(*) c FROM edges WHERE kind = 'calls' AND confidence >= 0.5 AND confidence < 0.8`,
    );
    const low = q(`SELECT COUNT(*) c FROM edges WHERE kind = 'calls' AND confidence < 0.5`);
    return {
      callEdges,
      highConfidence: high,
      mediumConfidence: med,
      lowConfidence: low,
      precisePct: callEdges ? Math.round((high / callEdges) * 1000) / 10 : 0,
    };
  }

  // ---- Stats -----------------------------------------------------------

  stats(): { files: number; nodes: number; edges: number; embeddings: number } {
    const one = (sql: string) => (this.db.prepare(sql).get() as { c: number }).c;
    return {
      files: one(`SELECT COUNT(*) c FROM files`),
      nodes: one(`SELECT COUNT(*) c FROM nodes`),
      edges: one(`SELECT COUNT(*) c FROM edges`),
      embeddings: one(`SELECT COUNT(*) c FROM embeddings`),
    };
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  close(): void {
    this.db.close();
  }
}

function rowToNode(row: any): CodeNode {
  return {
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
  };
}

function rowToEdge(row: any): CodeEdge {
  return {
    id: row.id,
    kind: row.kind,
    fromId: row.from_id,
    toId: row.to_id,
    confidence: row.confidence,
    meta: row.meta ? JSON.parse(row.meta) : undefined,
  };
}

/** Sanitize a free-text query into a safe FTS5 OR-query. */
function toFtsQuery(query: string): string | null {
  const terms = query
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t}"`).join(" OR ");
}
