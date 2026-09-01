import type { CodeEdge, CodeNode } from "../types.js";
import type { GraphStore } from "./store.js";
import { GraphQuery } from "./query.js";

export interface ExportOptions {
  focus?: string; // center on a symbol name/id
  depth?: number; // neighborhood hops when focused
  limit?: number; // max nodes for whole-graph export
  kinds?: string[]; // node kinds to include
  edgeKinds?: string[]; // edge kinds to include
}

export interface GraphData {
  nodes: { id: string; label: string; group: string; title: string }[];
  edges: { from: string; to: string; label: string; confidence: number }[];
}

const DEFAULT_NODE_KINDS = ["function", "method", "class", "interface", "route"];
const DEFAULT_EDGE_KINDS = ["calls", "handles", "extends", "implements"];

/** Build a visualization-ready node/edge payload from the graph store. */
export function buildGraphData(store: GraphStore, opts: ExportOptions = {}): GraphData {
  const nodeKinds = opts.kinds ?? DEFAULT_NODE_KINDS;
  const edgeKinds = opts.edgeKinds ?? DEFAULT_EDGE_KINDS;

  let nodes: CodeNode[];
  let edges: CodeEdge[];

  if (opts.focus) {
    const query = new GraphQuery(store);
    const start = store.getNode(opts.focus) ?? store.getNodesByName(opts.focus)[0];
    if (!start) return { nodes: [], edges: [] };
    const sub = query.neighborhood(start.id, opts.depth ?? 2);
    nodes = sub.nodes.filter((n) => nodeKinds.includes(n.kind));
    const keep = new Set(nodes.map((n) => n.id));
    edges = sub.edges.filter((e) => edgeKinds.includes(e.kind) && keep.has(e.fromId) && keep.has(e.toId));
  } else {
    nodes = store.allNodesOfKinds(nodeKinds);
    const limit = opts.limit ?? 300;
    if (nodes.length > limit) {
      // Keep the most important nodes by PageRank to stay legible.
      nodes = nodes
        .map((n) => ({ n, r: store.getRank(n.id) }))
        .sort((a, b) => b.r - a.r)
        .slice(0, limit)
        .map((x) => x.n);
    }
    const keep = new Set(nodes.map((n) => n.id));
    edges = store
      .allEdgesOfKinds(edgeKinds)
      .filter((e) => keep.has(e.fromId) && keep.has(e.toId));
  }

  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      label: n.meta?.parent ? `${n.meta.parent as string}.${n.name}` : n.name,
      group: n.kind,
      title: `${n.kind} ${n.name}\n${n.filePath}:${n.startLine}`,
    })),
    edges: edges.map((e) => ({
      from: e.fromId,
      to: e.toId,
      label: e.kind,
      confidence: e.confidence,
    })),
  };
}

