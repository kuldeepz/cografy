import { test } from "node:test";
import assert from "node:assert/strict";
import { Cografy } from "../dist/index.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");

async function indexFixtures() {
  const tmp = mkdtempSync(join(tmpdir(), "cografy-test-"));
  const cg = new Cografy(fixtures, { dbPath: join(tmp, "graph.db") });
  await cg.index();
  return { cg, tmp };
}

function callEdges(cg) {
  return cg.store.allEdgesOfKinds(["calls"]).map((e) => {
    const from = cg.store.getNode(e.fromId);
    const to = cg.store.getNode(e.toId);
    return { caller: from?.name, callee: to?.name, calleeParent: to?.meta?.parent, confidence: e.confidence };
  });
}

test("same-named methods are NOT merged (describe -> UserService.getName)", async () => {
  const { cg, tmp } = await indexFixtures();
  try {
    const edges = callEdges(cg);
    const describeToGetName = edges.filter((e) => e.caller === "describe" && e.callee === "getName");
    assert.ok(describeToGetName.length >= 1, "expected describe -> getName edge");
    assert.ok(
      describeToGetName.every((e) => e.calleeParent === "UserService"),
      "describe must only call UserService.getName, never ProductService.getName",
    );
    assert.ok(
      describeToGetName.some((e) => e.confidence >= 0.9),
      "scoped resolution should be high-confidence",
    );

    const labelToGetName = edges.filter((e) => e.caller === "label" && e.callee === "getName");
    assert.ok(
      labelToGetName.every((e) => e.calleeParent === "ProductService"),
      "label must only call ProductService.getName",
    );
  } finally {
    cg.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("instance receiver-type inference disambiguates shared method names", async () => {
  const { cg, tmp } = await indexFixtures();
  try {
    const edges = callEdges(cg);
    const pickUser = edges.filter((e) => e.caller === "pickUser" && e.callee === "getName");
    const pickProduct = edges.filter((e) => e.caller === "pickProduct" && e.callee === "getName");
    assert.ok(pickUser.length >= 1 && pickUser.every((e) => e.calleeParent === "UserService"),
      "pickUser (u = new UserService) must call UserService.getName");
    assert.ok(pickProduct.length >= 1 && pickProduct.every((e) => e.calleeParent === "ProductService"),
      "pickProduct (p = new ProductService) must call ProductService.getName");
  } finally {
    cg.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("cross-language internal calls resolve (python/go/java/rust)", async () => {
  const { cg, tmp } = await indexFixtures();
  try {
    const edges = callEdges(cg);
    const has = (caller, callee) => edges.some((e) => e.caller === caller && e.callee === callee);
    assert.ok(has("compute", "add"), "python/java compute -> add");
    assert.ok(has("run", "helper"), "go/rust run -> helper");
    assert.ok(has("main", "run"), "go/rust main -> run");
  } finally {
    cg.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
