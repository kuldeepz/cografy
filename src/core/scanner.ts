import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ignoreImport from "ignore";
import type { CografyConfig } from "../types.js";

// `ignore` is published as CommonJS; normalize the callable across module interop.
const ignoreFactory = (
  (ignoreImport as unknown as { default?: unknown }).default ?? ignoreImport
) as (options?: unknown) => { add(patterns: string[]): { ignores(path: string): boolean } };

/**
 * Recursively walk the repo root, honoring exclude globs, and return the list of
 * candidate files as repo-relative POSIX paths.
 */
export function scanFiles(config: CografyConfig): string[] {
  const ig = ignoreFactory().add(config.exclude.map(globToGitignore));
  const results: string[] = [];

  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry);
      const rel = toPosix(relative(config.root, abs));
      if (!rel || rel.startsWith("..")) continue;
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (ig.ignores(rel + "/")) continue;
        walk(abs);
      } else if (st.isFile()) {
        if (ig.ignores(rel)) continue;
        if (st.size > config.maxFileBytes) continue;
        results.push(rel);
      }
    }
  };

  walk(config.root);
  return results;
}

export function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

/** Convert a glob like **\/node_modules/** to an equivalent gitignore rule. */
function globToGitignore(glob: string): string {
  let g = glob;
  if (g.startsWith("**/")) g = g.slice(3);
  if (g.endsWith("/**")) g = g.slice(0, -3);
  return g;
}
