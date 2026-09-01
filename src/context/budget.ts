import type { ContextBundle, SearchHit } from "../types.js";
import { estimateTokens } from "./tokenizer.js";
import { formatHitMarkdown, formatHitXml } from "./formatter.js";

export type ContextFormat = "markdown" | "xml";

export interface BudgetOptions {
  tokenBudget: number;
  format: ContextFormat;
  /** Trim snippets when a hit alone would blow a large share of the budget. */
  maxSnippetTokensPerHit?: number;
}

/**
 * The Harmony gatekeeper: takes ranked hits and packs the densest, most
 * relevant context that fits inside a strict token budget. Higher-scored hits
 * are admitted first; oversized snippets are trimmed rather than dropped so the
 * most relevant symbol always contributes something.
 */
export function packContext(
  query: string,
  hits: SearchHit[],
  opts: BudgetOptions,
): ContextBundle {
  const { tokenBudget, format } = opts;
  const maxPerHit = opts.maxSnippetTokensPerHit ?? Math.floor(tokenBudget / 3);

  const admitted: SearchHit[] = [];
  const blocks: string[] = [];
  let used = 0;

  const headerTokens = estimateTokens(query) + 24;
  used += headerTokens;

  for (const hit of hits) {
    let candidate = { ...hit, node: { ...hit.node } };
    let block = format === "xml" ? formatHitXml(candidate) : formatHitMarkdown(candidate);
    let cost = estimateTokens(block);

    // Trim snippet if this single hit is too large.
    if (cost > maxPerHit && candidate.node.snippet) {
      candidate.node.snippet = trimSnippet(candidate.node.snippet, maxPerHit);
      block = format === "xml" ? formatHitXml(candidate) : formatHitMarkdown(candidate);
      cost = estimateTokens(block);
    }

    if (used + cost > tokenBudget) {
      // Try a signature-only version to still reference the symbol cheaply.
      const lean = { ...candidate, node: { ...candidate.node, snippet: undefined } };
      const leanBlock = format === "xml" ? formatHitXml(lean) : formatHitMarkdown(lean);
      const leanCost = estimateTokens(leanBlock);
      if (used + leanCost <= tokenBudget) {
        admitted.push(lean);
        blocks.push(leanBlock);
        used += leanCost;
        continue;
      }
      break; // budget exhausted
    }

    admitted.push(candidate);
    blocks.push(block);
    used += cost;
  }

  const formatted =
    format === "xml"
      ? `<context query="${query.replace(/"/g, "&quot;")}" tokens="${used}">\n${blocks.join("\n")}\n</context>`
      : `# Context for: ${query}\n\n_${admitted.length} symbols · ~${used}/${tokenBudget} tokens_\n\n${blocks.join("\n\n---\n\n")}`;

  return { query, tokensUsed: used, tokenBudget, hits: admitted, formatted };
}

function trimSnippet(snippet: string, maxTokens: number): string {
  const lines = snippet.split("\n");
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = estimateTokens(line) + 1;
    if (used + cost > maxTokens) {
      out.push("// … trimmed for token budget …");
      break;
    }
    out.push(line);
    used += cost;
  }
  return out.join("\n");
}
