import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { availableParallelism } from "node:os";
import type { ParseResult } from "../types.js";

interface Pending {
  resolve: (r: ParseResult | null) => void;
}

/**
 * A small pool of parse workers. Tree-sitter WASM parsing is CPU-bound and
 * single-threaded per parser; spreading files across workers cuts full-index
 * time on large repos. DB writes stay on the main thread (SQLite is serial).
 */
export class ParsePool {
  private workers: Worker[] = [];
  private free: Worker[] = [];
  private queue: { filePath: string; source: string; p: Pending }[] = [];
  private pending = new Map<number, Pending>();
  private seq = 0;

  constructor(size = Math.max(2, Math.min(availableParallelism(), 8))) {
    const url = new URL("./parseWorker.js", import.meta.url);
    const path = fileURLToPath(url);
    for (let i = 0; i < size; i++) {
      const w = new Worker(path);
      w.on("message", (msg: { id: number; result?: ParseResult; error?: string }) => {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          p.resolve(msg.error ? null : msg.result ?? null);
        }
        this.free.push(w);
        this.drain();
      });
      w.on("error", () => {}); // failures fall back to null → caller re-parses inline
      this.workers.push(w);
      this.free.push(w);
    }
  }

  parse(filePath: string, source: string): Promise<ParseResult | null> {
    return new Promise((resolve) => {
      this.queue.push({ filePath, source, p: { resolve } });
      this.drain();
    });
  }

  private drain(): void {
    while (this.free.length && this.queue.length) {
      const w = this.free.pop()!;
      const job = this.queue.shift()!;
      const id = this.seq++;
      this.pending.set(id, job.p);
      w.postMessage({ id, filePath: job.filePath, source: job.source });
    }
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.terminate()));
    this.workers = [];
    this.free = [];
  }
}