/** Render a self-contained interactive HTML page (vis-network via CDN). */
export function renderHtml(data: GraphData, title = "Cografy graph"): string {
  const json = JSON.stringify(data).replace(/<\//g, "<\\/");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<script src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"></script>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font-family: system-ui, sans-serif; background: #0d1117; color: #c9d1d9; }
  #bar { padding: 10px 14px; border-bottom: 1px solid #21262d; display: flex; gap: 14px; align-items: center; flex-wrap: wrap; }
  #bar strong { color: #58a6ff; }
  #search { background: #161b22; border: 1px solid #30363d; color: #c9d1d9; padding: 6px 10px; border-radius: 6px; width: 240px; }
  .legend { display: flex; gap: 12px; font-size: 12px; flex-wrap: wrap; }
  .legend span { display: inline-flex; align-items: center; gap: 5px; }
  .dot { width: 11px; height: 11px; border-radius: 50%; display: inline-block; }
  #net { width: 100vw; height: calc(100vh - 52px); }
</style>
</head>
<body>
  <div id="bar">
    <strong>◍ Cografy</strong>
    <input id="search" placeholder="Focus a symbol…" />
    <div class="legend">
      <span><i class="dot" style="background:#f0883e"></i>function</span>
      <span><i class="dot" style="background:#a371f7"></i>method</span>
      <span><i class="dot" style="background:#58a6ff"></i>class</span>
      <span><i class="dot" style="background:#3fb950"></i>interface</span>
      <span><i class="dot" style="background:#db61a2"></i>route</span>
    </div>
    <span id="count" style="font-size:12px;color:#8b949e"></span>
  </div>
  <div id="net"></div>
<script>
  const data = ${json};
  const nodes = new vis.DataSet(data.nodes);
  const edges = new vis.DataSet(data.edges.map(function (e, i) {
    return { id: i, from: e.from, to: e.to, label: e.label, title: e.label + " (" + e.confidence.toFixed(2) + ")",
      arrows: "to", font: { size: 9, color: "#8b949e", strokeWidth: 0 },
      color: { color: e.confidence >= 0.8 ? "#3fb950" : e.confidence >= 0.5 ? "#d29922" : "#6e7681", opacity: 0.7 } };
  }));
  document.getElementById("count").textContent = data.nodes.length + " nodes · " + data.edges.length + " edges";
  const options = {
    nodes: { shape: "dot", size: 12, font: { color: "#c9d1d9", size: 12 }, borderWidth: 0 },
    groups: {
      function: { color: "#f0883e" }, method: { color: "#a371f7" },
      class: { color: "#58a6ff" }, interface: { color: "#3fb950" }, route: { color: "#db61a2" }
    },
    physics: { stabilization: true, barnesHut: { gravitationalConstant: -8000, springLength: 120 } },
    interaction: { hover: true, tooltipDelay: 120, navigationButtons: true, keyboard: true }
  };
  const network = new vis.Network(document.getElementById("net"), { nodes: nodes, edges: edges }, options);
  document.getElementById("search").addEventListener("keydown", function (ev) {
    if (ev.key !== "Enter") return;
    const q = ev.target.value.toLowerCase().trim();
    const hit = data.nodes.find(function (n) { return n.label.toLowerCase().includes(q); });
    if (hit) { network.selectNodes([hit.id]); network.focus(hit.id, { scale: 1.2, animation: true }); }
  });
</script>
</body>
</html>`;
}

/** Render Graphviz DOT (for `dot -Tsvg` or online viewers). */
export function renderDot(data: GraphData): string {
  const lines = ["digraph cografy {", "  rankdir=LR;", '  node [style=filled, fontname="sans-serif"];'];
  const color: Record<string, string> = {
    function: "#f0883e", method: "#a371f7", class: "#58a6ff", interface: "#3fb950", route: "#db61a2",
  };
  for (const n of data.nodes) {
    lines.push(`  "${n.id}" [label="${dotEscape(n.label)}", fillcolor="${color[n.group] ?? "#cccccc"}"];`);
  }
  for (const e of data.edges) {
    lines.push(`  "${e.from}" -> "${e.to}" [label="${dotEscape(e.label)}"];`);
  }
  lines.push("}");
  return lines.join("\n");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function dotEscape(s: string): string {
  return s.replace(/"/g, '\\"');
}

/**
 * Compute a force-directed layout in Node (repulsion + edge springs + gravity)
 * so the browser renderer can stay a dumb, dependency-free canvas — fully offline.
 */
function computeLayout(data: GraphData): Map<string, { x: number; y: number }> {
  const ids = data.nodes.map((n) => n.id);
  const n = ids.length;
  const pos = new Map<string, { x: number; y: number }>();
  if (n === 0) return pos;
  const idx = new Map(ids.map((id, i) => [id, i]));
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  // deterministic ring start
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    x[i] = Math.cos(a) * 300 + (i % 7) * 3;
    y[i] = Math.sin(a) * 300 + (i % 5) * 3;
  }
  const links = data.edges
    .map((e) => [idx.get(e.from), idx.get(e.to)])
    .filter(([a, b]) => a !== undefined && b !== undefined) as [number, number][];

  const iterations = n > 200 ? 200 : 300;
  const k = 220; // ideal edge length
  for (let it = 0; it < iterations; it++) {
    const cooling = 1 - it / iterations;
    const fx = new Float64Array(n);
    const fy = new Float64Array(n);
    // repulsion (O(n^2), fine for capped node counts)
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = x[i] - x[j];
        let dy = y[i] - y[j];
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) {
          dx = (i - j) * 0.1 + 0.1;
          dy = 0.1;
          d2 = dx * dx + dy * dy;
        }
        const rep = (k * k) / d2;
        const d = Math.sqrt(d2);
        fx[i] += (dx / d) * rep;
        fy[i] += (dy / d) * rep;
        fx[j] -= (dx / d) * rep;
        fy[j] -= (dy / d) * rep;
      }
    }
    // springs
    for (const [a, b] of links) {
      const dx = x[a] - x[b];
      const dy = y[a] - y[b];
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const spring = (d - k) * 0.1;
      fx[a] -= (dx / d) * spring;
      fy[a] -= (dy / d) * spring;
      fx[b] += (dx / d) * spring;
      fy[b] += (dy / d) * spring;
    }
    // gravity to center + integrate
    for (let i = 0; i < n; i++) {
      fx[i] -= x[i] * 0.02;
      fy[i] -= y[i] * 0.02;
      const max = 30;
      x[i] += Math.max(-max, Math.min(max, fx[i])) * cooling;
      y[i] += Math.max(-max, Math.min(max, fy[i])) * cooling;
    }
  }
  for (let i = 0; i < n; i++) pos.set(ids[i], { x: x[i], y: y[i] });
  return pos;
}

