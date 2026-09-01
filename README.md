<div align="center">

```
   ◍─────◍
  ╱       ╲      C O G R A F Y
 ◍    ◍    ◍     live code intelligence for AI agents
  ╲       ╱      graph · resolve · rank · budget
   ◍─────◍
```

**A codebase intelligence engine that stays fresh as you type, resolves calls precisely across files, and feeds your AI agent exactly the right context within a token budget — with zero external services.**

![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)
![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6)
![MCP](https://img.shields.io/badge/MCP-compatible-8A2BE2)
![Benchmark](https://img.shields.io/badge/resolver-100%25%20precision%2Frecall-brightgreen)
![Tests](https://img.shields.io/badge/tests-passing-brightgreen)

</div>

---

## Why Cografy

Most code-context tools for AI agents break in one of three places:

| Problem | How Cografy fixes it |
| --- | --- |
| **Graph drift** — the index goes stale the moment you edit. | A **Merkle-diff + file watcher** re-parses *only the file you saved*, in milliseconds. Never stale. |
| **Structural hallucination** — `getName()` on one class gets merged with `getName()` on another. | **Tree-sitter ASTs + a cross-file resolver** link calls to their *true* definitions, class-scoped, with confidence tiers. |
| **Token exhaustion** — dumping files blows the context window. | A **token-budgeted gateway** packs the densest, most relevant symbols (Markdown or XML) and stops at your budget. |

…and it does all of this **without a daemon, graph database, or API key** — just an embedded SQLite file.

## The three layers

| Layer | Role | What it does |
| --- | --- | --- |
| **Foundation** | always-fresh index | Merkle-tree incremental index + native file watcher. Re-parses only what changed. |
| **Intellect** | resolved graph | Tree-sitter ASTs → class-scoped symbols. Cross-file resolver (import graph + symbol table + receiver-type inference) produces precise `calls` / `handles` / `extends` edges. Adds routes→handlers, PageRank importance, and dead-code detection. |
| **Gatekeeper** | context budget | Hybrid BM25 + vector retrieval (PageRank-boosted), packed into a strict token budget. |

Exposed to any AI client — **GitHub Copilot, Claude, Cursor** — over the **Model Context Protocol (MCP)**.

## Highlights

- 🎯 **Precise cross-file resolution.** Calls, inheritance and route handlers resolve to real definitions with confidence tiers. Local **receiver-type inference** (`const u = new UserService(); u.getName()`) disambiguates instance calls to shared method names.
- 🌲 **Real tree-sitter parsing**, no native compilation — TS/JS/TSX, Python, Go, Rust, Java, C#, Ruby, PHP, C/C++, Kotlin, Swift, Scala, Lua, Dart, Vue. Anything without a grammar falls back to a heuristic parser automatically.
- ⚡ **Millisecond incremental updates.** Merkle diff + watcher, no rerun, no git hooks, no drift.
- 🧭 **PageRank repo map.** Surfaces the most depended-upon symbols — a ranking signal *and* a `repomap` tool (aider's proven technique).
- 🧹 **Dead-code detection.** Functions unreachable from routes/entry points and called by nothing.
- 🔗 **Multimodal linking.** Markdown/docs are linked to the code symbols they mention (`documents` edges).
- 🧠 **Pluggable embeddings.** Zero-download local provider by default; opt into **transformers.js** (`all-MiniLM-L6-v2`) or **Ollama** — still no API key.
- 📦 **Zero external services.** Embedded SQLite (graph + FTS5 BM25 + vectors). No Neo4j/Kuzu/Qdrant, no Docker.

## Quickstart

```bash
# 1. Build
npm install
npm run build

# 2. Index a repo (creates a local .cografy/graph.db)
node dist/cli.js index /path/to/repo

# 3. Ask for context, trace a flow, or map the codebase
node dist/cli.js context "how are auth tokens validated" -r /path/to/repo
node dist/cli.js trace registerUser -r /path/to/repo
node dist/cli.js repomap -r /path/to/repo
```

**Requirements:** Node ≥ 18. No other services.

## Setup & configuration

Run the one-time wizard to configure the repo and wire up your AI client:

```bash
node dist/cli.js init .
```

It asks a few questions and writes `cografy.config.json` plus (optionally)
`.vscode/mcp.json` / `.mcp.json` and an agent steering file (`CLAUDE.md` or
`.github/copilot-instructions.md`). You can also edit the config by hand:

```jsonc
{
  "profile": "auto",        // auto | personal | monorepo — scales features to repo size
  "embeddings": "local",    // local | transformers | ollama
  "viewer": "inline",       // inline (offline) | cdn
  "tokenBudget": 8000
}
```

`profile` drives the scale features: **monorepo** (or a large repo under **auto**)
enables worker-pool parsing and gated search; **personal** keeps things simple.
The watcher always uses incremental resolution.

## CLI reference

| Command | Description |
| --- | --- |
| `init [root]` | Interactive setup: config + MCP/steering integrations. |
| `index [root]` | Build/refresh the incremental graph. |
| `watch [root]` | Index once, then keep the graph live on every save. |
| `serve [root]` | Run the MCP server (stdio) for AI clients. |
| `search <query> -r <root>` | Hybrid symbol search. |
| `context <query> -r <root> [-b budget] [-f markdown\|xml]` | Token-budgeted context bundle. |
| `trace <symbol> -r <root>` | Execution/call-flow trace from a symbol. |
| `impact <symbol> -r <root>` | Blast-radius: everything that depends on a symbol. |
| `routes -r <root>` | Detected web routes mapped to handlers. |
| `repomap -r <root> [-n limit]` | Most important symbols by PageRank. |
| `deadcode -r <root>` | Unreachable / uncalled functions. |
| `export -r <root> [-f html\|dot\|json] [--focus sym]` | Interactive graph visualization. |
| `metrics -r <root>` | Call-graph resolution quality. |
| `stats -r <root>` | Index statistics. |

```bash
node dist/cli.js context "user registration flow" -r . -b 6000 -f xml
node dist/cli.js impact validateToken -r .
node dist/cli.js metrics -r .
```

## Visualize the graph

Export your codebase graph to a **self-contained interactive HTML page** (drag, zoom, search, color-coded by symbol kind, edges colored by resolution confidence) and open it in any browser:

```bash
# Whole repo (top 300 symbols by importance), then open in the browser
node dist/cli.js export -r /path/to/repo --open

# Focus on one symbol and its neighborhood
node dist/cli.js export -r /path/to/repo --focus registerUser --depth 2 --open

# Other formats
node dist/cli.js export -r /path/to/repo -f dot  -o graph.dot   # Graphviz
node dist/cli.js export -r /path/to/repo -f json -o graph.json  # raw nodes/edges
```

| Flag | Meaning |
| --- | --- |
| `-f, --format html\|dot\|json` | Output format (default `html`). |
| `-o, --out <file>` | Output path (default `cografy-graph.<ext>`). |
| `--focus <symbol>` | Center on a symbol instead of the whole repo. |
| `--depth <n>` | Neighborhood hops when focused (default 2). |
| `--limit <n>` | Max nodes for whole-repo export (default 300). |
| `--open` | Open the HTML in your default browser. |

The HTML loads the [vis-network](https://visjs.org/) renderer from a CDN, so keep a network connection when first viewing it. DOT output works with `dot -Tsvg graph.dot -o graph.svg` or any online Graphviz viewer.

## Use as an MCP server

```bash
node dist/cli.js serve /path/to/repo
```

<details>
<summary><b>VS Code (Copilot)</b> — <code>.vscode/mcp.json</code></summary>

```jsonc
{
  "servers": {
    "cografy": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/cografy/dist/cli.js", "serve", "${workspaceFolder}"]
    }
  }
}
```
</details>

<details>
<summary><b>Claude Desktop</b> — <code>claude_desktop_config.json</code></summary>

```jsonc
{
  "mcpServers": {
    "cografy": {
      "command": "node",
      "args": ["/absolute/path/to/cografy/dist/cli.js", "serve", "/path/to/repo"]
    }
  }
}
```
</details>

### Tools exposed over MCP

| Tool | Purpose |
| --- | --- |
| `cografy_context` | Token-budgeted, ranked context bundle for a query. **Prefer this over reading many files.** |
| `cografy_search` | Hybrid symbol search. |
| `cografy_trace_flow` | Execution/call-flow trace from a symbol. |
| `cografy_impact` | Blast-radius / dependents of a symbol. |
| `cografy_routes` | Web routes mapped to handlers. |
| `cografy_neighborhood` | Local graph around a symbol. |
| `cografy_repomap` | Ranked repo map (most important symbols by PageRank). |
| `cografy_deadcode` | Dead-code candidates. |
| `cografy_reindex` | Force incremental re-index. |
| `cografy_stats` | Index statistics. |

## Embedding providers

The default provider is fully local and needs no download. For stronger semantic search, opt in via an env var — Cografy re-embeds automatically on the next index.

| Provider | Env | Model | Dim | Notes |
| --- | --- | --- | --- | --- |
| Local (default) | *(none)* | hashed n-grams | 256 | Zero download, instant. |
| transformers.js | `COGRAFY_EMBED_PROVIDER=transformers` | `all-MiniLM-L6-v2` | 384 | `npm i @huggingface/transformers`; downloads model once, no API key. |
| Ollama | `COGRAFY_EMBED_PROVIDER=ollama` | `nomic-embed-text` | 768 | Uses a local Ollama daemon. |

```bash
npm install @huggingface/transformers
COGRAFY_EMBED_PROVIDER=transformers node dist/cli.js context "rate limiting" -r .
```

Override the model with `COGRAFY_EMBED_MODEL`, and the Ollama host with `OLLAMA_HOST`.

## Benchmarks

Resolver quality is **measured**, not asserted — a repeatable gate over multi-language ground-truth fixtures:

```bash
npm run bench   # precision/recall gate across TS, Python, Go, Java, Rust
npm test        # unit tests: same-name disambiguation + cross-language
```

| Metric | Result |
| --- | --- |
| Recall (expected call edges found) | **100%** (11/11) |
| Precision (resolved edges correct) | **100%** (11/11) |
| Avg confidence of matched edges | **0.95** |
| Same-name disambiguation errors | **0** |

The headline case — `UserService.getName` vs `ProductService.getName` — resolves to the **correct class at confidence 1.0**, including for instance variables via receiver-type inference. This is the exact failure mode most name-matching tools hit.

> Note: these numbers are on controlled fixtures that prove correctness. On a large, messy real-world repo, expect lower (this project self-indexes at ~80% high-confidence call edges — run `metrics` on your own code to see).

## Performance & scale

Reproducible on any machine — `npm run perf` generates synthetic repos and measures. Numbers below: Node 24, Apple Silicon, synthetic TypeScript repos with cross-file classes/calls.

| Files | Symbols | Full index | CLI re-index (1 file) | **Watcher save (1 file)** | Search |
| ----- | ------- | ---------- | --------------------- | ------------------------- | ------ |
| 1,000 | 7,000 | ~0.7s | ~80ms | **~5ms** | ~7ms |
| 3,000 | 21,000 | ~2.1s | ~230ms | **~12ms** | ~20ms |
| 12,000 | 84,000 | ~11s | ~1.0s | **~51ms** | ~85ms |
| 24,000 | 168,000 | ~26s | ~2.3s | **~128ms** | ~200ms |

```bash
npm run perf 1000 3000 12000   # reproduce (pass your own sizes)
```

The **watcher save** column is the one that matters for live editing: an
incremental resolver re-resolves only the files affected by a change (using a
reverse-dependency index), and PageRank is debounced — so a save stays fast even
as the repo grows, keeping the "always-fresh, no drift" promise at scale. Full
indexing uses a **worker-pool parser** on large repos.

**Remaining scale work (honest):** semantic vector search is still linear in
corpus size (it scans all embeddings per query — see the Search column). An ANN
index (HNSW) or BM25-gated vectors would make it sub-linear; that's the next
scaling item. For a normal large project it's already fast; a giant monorepo
would benefit from the ANN step.

## Architecture

```
[ Workspace ] --save--> [ Watcher ] --> [ Merkle diff ] --> [ tree-sitter parser ]
                                                                |  (fallback: heuristic)
                                                     nodes + imports + call-sites
                                                                v
                                   [ SQLite: nodes/edges + FTS5 (BM25) + vectors ]
                                                                |
                                          [ cross-file resolver + PageRank ]
                                              precise calls / handles / extends
                                                                |
                    +-----------------------------+-------------+-------------+
                    |                             |                           |
             GraphQuery                    HybridSearch                Context budgeter
       (trace / impact / routes /      (BM25 + vector, RRF          (rank-aware packing
        repomap / deadcode)             fusion + rank boost)         to a token budget)
                    \_____________________________|___________________________/
                                                  v
                                        [ MCP server / CLI ]
                                                  v
                                  GitHub Copilot · Claude · Cursor
```

## Programmatic API

```ts
import { Cografy } from "cografy";

const cg = new Cografy("/path/to/repo");
await cg.index();
cg.startWatch(); // keep it live

// Token-budgeted context for an agent
const bundle = await cg.context("how does login work", { budget: 6000, format: "xml" });
console.log(bundle.formatted);

// Structural queries
cg.traceFlow("registerUser");     // call chain
cg.impact("validateToken");       // dependents / blast radius
cg.routes();                      // routes -> handlers
cg.importantSymbols(25);          // PageRank repo map
cg.deadCode();                    // dead-code candidates
```

## How it compares

| | Cografy | Typical graph-DB tools | Repo-map tools (aider) |
| --- | --- | --- | --- |
| Parsing | tree-sitter + heuristic fallback | tree-sitter / LSP | tree-sitter tags |
| Cross-file resolution | import graph + symbol table + type inference | schema / LSP | name-match |
| Incremental updates | **Merkle diff, millisecond** | often full recompute / daemon | recompute + cache |
| External services | **none (embedded SQLite)** | Neo4j / Kuzu / Qdrant + Docker | none |
| Retrieval | BM25 + vector + PageRank | graph / vector | PageRank |
| Token budgeting | **built-in** | rarely | yes |

**Honest limitations.** Cografy's resolution is high-quality *inference*, not a type checker. Tools built on SCIP/LSP achieve compiler-exact references; Cografy trades a sliver of precision for zero setup and true incremental freshness. Dead-code detection is a heuristic (dynamic dispatch/reflection can hide real uses).

## Development

```bash
npm run build     # compile TypeScript to dist/
npm run dev       # watch-compile
npm run bench     # resolver precision/recall gate
npm run perf      # performance harness (synthetic repos)
npm test          # unit tests
```

## License

[MIT](LICENSE)
