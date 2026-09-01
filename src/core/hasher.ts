import { createHash } from "node:crypto";

/** Deterministic content hash used for node ids and Merkle leaves. */
export function hashContent(...parts: (string | number)[]): string {
  const h = createHash("sha1");
  for (const p of parts) h.update(String(p));
  h.update("\0");
  return h.digest("hex");
}

/** Short stable id for a node given its defining coordinates. */
export function nodeId(
  filePath: string,
  kind: string,
  name: string,
  startLine: number,
): string {
  return hashContent(filePath, kind, name, startLine).slice(0, 20);
}

export function edgeId(kind: string, fromId: string, toId: string): string {
  return hashContent(kind, fromId, toId).slice(0, 20);
}
