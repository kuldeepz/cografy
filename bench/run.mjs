// Measures cross-file call-resolution quality against ground-truth fixtures.
// Usage: npm run build && node bench/run.mjs
import { Cografy } from "../dist/index.js";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");
const gt = JSON.parse(readFileSync(join(here, "ground-truth.json"), "utf8"));

const tmp = mkdtempSync(join(tmpdir(), "cografy-bench-"));
const cg = new Cografy(fixtures, { dbPath: join(tmp, "graph.db") });

const stats = await cg.index();

// Collect resolved internal call edges (both endpoints are defined symbols).
const resolved = [];
for (const e of cg.store.allEdgesOfKinds(["calls"])) {
  const from = cg.store.getNode(e.fromId);
  const to = cg.store.getNode(e.toId);
  if (!from || !to) continue;
  resolved.push({
    caller: from.name,
    callee: to.name,
    calleeParent: to.meta?.parent,
    calleeFile: to.filePath,
    confidence: e.confidence,
  });
}

const expected = gt.edges;
let found = 0;
let disambiguationErrors = 0;
const perLang = new Map();
const matchedConfidences = [];

for (const exp of expected) {
  const lang = exp.lang;
  if (!perLang.has(lang)) perLang.set(lang, { found: 0, total: 0 });
  perLang.get(lang).total++;

  const match = resolved.find(
    (r) =>
      r.caller === exp.caller &&
      r.callee === exp.callee &&
      (exp.calleeParent === undefined || r.calleeParent === exp.calleeParent),
  );
  if (match) {
    found++;
    perLang.get(lang).found++;
    matchedConfidences.push(match.confidence);
  }

  // Disambiguation error: an edge with the right names but WRONG parent.
  if (exp.calleeParent) {
    const wrong = resolved.find(
      (r) => r.caller === exp.caller && r.callee === exp.callee && r.calleeParent && r.calleeParent !== exp.calleeParent,
    );
    if (wrong) disambiguationErrors++;
  }
}

// Precision: of internal call edges, how many are correct per ground truth.
let correctInternal = 0;
for (const r of resolved) {
  const ok = expected.some(
    (exp) =>
      exp.caller === r.caller &&
      exp.callee === r.callee &&
      (exp.calleeParent === undefined || exp.calleeParent === r.calleeParent),
  );
  if (ok) correctInternal++;
}

const recall = expected.length ? found / expected.length : 0;
const precision = resolved.length ? correctInternal / resolved.length : 0;
const avgConf = matchedConfidences.length
  ? matchedConfidences.reduce((a, b) => a + b, 0) / matchedConfidences.length
  : 0;

console.log("Cografy resolver benchmark");
console.log("============================");
console.log(`Fixtures: ${stats.scanned} files, ${stats.durationMs}ms index`);
console.log(`Internal call edges resolved: ${resolved.length}`);
console.log("");
console.log("Per-language recall:");
for (const [lang, r] of perLang) {
  console.log(`  ${lang.padEnd(12)} ${r.found}/${r.total}`);
}
console.log("");
console.log(`Recall (expected edges found):    ${(recall * 100).toFixed(1)}%  (${found}/${expected.length})`);
console.log(`Precision (resolved edges correct): ${(precision * 100).toFixed(1)}%  (${correctInternal}/${resolved.length})`);
console.log(`Avg confidence of matched edges:  ${avgConf.toFixed(2)}`);
console.log(`Same-name disambiguation errors:  ${disambiguationErrors}`);

cg.close();
rmSync(tmp, { recursive: true, force: true });

const pass = recall >= 0.8 && disambiguationErrors === 0;
console.log("");
console.log(pass ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(pass ? 0 : 1);
