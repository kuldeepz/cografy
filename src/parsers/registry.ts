import type { ParseResult } from "../types.js";
import { UniversalParser } from "./universal.js";
import { treeSitterParse } from "./treesitter.js";
import { detectLanguage, isAsset, assetKind, isCode } from "./languages.js";
import { nodeId } from "../core/hasher.js";

const universal = new UniversalParser();

/**
 * Parse any file into graph nodes/edges/call-sites. Code files first try the
 * precise tree-sitter parser; if no grammar is available (or it fails) they
 * fall back to the heuristic universal parser. Non-code assets become "asset"
 * nodes for multimodal linking.
 */
export async function parseFile(filePath: string, source: string): Promise<ParseResult> {
  const language = detectLanguage(filePath);

  if (isAsset(filePath)) {
    const kind = assetKind(filePath);
    const textPreview =
      kind === "markdown" || kind === "docs" || kind === "text"
        ? source.slice(0, 4000)
        : undefined;
    return {
      filePath,
      language,
      nodes: [
        {
          id: nodeId(filePath, "asset", filePath, 0),
          kind: "asset",
          name: filePath,
          filePath,
          language,
          startLine: 1,
          endLine: source ? source.split(/\r?\n/).length : 1,
          signature: `[${kind}] ${filePath}`,
          snippet: textPreview,
          meta: { assetKind: kind, text: textPreview },
        },
      ],
      edges: [],
      callSites: [],
    };
  }

  if (isCode(filePath)) {
    const ts = await treeSitterParse(filePath, source, language);
    if (ts) return ts;
  }
  return universal.parse(filePath, source, language);
}
