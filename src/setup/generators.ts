import { mkdirSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_FILENAME, type CografyFileConfig } from "../config.js";

/** Absolute path to this installed CLI entry (dist/cli.js). */
export function cliEntry(): string {
  // setup/generators.js -> ../cli.js
  return join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
}

export function writeConfigFile(root: string, cfg: CografyFileConfig): string {
  const path = join(root, CONFIG_FILENAME);
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  return path;
}

export function writeVscodeMcp(root: string, cli: string): string {
  const dir = join(root, ".vscode");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "mcp.json");
  const content = {
    servers: {
      cografy: { type: "stdio", command: "node", args: [cli, "serve", "${workspaceFolder}"] },
    },
  };
  writeFileSync(path, JSON.stringify(content, null, 2) + "\n", "utf8");
  return path;
}

export function writeClaudeMcp(root: string, cli: string): string {
  const path = join(root, ".mcp.json");
  const content = {
    mcpServers: {
      cografy: { command: "node", args: [cli, "serve", "."] },
    },
  };
  writeFileSync(path, JSON.stringify(content, null, 2) + "\n", "utf8");
  return path;
}

const STEERING_BODY = `## Using Cografy (codebase intelligence)

This repo is indexed by **Cografy**, an MCP server that exposes a live, precise
code graph. Prefer its tools over reading many files by hand:

- **Before answering questions about the codebase or opening several files**, call
  \`cografy_context\` to get ranked, token-budgeted context for your query.
- To understand an execution path, call \`cografy_trace_flow\` with the entry symbol.
- **Before changing shared code**, call \`cografy_impact\` to see what depends on it.
- To orient in an unfamiliar area, call \`cografy_repomap\`.
- To locate where something lives, call \`cografy_search\`.

These tools are fast and always up to date (the index follows file changes), so
rely on them for structural questions instead of guessing.
`;

export function writeSteering(root: string, kind: "claude" | "copilot"): string {
  const path =
    kind === "claude" ? join(root, "CLAUDE.md") : join(root, ".github", "copilot-instructions.md");
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    // Don't clobber existing guidance — append our section.
    appendFileSync(path, `\n\n${STEERING_BODY}`, "utf8");
  } else {
    const header = kind === "claude" ? "# Project guidance" : "# Copilot instructions";
    writeFileSync(path, `${header}\n\n${STEERING_BODY}`, "utf8");
  }
  return path;
}
