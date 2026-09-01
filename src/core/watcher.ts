import chokidar, { type FSWatcher } from "chokidar";
import { relative } from "node:path";
import type { CografyConfig } from "../types.js";
import type { Indexer } from "./indexer.js";
import { toPosix } from "./scanner.js";

/**
 * Always-on file watcher. Debounces bursts of saves and drives incremental
 * re-indexing so the graph is never stale — eliminating "graph drift".
 */
export class Watcher {
  private watcher?: FSWatcher;
  private pending = new Map<string, "upsert" | "remove">();
  private timer?: NodeJS.Timeout;

  constructor(
    private config: CografyConfig,
    private indexer: Indexer,
    private onChange?: (stats: { upserts: number; removes: number }) => void,
    private debounceMs = 200,
  ) {}

  start(): void {
    this.watcher = chokidar.watch(this.config.root, {
      ignored: this.config.exclude,
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 30 },
    });
    this.watcher
      .on("add", (p) => this.enqueue(p, "upsert"))
      .on("change", (p) => this.enqueue(p, "upsert"))
      .on("unlink", (p) => this.enqueue(p, "remove"));
  }

  private enqueue(absPath: string, op: "upsert" | "remove"): void {
    const rel = toPosix(relative(this.config.root, absPath));
    if (!rel || rel.startsWith("..")) return;
    this.pending.set(rel, op);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.debounceMs);
  }

  private async flush(): Promise<void> {
    const batch = [...this.pending.entries()];
    this.pending.clear();
    let upserts = 0;
    let removes = 0;
    for (const [rel, op] of batch) {
      try {
        if (op === "remove") {
          this.indexer.removeFile(rel);
          removes++;
        } else {
          await this.indexer.indexFile(rel);
          upserts++;
        }
      } catch {
        // ignore transient FS errors; next save will reconcile
      }
    }
    this.onChange?.({ upserts, removes });
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    await this.watcher?.close();
  }
}
