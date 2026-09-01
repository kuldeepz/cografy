import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { Cografy } from "../index.js";

const TOOLS: Tool[] = [
  {
    name: "cografy_context",
    description:
      "Retrieve token-budgeted, ranked code context for a natural-language query. Fuses BM25 + semantic search and packs the densest relevant symbols within a token budget. Prefer this over reading many files.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you are looking for." },
        budget: { type: "number", description: "Max tokens of context (default 8000)." },
        format: { type: "string", enum: ["markdown", "xml"], description: "Output format." },
      },
      required: ["query"],
    },
  },
  {
    name: "cografy_search",
    description:
      "Hybrid search for code symbols (functions, classes, methods, routes). Returns ranked matches with file locations and scores.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", description: "Max results (default 12)." },
      },
      required: ["query"],
    },
  },
  {
    name: "cografy_trace_flow",
    description:
      "Trace the execution/call flow starting from a symbol name, following resolved call and route-handler edges. Use to understand end-to-end flows (e.g. 'the user registration flow').",
    inputSchema: {
      type: "object",
      properties: { symbol: { type: "string" } },
      required: ["symbol"],
    },
  },
  {
    name: "cografy_impact",
    description:
      "Impact / blast-radius analysis: list everything that transitively depends on a symbol (who calls or imports it). Use before changing shared code.",
    inputSchema: {
      type: "object",
      properties: { symbol: { type: "string" } },
      required: ["symbol"],
    },
  },
  {
    name: "cografy_routes",
    description:
      "List detected web routes (Express/Fastify/Flask/FastAPI/Spring, etc.) mapped to their handler functions.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "cografy_neighborhood",
    description:
      "Return the local graph neighborhood (related symbols and edges) around a symbol, up to a given depth.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        depth: { type: "number", description: "Hops (default 1)." },
      },
      required: ["symbol"],
    },
  },
  {
    name: "cografy_reindex",
    description: "Force a full incremental re-index of the workspace.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "cografy_repomap",
    description:
      "Ranked repo map: the most important symbols by PageRank (most depended-upon functions/classes). Great for orienting in an unfamiliar codebase.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "Max symbols (default 25)." } },
    },
  },
  {
    name: "cografy_deadcode",
    description:
      "List dead-code candidates: functions/methods that are unreachable from routes/entry points and called by nothing. Heuristic hint (dynamic dispatch can hide uses).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "cografy_stats",
    description: "Return index statistics (files, nodes, edges, embeddings, last index time).",
    inputSchema: { type: "object", properties: {} },
  },
];

export async function runMcpServer(root: string): Promise<void> {
  const engine = new Cografy(root);
  // Ensure a fresh index, then keep it live via the watcher.
  await engine.index();
  engine.startWatch();

  const server = new Server(
    { name: "cografy", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    try {
      const text = await dispatch(engine, name, args as Record<string, unknown>);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    await engine.stopWatch();
    engine.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function dispatch(
  engine: Cografy,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case "cografy_context": {
      const bundle = await engine.context(String(args.query ?? ""), {
        budget: typeof args.budget === "number" ? args.budget : undefined,
        format: args.format === "xml" ? "xml" : "markdown",
      });
      return bundle.formatted;
    }
    case "cografy_search": {
      const hits = await engine.find(
        String(args.query ?? ""),
        typeof args.limit === "number" ? args.limit : 12,
      );
      if (!hits.length) return "No matches.";
      return hits
        .map(
          (h, i) =>
            `${i + 1}. [${h.node.kind}] ${h.node.name} — ${h.node.filePath}:${h.node.startLine} (score ${h.score.toFixed(3)})`,
        )
        .join("\n");
    }
    case "cografy_trace_flow": {
      const { root, chain } = engine.traceFlow(String(args.symbol ?? ""));
      if (!root) return `Symbol not found: ${args.symbol}`;
      const lines = [`Flow from ${root.name} (${root.filePath}:${root.startLine}):`];
      if (!chain.length) lines.push("  (no outgoing calls resolved)");
      for (const step of chain) {
        lines.push(
          `${"  ".repeat(step.depth + 1)}${step.from.name} --${step.kind}(${step.confidence.toFixed(2)})--> ${step.to.name}  [${step.to.filePath}:${step.to.startLine}]`,
        );
      }
      return lines.join("\n");
    }
    case "cografy_impact": {
      const { target, dependents } = engine.impact(String(args.symbol ?? ""));
      if (!target) return `Symbol not found: ${args.symbol}`;
      if (!dependents.length) return `No known dependents of ${target.name}.`;
      return (
        `${dependents.length} symbols depend on ${target.name}:\n` +
        dependents
          .map((d) => `- [${d.kind}] ${d.name} — ${d.filePath}:${d.startLine}`)
          .join("\n")
      );
    }
    case "cografy_routes": {
      const routes = engine.routes();
      if (!routes.length) return "No routes detected.";
      return routes
        .map(
          (r) =>
            `${r.route.name} -> ${r.handler ? `${r.handler.name} (${r.handler.filePath}:${r.handler.startLine})` : "<unresolved>"} [conf ${r.confidence.toFixed(2)}]`,
        )
        .join("\n");
    }
    case "cografy_neighborhood": {
      const depth = typeof args.depth === "number" ? args.depth : 1;
      const sub = engine.neighborhood(String(args.symbol ?? ""), depth);
      if (!sub.nodes.length) return `Symbol not found: ${args.symbol}`;
      const nodeLines = sub.nodes.map(
        (n) => `  (${n.kind}) ${n.name} — ${n.filePath}:${n.startLine}`,
      );
      const byId = new Map(sub.nodes.map((n) => [n.id, n.name]));
      const edgeLines = sub.edges.map(
        (e) => `  ${byId.get(e.fromId) ?? e.fromId} --${e.kind}--> ${byId.get(e.toId) ?? e.toId}`,
      );
      return `Nodes:\n${nodeLines.join("\n")}\n\nEdges:\n${edgeLines.join("\n")}`;
    }
    case "cografy_reindex": {
      const s = await engine.index();
      return `Reindexed ${s.scanned} files (+${s.added} ~${s.changed} -${s.removed}) in ${s.durationMs}ms.`;
    }
    case "cografy_repomap": {
      const limit = typeof args.limit === "number" ? args.limit : 25;
      const top = engine.importantSymbols(limit);
      if (!top.length) return "No symbols indexed.";
      return top
        .map(
          (t, i) =>
            `${i + 1}. [${t.node.kind}] ${t.node.name} — ${t.node.filePath}:${t.node.startLine} (rank ${t.rank.toFixed(3)})`,
        )
        .join("\n");
    }
    case "cografy_deadcode": {
      const dead = engine.deadCode();
      if (!dead.length) return "No dead-code candidates found.";
      return (
        `${dead.length} dead-code candidates (heuristic):\n` +
        dead.map((d) => `- [${d.kind}] ${d.name} — ${d.filePath}:${d.startLine}`).join("\n")
      );
    }
    case "cografy_stats": {
      return JSON.stringify(engine.stats(), null, 2);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
