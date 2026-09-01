import { posix } from "node:path";
import type { CallSite, CodeEdge, CodeNode } from "../types.js";
import type { GraphStore } from "./store.js";
import { edgeId } from "../core/hasher.js";

const CODE_EXTS = [
  "",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".rb", ".php",
  ".cs", ".kt", ".cpp", ".c", ".swift", ".scala",
];

const RESOLVED_KINDS = ["calls", "handles", "extends", "implements"];

/**
 * In-memory index over the graph's symbols, imports and call sites. Supports a
 * full build plus incremental per-file updates, so the watcher can re-resolve
 * only the files affected by a change instead of the whole repo — keeping
 * per-save cost roughly constant regardless of repo size.
 */
export class ResolutionIndex {
  nodesById = new Map<string, CodeNode>();
  byName = new Map<string, CodeNode[]>(); // functions + methods
  byQualified = new Map<string, CodeNode>(); // `Parent.name`
  classByName = new Map<string, CodeNode[]>();
  typeByName = new Map<string, CodeNode[]>(); // classes + interfaces
  symbolsByFile = new Map<string, CodeNode[]>(); // funcs/methods/classes/interfaces per file
  routesByFile = new Map<string, CodeNode[]>();
  callSitesByFile = new Map<string, CallSite[]>();
  importSpecsByFile = new Map<string, string[]>();
  importsByFile = new Map<string, Set<string>>();
  callersByName = new Map<string, Set<string>>(); // callee name -> files with a call site to it
  handlerFilesByName = new Map<string, Set<string>>(); // handler name -> route files referencing it
  superFilesByName = new Map<string, Set<string>>(); // super name -> subclass files referencing it
  fileSet = new Set<string>();

  static build(store: GraphStore): ResolutionIndex {
    const ix = new ResolutionIndex();
    ix.fileSet = new Set(store.loadLeaves().keys());
    for (const f of store.allNodesOfKinds(["function", "method"])) ix.addSymbol(f);
    for (const c of store.allNodesOfKinds(["class", "interface"])) ix.addSymbol(c);
    for (const r of store.allNodesOfKinds(["route"])) ix.addRoute(r);
    for (const imp of store.allNodesOfKinds(["import"])) push(ix.importSpecsByFile, imp.filePath, imp.name);
    for (const cs of store.allCallSites()) ix.addCallSite(cs);
    for (const file of new Set([...ix.importSpecsByFile.keys()])) ix.recomputeImports(file);
    return ix;
  }

  private addSymbol(n: CodeNode): void {
    this.nodesById.set(n.id, n);
    push(this.symbolsByFile, n.filePath, n);
    if (n.kind === "function" || n.kind === "method") {
      push(this.byName, n.name, n);
      const parent = n.meta?.parent as string | undefined;
      if (parent) this.byQualified.set(`${parent}.${n.name}`, n);
    } else {
      push(this.classByName, n.name, n);
      push(this.typeByName, n.name, n);
      for (const sup of (n.meta?.supers as string[] | undefined) ?? []) addToSet(this.superFilesByName, sup, n.filePath);
    }
  }

  private addRoute(r: CodeNode): void {
    push(this.routesByFile, r.filePath, r);
    const h = r.meta?.handlerName as string | undefined;
    if (h) addToSet(this.handlerFilesByName, h, r.filePath);
  }

  private addCallSite(cs: CallSite): void {
    push(this.callSitesByFile, cs.filePath, cs);
    let set = this.callersByName.get(cs.calleeName);
    if (!set) this.callersByName.set(cs.calleeName, (set = new Set()));
    set.add(cs.filePath);
  }

  private recomputeImports(file: string): void {
    const specs = this.importSpecsByFile.get(file) ?? [];
    const set = new Set<string>();
    for (const spec of specs) {
      const t = resolveSpecifier(file, spec, this.fileSet);
      if (t) set.add(t);
    }
    this.importsByFile.set(file, set);
  }

