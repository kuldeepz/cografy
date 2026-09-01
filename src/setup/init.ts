import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { CografyFileConfig } from "../config.js";
import {
  cliEntry,
  writeConfigFile,
  writeVscodeMcp,
  writeClaudeMcp,
  writeSteering,
} from "./generators.js";

interface Choice {
  label: string;
  value: string;
}

/**
 * A prompt reader that works both interactively (TTY) and with piped/redirected
 * input (reads all lines up front, falls back to defaults past EOF).
 */
class Prompter {
  private rl?: ReturnType<typeof createInterface>;
  private queue: string[] = [];
  private piped: boolean;

  constructor(preread: string[] | null) {
    this.piped = preread !== null;
    if (preread) this.queue = preread;
    else this.rl = createInterface({ input: stdin, output: stdout });
  }

  static async create(): Promise<Prompter> {
    if (stdin.isTTY) return new Prompter(null);
    const chunks: Buffer[] = [];
    for await (const c of stdin) chunks.push(c as Buffer);
    const lines = Buffer.concat(chunks).toString("utf8").split(/\r?\n/);
    return new Prompter(lines);
  }

  async ask(prompt: string): Promise<string> {
    if (this.piped) {
      stdout.write(prompt);
      const line = this.queue.shift() ?? "";
      stdout.write(line + "\n");
      return line.trim();
    }
    return (await this.rl!.question(prompt)).trim();
  }

  close(): void {
    this.rl?.close();
  }
}

export async function runInit(root: string): Promise<void> {
  const p = await Prompter.create();
  const written: string[] = [];
  try {
    console.log("\n  ◍ Cografy setup\n  Answer a few questions to configure this repo.\n");

    const profile = await choose(p, "Repo size / profile", [
      { label: "personal — small/medium repos, simplest & fastest", value: "personal" },
      { label: "monorepo — large repos, enable scale features", value: "monorepo" },
      { label: "auto — decide from repo size (recommended)", value: "auto" },
    ], 2);

    const embeddings = await choose(p, "Embeddings for semantic search", [
      { label: "local — zero download, instant (default)", value: "local" },
      { label: "transformers — all-MiniLM-L6-v2, better quality (downloads model)", value: "transformers" },
      { label: "ollama — nomic-embed-text via local daemon", value: "ollama" },
    ], 0);

    const viewer = await choose(p, "Graph viewer", [
      { label: "inline — works fully offline (recommended)", value: "inline" },
      { label: "cdn — richer vis-network renderer (needs network)", value: "cdn" },
    ], 0);

    const clients = await multiChoose(p, "Wire up which AI clients? (comma-separated, blank for none)", [
      { label: "GitHub Copilot (VS Code) — writes .vscode/mcp.json", value: "copilot" },
      { label: "Claude Code — writes .mcp.json", value: "claude" },
    ]);

    const steering = await yesNo(p, "Generate an agent steering file (tells the agent to use Cografy)?", true);

    const cfg: CografyFileConfig = {
      profile: profile as CografyFileConfig["profile"],
      embeddings: embeddings as CografyFileConfig["embeddings"],
      viewer: viewer as CografyFileConfig["viewer"],
    };
    written.push(writeConfigFile(root, cfg));

    const cli = cliEntry();
    if (clients.includes("copilot")) written.push(writeVscodeMcp(root, cli));
    if (clients.includes("claude")) written.push(writeClaudeMcp(root, cli));
    if (steering) {
      if (clients.includes("claude")) written.push(writeSteering(root, "claude"));
      if (clients.includes("copilot") || !clients.includes("claude")) {
        written.push(writeSteering(root, "copilot"));
      }
    }

    console.log("  Wrote:");
    for (const w of written) console.log(`   • ${w}`);
    console.log("\n  Next:");
    console.log("   1. cografy index .        # build the graph");
    console.log("   2. cografy serve .        # or let your AI client start it via MCP");
    if (embeddings !== "local") {
      console.log(`\n  Note: embeddings=${embeddings} — first index downloads/uses the model.`);
    }
    console.log("");
  } finally {
    p.close();
  }
}

async function choose(p: Prompter, question: string, choices: Choice[], defaultIdx: number): Promise<string> {
  console.log(`  ${question}:`);
  choices.forEach((c, i) => console.log(`    ${i + 1}) ${c.label}`));
  const ans = await p.ask(`  choice [${defaultIdx + 1}]: `);
  const idx = ans ? Number(ans) - 1 : defaultIdx;
  const pick = choices[idx] ?? choices[defaultIdx];
  console.log(`   → ${pick.value}\n`);
  return pick.value;
}

async function multiChoose(p: Prompter, question: string, choices: Choice[]): Promise<string[]> {
  console.log(`  ${question}:`);
  choices.forEach((c, i) => console.log(`    ${i + 1}) ${c.label}`));
  const ans = await p.ask("  choices: ");
  if (!ans) {
    console.log("   → none\n");
    return [];
  }
  const picked = ans
    .split(/[,\s]+/)
    .map((n) => choices[Number(n) - 1]?.value)
    .filter((v): v is string => !!v);
  console.log(`   → ${picked.join(", ") || "none"}\n`);
  return picked;
}

async function yesNo(p: Prompter, question: string, def: boolean): Promise<boolean> {
  const ans = (await p.ask(`  ${question} (${def ? "Y/n" : "y/N"}): `)).toLowerCase();
  const result = ans ? ans.startsWith("y") : def;
  console.log(`   → ${result ? "yes" : "no"}\n`);
  return result;
}
