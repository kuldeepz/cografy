/**
 * Core domain types shared across the engine, graph store, search and MCP layers.
 */

/** Kinds of nodes we track in the code graph. */
export type NodeKind =
  | "file"
  | "module"
  | "class"
  | "interface"
  | "function"
  | "method"
  | "variable"
  | "route"
  | "import"
  | "asset"; // non-code assets: pdf, docs, video, images (multimodal linking)

/** Kinds of relationships between nodes. */
export type EdgeKind =
  | "contains" // file contains symbol
  | "calls" // function calls function
  | "imports" // module imports module/symbol
  | "extends" // class extends class
  | "implements" // class implements interface
  | "handles" // route handled by function/method
  | "references" // generic reference
  | "documents"; // asset documents a code symbol

export interface CodeNode {
  id: string; // stable content-addressable id
  kind: NodeKind;
  name: string;
  filePath: string; // relative to repo root
  language: string;
  startLine: number;
  endLine: number;
  signature?: string; // e.g. function signature / route pattern
  snippet?: string; // source text of the node
  meta?: Record<string, unknown>;
}

export interface CodeEdge {
  id: string;
  kind: EdgeKind;
  fromId: string;
  toId: string;
  /** Confidence 0..1. Exact resolutions are 1.0, heuristic name-matches lower. */
  confidence: number;
  meta?: Record<string, unknown>;
}

/** Result of parsing a single file. */
export interface ParseResult {
  filePath: string;
  language: string;
  nodes: CodeNode[];
  edges: CodeEdge[];
  /** Unresolved call sites, resolved to precise targets by the cross-file resolver. */
  callSites?: CallSite[];
}

/** A call reference extracted from a function body, pending cross-file resolution. */
export interface CallSite {
  callerId: string; // node id of the enclosing function/method
  calleeName: string; // bare callee name, e.g. "getUser"
  receiver?: string; // receiver expression text for member calls, e.g. "this" | "userService"
  filePath: string;
  line: number;
}

/** A file entry in the Merkle incremental index. */
export interface IndexedFile {
  path: string;
  hash: string;
  size: number;
  mtimeMs: number;
  language: string;
}

export interface SearchHit {
  node: CodeNode;
  score: number;
  /** Component scores for transparency / re-ranking. */
  bm25?: number;
  vector?: number;
  graph?: number;
}

export interface ContextBundle {
  query: string;
  tokensUsed: number;
  tokenBudget: number;
  hits: SearchHit[];
  formatted: string; // final rendered context (markdown or xml)
}

export type Profile = "auto" | "personal" | "monorepo";
export type ResolverMode = "auto" | "full" | "incremental";
export type SearchMode = "auto" | "brute" | "gated";
export type ParsingMode = "auto" | "single" | "workers";
export type ViewerMode = "inline" | "cdn";
export type EmbeddingsKind = "local" | "transformers" | "ollama";

export interface CografyConfig {
  root: string;
  dbPath: string;
  include: string[];
  exclude: string[];
  maxFileBytes: number;
  embeddingDim: number;
  tokenBudget: number;
  profile: Profile;
  resolver: ResolverMode;
  search: SearchMode;
  parsing: ParsingMode;
  viewer: ViewerMode;
  embeddings: EmbeddingsKind;
}