  /**
   * Refresh the index for a single file after it was re-parsed. Returns the set
   * of files whose resolved edges may have changed (the file itself plus callers
   * that reference any symbol name it used to or now defines).
   */
  updateFile(store: GraphStore, file: string): Set<string> {
    const affected = new Set<string>([file]);
    const oldNames = new Set((this.symbolsByFile.get(file) ?? []).map((n) => n.name));

    // Remove old state for this file.
    for (const n of this.symbolsByFile.get(file) ?? []) {
      this.nodesById.delete(n.id);
      removeFrom(this.byName, n.name, n);
      removeFrom(this.classByName, n.name, n);
      removeFrom(this.typeByName, n.name, n);
      const parent = n.meta?.parent as string | undefined;
      if (parent && this.byQualified.get(`${parent}.${n.name}`)?.id === n.id) {
        this.byQualified.delete(`${parent}.${n.name}`);
      }
      for (const sup of (n.meta?.supers as string[] | undefined) ?? []) this.superFilesByName.get(sup)?.delete(file);
    }
    for (const r of this.routesByFile.get(file) ?? []) {
      const h = r.meta?.handlerName as string | undefined;
      if (h) this.handlerFilesByName.get(h)?.delete(file);
    }
    this.symbolsByFile.delete(file);
    this.routesByFile.delete(file);
    for (const cs of this.callSitesByFile.get(file) ?? []) {
      this.callersByName.get(cs.calleeName)?.delete(file);
    }
    this.callSitesByFile.delete(file);

    // Add new state (only if the file still exists in the graph).
    const fresh = store.db
      .prepare(`SELECT * FROM nodes WHERE file_path = ?`)
      .all(file) as any[];
    if (fresh.length > 0) this.fileSet.add(file);
    else this.fileSet.delete(file);
    const newNames = new Set<string>();
    for (const row of fresh) {
      const n = rowToNode(row);
      if (n.kind === "function" || n.kind === "method" || n.kind === "class" || n.kind === "interface") {
        this.addSymbol(n);
        newNames.add(n.name);
      } else if (n.kind === "route") {
        this.addRoute(n);
      }
    }
    this.importSpecsByFile.set(
      file,
      (store.db.prepare(`SELECT name FROM nodes WHERE file_path = ? AND kind = 'import'`).all(file) as any[]).map(
        (r) => r.name as string,
      ),
    );
    this.recomputeImports(file);
    for (const cs of store.callSitesForFile(file)) this.addCallSite(cs);

    // Callers referencing any name this file used to or now defines must re-resolve.
    for (const name of new Set([...oldNames, ...newNames])) {
      for (const caller of this.callersByName.get(name) ?? []) affected.add(caller);
      for (const rf of this.handlerFilesByName.get(name) ?? []) affected.add(rf);
      for (const sf of this.superFilesByName.get(name) ?? []) affected.add(sf);
    }
    return affected;
  }

  /** Compute the resolved edges (calls/handles/extends/implements) for one file. */
  resolveFileEdges(file: string): CodeEdge[] {
    const edges = new Map<string, CodeEdge>();
    const add = (kind: CodeEdge["kind"], from: string, to: string, conf: number) => {
      if (from === to) return;
      const id = edgeId(kind, from, to);
      const prev = edges.get(id);
      if (!prev || prev.confidence < conf) {
        edges.set(id, { id, kind, fromId: from, toId: to, confidence: conf, meta: { filePath: file } });
      }
    };

    for (const cs of this.callSitesByFile.get(file) ?? []) this.resolveCallSite(cs, add);

    for (const route of this.routesByFile.get(file) ?? []) {
      const handlerName = route.meta?.handlerName as string | undefined;
      if (!handlerName) continue;
      const candidates = this.byName.get(handlerName);
      if (!candidates || !candidates.length) continue;
      const sameFile = candidates.filter((c) => c.filePath === route.filePath);
      const target = sameFile.length === 1 ? sameFile[0] : candidates.length === 1 ? candidates[0] : sameFile[0] ?? candidates[0];
      if (target) {
        const conf = sameFile.length === 1 ? 0.95 : candidates.length === 1 ? 0.85 : 0.5;
        add("handles", route.id, target.id, conf);
      }
    }

    for (const t of this.symbolsByFile.get(file) ?? []) {
      if (t.kind !== "class" && t.kind !== "interface") continue;
      const supers = (t.meta?.supers as string[] | undefined) ?? [];
      for (const sup of supers) {
        const targets = this.typeByName.get(sup);
        if (targets && targets.length >= 1) {
          const target = targets[0];
          const kind = target.kind === "interface" ? "implements" : "extends";
          add(kind, t.id, target.id, targets.length === 1 ? 0.95 : 0.6);
        }
      }
    }
    return [...edges.values()];
  }

  private resolveCallSite(cs: CallSite, add: (k: CodeEdge["kind"], f: string, t: string, c: number) => void): void {
    const caller = this.nodesById.get(cs.callerId);
    const callerClass = caller?.meta?.parent as string | undefined;
    const candidates = this.byName.get(cs.calleeName);
    if (!candidates || candidates.length === 0) return;
    const recv = cs.receiver;
    const callerFile = caller?.filePath ?? cs.filePath;
    let resolved = false;

    if ((recv === "this" || recv === "self") && callerClass) {
      const q = this.byQualified.get(`${callerClass}.${cs.calleeName}`);
      if (q) { add("calls", cs.callerId, q.id, 1.0); resolved = true; }
    }
    if (!resolved && recv && this.classByName.has(recv)) {
      const q = this.byQualified.get(`${recv}.${cs.calleeName}`);
      if (q) { add("calls", cs.callerId, q.id, 0.95); resolved = true; }
    }
    if (!resolved && recv && caller) {
      const type = inferReceiverType(caller, recv);
      if (type) {
        const q = this.byQualified.get(`${type}.${cs.calleeName}`);
        if (q) { add("calls", cs.callerId, q.id, 0.95); resolved = true; }
      }
    }
    if (!resolved) {
      const sameFile = candidates.filter((c) => c.filePath === callerFile);
      if (sameFile.length === 1) { add("calls", cs.callerId, sameFile[0].id, 0.95); resolved = true; }
      else if (sameFile.length > 1) {
        const inClass = sameFile.filter((c) => (c.meta?.parent as string) === callerClass);
        if (inClass.length === 1) { add("calls", cs.callerId, inClass[0].id, 0.95); resolved = true; }
        else { for (const c of sameFile.slice(0, 3)) add("calls", cs.callerId, c.id, 0.5); resolved = true; }
      }
    }
    if (!resolved) {
      const importedFiles = this.importsByFile.get(callerFile);
      const imported = importedFiles ? candidates.filter((c) => importedFiles.has(c.filePath)) : [];
      if (imported.length === 1) { add("calls", cs.callerId, imported[0].id, 0.9); resolved = true; }
      else if (imported.length > 1) { for (const c of imported.slice(0, 3)) add("calls", cs.callerId, c.id, 0.6); resolved = true; }
    }
    if (!resolved) {
      if (candidates.length === 1) add("calls", cs.callerId, candidates[0].id, 0.8);
      else if (candidates.length <= 3) for (const c of candidates) add("calls", cs.callerId, c.id, 0.4);
    }
  }

