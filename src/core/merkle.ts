import { hashContent } from "./hasher.js";

/**
 * A Merkle tree over the set of indexed files. Each leaf is the hash of a file's
 * content; internal nodes hash their sorted children. The root hash lets us
 * detect at a glance whether *anything* in the repo changed, and per-leaf
 * comparison tells us exactly which files need re-parsing — enabling
 * millisecond incremental re-indexing instead of full rescans.
 */
export class MerkleIndex {
  /** path -> content hash */
  private leaves = new Map<string, string>();
  private cachedRoot: string | null = null;

  constructor(initial?: Iterable<[string, string]>) {
    if (initial) {
      for (const [path, hash] of initial) this.leaves.set(path, hash);
    }
  }

  get size(): number {
    return this.leaves.size;
  }

  getHash(path: string): string | undefined {
    return this.leaves.get(path);
  }

  entries(): IterableIterator<[string, string]> {
    return this.leaves.entries();
  }

  /** Returns true if the leaf changed (new or different hash). */
  set(path: string, hash: string): boolean {
    const prev = this.leaves.get(path);
    if (prev === hash) return false;
    this.leaves.set(path, hash);
    this.cachedRoot = null;
    return true;
  }

  delete(path: string): boolean {
    const existed = this.leaves.delete(path);
    if (existed) this.cachedRoot = null;
    return existed;
  }

  /**
   * Compare a fresh snapshot of {path -> hash} against the current index and
   * return the exact delta the indexer must apply.
   */
  diff(snapshot: Map<string, string>): {
    added: string[];
    changed: string[];
    removed: string[];
  } {
    const added: string[] = [];
    const changed: string[] = [];
    const removed: string[] = [];

    for (const [path, hash] of snapshot) {
      const prev = this.leaves.get(path);
      if (prev === undefined) added.push(path);
      else if (prev !== hash) changed.push(path);
    }
    for (const path of this.leaves.keys()) {
      if (!snapshot.has(path)) removed.push(path);
    }
    return { added, changed, removed };
  }

  /** Root hash computed over sorted leaves. Cached until the tree mutates. */
  root(): string {
    if (this.cachedRoot) return this.cachedRoot;
    let level = [...this.leaves.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, hash]) => hashContent(path, hash));

    if (level.length === 0) {
      this.cachedRoot = hashContent("empty");
      return this.cachedRoot;
    }

    while (level.length > 1) {
      const next: string[] = [];
      for (let i = 0; i < level.length; i += 2) {
        const left = level[i];
        const right = level[i + 1] ?? left; // duplicate last on odd count
        next.push(hashContent(left, right));
      }
      level = next;
    }
    this.cachedRoot = level[0];
    return this.cachedRoot;
  }
}
