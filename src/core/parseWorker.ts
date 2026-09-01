import { parentPort } from "node:worker_threads";
import { parseFile } from "../parsers/registry.js";

/** Worker entry: parse a file's source into graph nodes/edges/call-sites. */
parentPort?.on("message", async (msg: { id: number; filePath: string; source: string }) => {
  try {
    const result = await parseFile(msg.filePath, msg.source);
    parentPort!.postMessage({ id: msg.id, result });
  } catch (err) {
    parentPort!.postMessage({ id: msg.id, error: (err as Error).message });
  }
});