  /** Resolve a specific set of files: replace only their resolved edges. */
  resolveFiles(store: GraphStore, files: Iterable<string>): void {
    const all: CodeEdge[] = [];
    const fileList = [...files];
    for (const f of fileList) all.push(...this.resolveFileEdges(f));
    const tx = store.db.transaction(() => {
      for (const f of fileList) store.deleteEdgesForFileByKind(f, RESOLVED_KINDS);
      store.insertEdges(all);
    });
    tx();
  }
}

/** Full re-resolution from scratch (used by the full index pass and tests). */
export function resolveAll(store: GraphStore): ResolutionIndex {
  const ix = ResolutionIndex.build(store);
  const allFiles = new Set<string>([
    ...ix.callSitesByFile.keys(),
    ...ix.routesByFile.keys(),
    ...ix.symbolsByFile.keys(),
  ]);
  const edges: CodeEdge[] = [];
  for (const f of allFiles) edges.push(...ix.resolveFileEdges(f));
  const tx = store.db.transaction(() => {
    store.deleteEdgesByKind(RESOLVED_KINDS);
    store.insertEdges(edges);
  });
  tx();
  return ix;
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  let arr = map.get(key);
  if (!arr) map.set(key, (arr = []));
  arr.push(value);
}

function addToSet(map: Map<string, Set<string>>, key: string, value: string): void {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  set.add(value);
}

function removeFrom(map: Map<string, CodeNode[]>, key: string, node: CodeNode): void {
  const arr = map.get(key);
  if (!arr) return;
  const filtered = arr.filter((n) => n.id !== node.id);
  if (filtered.length) map.set(key, filtered);
  else map.delete(key);
}

function inferReceiverType(caller: CodeNode, receiver: string): string | undefined {
  const text = `${caller.signature ?? ""}\n${caller.snippet ?? ""}`;
  const r = receiver.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns: RegExp[] = [
    new RegExp(`\\b${r}\\s*(?::\\s*[A-Za-z_$][\\w$]*)?\\s*=\\s*new\\s+([A-Za-z_$][\\w$]*)`),
    new RegExp(`\\b([A-Za-z_$][\\w$]*)\\s+${r}\\s*=`),
    new RegExp(`\\b${r}\\s*:\\s*([A-Za-z_$][\\w$]*)`),
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m && m[1] && /^[A-Z]/.test(m[1])) return m[1];
  }
  return undefined;
}

function resolveSpecifier(importerFile: string, spec: string, fileSet: Set<string>): string | undefined {
  const dir = posix.dirname(importerFile);
  const candidates: string[] = [];
  if (spec.startsWith(".")) {
    const base = posix.normalize(posix.join(dir, spec));
    for (const ext of CODE_EXTS) candidates.push(base + ext);
    for (const ext of CODE_EXTS) if (ext) candidates.push(posix.join(base, "index" + ext));
  } else if (spec.includes("/")) {
    for (const ext of CODE_EXTS) candidates.push(posix.normalize(spec) + ext);
  } else if (spec.includes(".")) {
    const asPath = spec.replace(/\./g, "/");
    for (const ext of CODE_EXTS) candidates.push(asPath + ext);
    for (const ext of CODE_EXTS) candidates.push(posix.normalize(posix.join(dir, asPath)) + ext);
  } else {
    const asPath = posix.normalize(posix.join(dir, spec));
    for (const ext of CODE_EXTS) if (ext) candidates.push(asPath + ext);
    for (const ext of CODE_EXTS) if (ext) candidates.push(spec + ext);
  }
  for (const c of candidates) {
    const norm = c.replace(/^\.\//, "");
    if (fileSet.has(norm)) return norm;
  }
  return undefined;
}

function rowToNode(row: any): CodeNode {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    filePath: row.file_path,
    language: row.language,
    startLine: row.start_line,
    endLine: row.end_line,
    signature: row.signature ?? undefined,
    snippet: row.snippet ?? undefined,
    meta: row.meta ? JSON.parse(row.meta) : undefined,
  };
}
