import type { SearchHit } from "../types.js";

/** Render a search hit as a compact Markdown context block. */
export function formatHitMarkdown(hit: SearchHit): string {
  const n = hit.node;
  const loc = `${n.filePath}:${n.startLine}-${n.endLine}`;
  const header = `### ${n.kind} \`${n.name}\`  \n\`${loc}\` · lang: ${n.language} · score: ${hit.score.toFixed(3)}`;
  const sig = n.signature ? `\n\n\`${n.signature}\`` : "";
  const body = n.snippet ? `\n\n\`\`\`${n.language}\n${n.snippet}\n\`\`\`` : "";
  return `${header}${sig}${body}`;
}

/** Render a search hit as a token-lean XML block for structured agent intake. */
export function formatHitXml(hit: SearchHit): string {
  const n = hit.node;
  const attrs =
    `kind="${n.kind}" name="${escapeAttr(n.name)}" ` +
    `file="${escapeAttr(n.filePath)}" lines="${n.startLine}-${n.endLine}" ` +
    `lang="${n.language}" score="${hit.score.toFixed(3)}"`;
  const sig = n.signature ? `\n  <signature>${escapeXml(n.signature)}</signature>` : "";
  const code = n.snippet ? `\n  <code><![CDATA[${n.snippet}]]></code>` : "";
  return `<symbol ${attrs}>${sig}${code}\n</symbol>`;
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function escapeAttr(s: string): string {
  return escapeXml(s).replace(/"/g, "&quot;");
}
