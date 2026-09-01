#!/usr/bin/env node
import { Command } from "commander";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { Cografy } from "./index.js";
import { runMcpServer } from "./mcp/server.js";
import { runInit } from "./setup/init.js";

const BANNER = `
   ◍─────◍
  ╱       ╲      C O G R A F Y
 ◍    ◍    ◍     live code intelligence for AI agents
  ╲       ╱      graph · resolve · rank · budget
   ◍─────◍
`;

const program = new Command();
program
  .name("cografy")
  .description(
    "Cografy — unified codebase intelligence: incremental graph indexing + structural resolution + token-aware context, over MCP.",
  )
  .version("0.1.0");

program.addHelpText("beforeAll", BANNER);

program
  .command("init")
  .description("Interactive setup: writes config + MCP/steering integrations.")
  .argument("[root]", "workspace root", ".")
  .action(async (root: string) => {
    await runInit(resolve(root));
  });

program
  .command("index")
  .description("Build/refresh the incremental code graph for a workspace.")
  .argument("[root]", "workspace root", ".")
  .action(async (root: string) => {
    const engine = new Cografy(resolve(root));
    const s = await engine.index();
    console.log(
      `Indexed ${s.scanned} files (+${s.added} ~${s.changed} -${s.removed}), embedded ${s.embedded} symbols in ${s.durationMs}ms.`,
    );
    console.log(JSON.stringify(engine.stats(), null, 2));
    engine.close();
  });

program
  .command("watch")
  .description("Index once, then watch for changes and keep the graph live.")
  .argument("[root]", "workspace root", ".")
  .action(async (root: string) => {
    const engine = new Cografy(resolve(root));
    const s = await engine.index();
    console.log(`Initial index: ${s.scanned} files in ${s.durationMs}ms. Watching…`);
    engine.startWatch(({ upserts, removes }) => {
      if (upserts || removes) console.log(`Reindexed +${upserts} -${removes}`);
    });
  });

program
  .command("serve")
  .description("Run the MCP server (stdio) for AI clients (Copilot, Claude, Cursor).")
  .argument("[root]", "workspace root", ".")
  .action(async (root: string) => {
    // stderr only — stdout is reserved for the MCP JSON-RPC stream.
    console.error(BANNER);
    await runMcpServer(resolve(root));
  });

program
  .command("search")
  .description("Hybrid search for symbols.")
  .argument("<query...>", "search terms")
  .option("-r, --root <root>", "workspace root", ".")
  .option("-n, --limit <n>", "max results", "12")
  .action(async (queryParts: string[], opts: { root: string; limit: string }) => {
    const engine = new Cografy(resolve(opts.root));
    const hits = await engine.find(queryParts.join(" "), Number(opts.limit));
    for (const [i, h] of hits.entries()) {
      console.log(
        `${i + 1}. [${h.node.kind}] ${h.node.name} — ${h.node.filePath}:${h.node.startLine} (${h.score.toFixed(3)})`,
      );
    }
    engine.close();
  });

program
  .command("context")
  .description("Produce a token-budgeted context bundle for a query.")
  .argument("<query...>", "query")
  .option("-r, --root <root>", "workspace root", ".")
  .option("-b, --budget <n>", "token budget", "8000")
  .option("-f, --format <fmt>", "markdown|xml", "markdown")
  .action(
    async (
      queryParts: string[],
      opts: { root: string; budget: string; format: string },
    ) => {
      const engine = new Cografy(resolve(opts.root));
      const bundle = await engine.context(queryParts.join(" "), {
        budget: Number(opts.budget),
        format: opts.format === "xml" ? "xml" : "markdown",
      });
      console.log(bundle.formatted);
      engine.close();
    },
  );

program
  .command("trace")
  .description("Trace execution flow from a symbol.")
  .argument("<symbol>", "symbol name")
  .option("-r, --root <root>", "workspace root", ".")
  .action(async (symbol: string, opts: { root: string }) => {
    const engine = new Cografy(resolve(opts.root));
    const { root, chain } = engine.traceFlow(symbol);
    if (!root) console.log(`Symbol not found: ${symbol}`);
    else {
      console.log(`Flow from ${root.name} (${root.filePath}:${root.startLine}):`);
      for (const step of chain) {
        console.log(
          `${"  ".repeat(step.depth + 1)}${step.from.name} --${step.kind}(${step.confidence.toFixed(2)})--> ${step.to.name}`,
        );
      }
    }
    engine.close();
  });