/**
 * Fully-offline interactive graph: layout precomputed in Node, rendered by a
 * tiny embedded canvas script (pan/zoom/hover/search). No CDN, no dependencies.
 */
export function renderHtmlInline(data: GraphData, title = "Cografy graph"): string {
  const layout = computeLayout(data);
  const nodes = data.nodes.map((nd) => ({ ...nd, ...(layout.get(nd.id) ?? { x: 0, y: 0 }) }));
  const payload = JSON.stringify({ nodes, edges: data.edges }).replace(/<\//g, "<\\/");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  html,body{margin:0;height:100%;background:#0d1117;color:#c9d1d9;font-family:system-ui,sans-serif;overflow:hidden}
  #bar{position:fixed;top:0;left:0;right:0;padding:8px 12px;display:flex;gap:12px;align-items:center;border-bottom:1px solid #21262d;background:#0d1117;z-index:2;flex-wrap:wrap}
  #bar strong{color:#58a6ff}
  #search{background:#161b22;border:1px solid #30363d;color:#c9d1d9;padding:5px 9px;border-radius:6px;width:220px}
  .legend{display:flex;gap:10px;font-size:12px;flex-wrap:wrap}
  .legend span{display:inline-flex;align-items:center;gap:5px}
  .dot{width:10px;height:10px;border-radius:50%;display:inline-block}
  #count{font-size:12px;color:#8b949e}
  #c{position:fixed;top:0;left:0}
  #tip{position:fixed;pointer-events:none;background:#161b22;border:1px solid #30363d;border-radius:6px;padding:6px 8px;font-size:12px;display:none;z-index:3;white-space:pre;max-width:360px}
</style></head><body>
<div id="bar"><strong>◍ Cografy</strong>
  <input id="search" placeholder="Focus a symbol…" />
  <div class="legend">
    <span><i class="dot" style="background:#f0883e"></i>function</span>
    <span><i class="dot" style="background:#a371f7"></i>method</span>
    <span><i class="dot" style="background:#58a6ff"></i>class</span>
    <span><i class="dot" style="background:#3fb950"></i>interface</span>
    <span><i class="dot" style="background:#db61a2"></i>route</span>
  </div>
  <span id="count"></span>
</div>
<canvas id="c"></canvas>
<div id="tip"></div>
<script>
const DATA = ${payload};
const COLORS = { function:"#f0883e", method:"#a371f7", class:"#58a6ff", interface:"#3fb950", route:"#db61a2" };
const cv = document.getElementById("c"), ctx = cv.getContext("2d"), tip = document.getElementById("tip");
document.getElementById("count").textContent = DATA.nodes.length + " nodes · " + DATA.edges.length + " edges";
const byId = new Map(DATA.nodes.map(n => [n.id, n]));
let scale = 1, ox = 0, oy = 0;
function resize(){ cv.width = innerWidth; cv.height = innerHeight; draw(); }
addEventListener("resize", resize);
// fit
(function fit(){
  const xs = DATA.nodes.map(n=>n.x), ys = DATA.nodes.map(n=>n.y);
  const minx=Math.min(...xs), maxx=Math.max(...xs), miny=Math.min(...ys), maxy=Math.max(...ys);
  const w = (maxx-minx)||1, h=(maxy-miny)||1;
  scale = Math.min((innerWidth-80)/w, (innerHeight-140)/h, 1.5) || 1;
  ox = innerWidth/2 - ((minx+maxx)/2)*scale;
  oy = innerHeight/2 + 20 - ((miny+maxy)/2)*scale;
})();
function draw(){
  ctx.clearRect(0,0,cv.width,cv.height);
  ctx.lineWidth = 1;
  for (const e of DATA.edges){
    const a = byId.get(e.from), b = byId.get(e.to); if(!a||!b) continue;
    ctx.strokeStyle = e.confidence>=0.8?"rgba(63,185,80,.5)":e.confidence>=0.5?"rgba(210,153,34,.5)":"rgba(110,118,129,.4)";
    ctx.beginPath();
    ctx.moveTo(a.x*scale+ox, a.y*scale+oy);
    ctx.lineTo(b.x*scale+ox, b.y*scale+oy);
    ctx.stroke();
  }
  for (const n of DATA.nodes){
    const px=n.x*scale+ox, py=n.y*scale+oy;
    ctx.fillStyle = COLORS[n.group]||"#8b949e";
    ctx.beginPath(); ctx.arc(px,py, 5, 0, 7); ctx.fill();
    if (scale > 0.7){ ctx.fillStyle="#8b949e"; ctx.font="11px system-ui"; ctx.fillText(n.label, px+7, py+3); }
  }
}
resize();
let drag=false, lx=0, ly=0;
cv.addEventListener("mousedown", e=>{drag=true; lx=e.clientX; ly=e.clientY;});
addEventListener("mouseup", ()=>drag=false);
addEventListener("mousemove", e=>{
  if(drag){ ox+=e.clientX-lx; oy+=e.clientY-ly; lx=e.clientX; ly=e.clientY; draw(); return; }
  const n = pick(e.clientX, e.clientY);
  if(n){ tip.style.display="block"; tip.style.left=(e.clientX+12)+"px"; tip.style.top=(e.clientY+12)+"px"; tip.textContent = n.title; }
  else tip.style.display="none";
});
cv.addEventListener("wheel", e=>{ e.preventDefault(); const f=e.deltaY<0?1.1:0.9;
  ox = e.clientX - (e.clientX-ox)*f; oy = e.clientY - (e.clientY-oy)*f; scale*=f; draw(); }, {passive:false});
function pick(mx,my){ let best=null, bd=100; for(const n of DATA.nodes){ const dx=n.x*scale+ox-mx, dy=n.y*scale+oy-my; const d=dx*dx+dy*dy; if(d<bd){bd=d;best=n;} } return best; }
document.getElementById("search").addEventListener("keydown", ev=>{
  if(ev.key!=="Enter") return;
  const q=ev.target.value.toLowerCase().trim();
  const hit=DATA.nodes.find(n=>n.label.toLowerCase().includes(q));
  if(hit){ scale=1.4; ox=innerWidth/2-hit.x*scale; oy=innerHeight/2-hit.y*scale; draw(); }
});
</script></body></html>`;
}

