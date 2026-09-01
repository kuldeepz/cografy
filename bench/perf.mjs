// Reproducible performance harness. Generates synthetic repos of increasing
// size, then measures full index, incremental re-index (1 file changed), and
// query latency. Usage: npm run build && node bench/perf.mjs [sizes...]
import { Cografy } from "../dist/index.js";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";

const sizes = process.argv.slice(2).map(Number).filter(Boolean);
const SIZES = sizes.length ? sizes : [1000, 3000];

function generate(root, n) {
  mkdirSync(join(root, "src"), { recursive: true });
  for (let i = 0; i < n; i++) {
    const dep = (i + 1) % n;
    writeFileSync(
      join(root, "src", `mod${i}.ts`),
      `import { Service${dep} } from "./mod${dep}";

export class Service${i} {
  private dep = new Service${dep}();
  compute${i}(x: number): number { return this.helper${i}(x) + this.dep.value${dep}(); }
  helper${i}(x: number): number { return x * ${(i % 7) + 1}; }
  value${i}(): number { return ${i}; }
}

export function run${i}(): number {
  const s = new Service${i}();
  return s.compute${i}(${i});
}
`,
    );
  }
}

async function timed(fn) {
  const t = performance.now();
  const r = await fn();
  return { ms: performance.now() - t, r };
}

console.log("Cografy performance harness");
console.log("===========================");
console.log("node", process.version, "·", process.platform, process.arch);
console.log("");
console.log("| Files | Symbols | Full index | CLI re-index (1 file) | Watcher save (1 file) | Search |");
console.log("| ----- | ------- | ---------- | -------------------- | --------------------- | ------ |");

for (const n of SIZES) {
  const root = mkdtempSync(join(tmpdir(), `cografy-perf-${n}-`));
  try {
    generate(root, n);
    const cg = new Cografy(root, { dbPath: join(root, ".cografy", "graph.db") });

    const full = await timed(() => cg.index());

    appendFileSync(join(root, "src", "mod0.ts"), "\n// touch\n");
    const incr = await timed(() => cg.index());

    // Watcher path: incremental single-file re-resolution (no full re-hash).
    // Warm up once (absorbs the post-full-index WAL checkpoint), then average.
    appendFileSync(join(root, "src", "mod1.ts"), "\n// warmup\n");
    await cg.indexer.indexFile("src/mod1.ts");
    let saveTotal = 0;
    const saveRuns = 5;
    for (let s = 0; s < saveRuns; s++) {
      const f = `src/mod${2 + s}.ts`;
      appendFileSync(join(root, f), `\n// save${s}\n`);
      saveTotal += (await timed(() => cg.indexer.indexFile(f))).ms;
    }
    const save = { ms: saveTotal / saveRuns };

    const queries = ["compute value", "service dependency", "helper run", "value compute"];
    let searchTotal = 0;
    for (const q of queries) searchTotal += (await timed(() => cg.find(q, 5))).ms;
    const searchAvg = searchTotal / queries.length;

    const stats = cg.stats();
    console.log(
      `| ${n} | ${stats.nodes} | ${full.ms.toFixed(0)}ms | ${incr.ms.toFixed(0)}ms | ${save.ms.toFixed(0)}ms | ${searchAvg.toFixed(0)}ms |`,
    );
    cg.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("");
console.log("Full index & CLI re-index re-hash all files (Merkle snapshot). The watcher save path");
console.log("re-resolves only affected files — its cost should stay roughly flat as the repo grows.");