program
  .command("impact")
  .description("Show blast radius (dependents) of a symbol.")
  .argument("<symbol>", "symbol name")
  .option("-r, --root <root>", "workspace root", ".")
  .action(async (symbol: string, opts: { root: string }) => {
    const engine = new Cografy(resolve(opts.root));
    const { target, dependents } = engine.impact(symbol);
    if (!target) console.log(`Symbol not found: ${symbol}`);
    else {
      console.log(`${dependents.length} symbols depend on ${target.name}:`);
      for (const d of dependents) console.log(`- [${d.kind}] ${d.name} — ${d.filePath}:${d.startLine}`);
    }
    engine.close();
  });

program
  .command("routes")
  .description("List detected web routes and their handlers.")
  .option("-r, --root <root>", "workspace root", ".")
  .action(async (opts: { root: string }) => {
    const engine = new Cografy(resolve(opts.root));
    for (const r of engine.routes()) {
      console.log(
        `${r.route.name} -> ${r.handler ? `${r.handler.name} (${r.handler.filePath}:${r.handler.startLine})` : "<unresolved>"}`,
      );
    }
    engine.close();
  });

program
  .command("stats")
  .description("Show index statistics.")
  .option("-r, --root <root>", "workspace root", ".")
  .action(async (opts: { root: string }) => {
    const engine = new Cografy(resolve(opts.root));
    console.log(JSON.stringify(engine.stats(), null, 2));
    engine.close();
  });

program
  .command("repomap")
  .description("Show the most important symbols by PageRank.")
  .option("-r, --root <root>", "workspace root", ".")
  .option("-n, --limit <n>", "max symbols", "25")
  .action(async (opts: { root: string; limit: string }) => {
    const engine = new Cografy(resolve(opts.root));
    for (const [i, t] of engine.importantSymbols(Number(opts.limit)).entries()) {
      console.log(
        `${i + 1}. [${t.node.kind}] ${t.node.name} — ${t.node.filePath}:${t.node.startLine} (rank ${t.rank.toFixed(3)})`,
      );
    }
    engine.close();
  });

program
  .command("deadcode")
  .description("List dead-code candidates (unreachable, uncalled functions).")
  .option("-r, --root <root>", "workspace root", ".")
  .action(async (opts: { root: string }) => {
    const engine = new Cografy(resolve(opts.root));
    const dead = engine.deadCode();
    console.log(`${dead.length} dead-code candidates:`);
    for (const d of dead) console.log(`- [${d.kind}] ${d.name} — ${d.filePath}:${d.startLine}`);
    engine.close();
  });

program
  .command("metrics")
  .description("Show call-graph resolution quality metrics.")
  .option("-r, --root <root>", "workspace root", ".")
  .action(async (opts: { root: string }) => {
    const engine = new Cografy(resolve(opts.root));
    console.log(JSON.stringify(engine.metrics(), null, 2));
    engine.close();
  });

program
  .command("export")
  .description("Export the graph to an interactive HTML page (or DOT/JSON).")
  .option("-r, --root <root>", "workspace root", ".")
  .option("-f, --format <fmt>", "html | dot | json", "html")
  .option("-o, --out <file>", "output file (default cografy-graph.<ext>)")
  .option("--focus <symbol>", "center the graph on a symbol")
  .option("--depth <n>", "neighborhood hops when focused", "2")
  .option("--limit <n>", "max nodes for whole-graph export", "300")
  .option("--open", "open the result in your browser (html only)")
  .action(
    async (opts: {
      root: string;
      format: string;
      out?: string;
      focus?: string;
      depth: string;
      limit: string;
      open?: boolean;
    }) => {
      const engine = new Cografy(resolve(opts.root));
      const format = opts.format === "dot" ? "dot" : opts.format === "json" ? "json" : "html";
      const content = engine.renderGraph({
        format,
        focus: opts.focus,
        depth: Number(opts.depth),
        limit: Number(opts.limit),
      });
      const ext = format === "dot" ? "dot" : format === "json" ? "json" : "html";
      const out = resolve(opts.out ?? `cografy-graph.${ext}`);
      writeFileSync(out, content, "utf8");
      const { nodes, edges } = engine.graphData({
        focus: opts.focus,
        depth: Number(opts.depth),
        limit: Number(opts.limit),
      });
      console.log(`Wrote ${out} (${nodes.length} nodes, ${edges.length} edges).`);
      engine.close();
      if (opts.open && format === "html") openInBrowser(out);
    },
  );

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});

function openInBrowser(file: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(cmd, [file], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
}
