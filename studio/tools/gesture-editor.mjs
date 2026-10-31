// Build the gesture editor: a standalone page with the real avatar in it, for
// authoring the hand gestures in glitch/dev-hands-data.ts.
//
// It inlines the built devatar bundle rather than linking it, so the page is
// one file that can be opened from anywhere (and copied into a sandbox that
// cannot see the repo). Regenerate it after any rig change:
//
//   node tools/gesture-editor.mjs [out.html]
//
// Default output is the DevAvatar folder on the backed-up volume, next to the
// arm editor it grew out of.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STUDIO = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const out = process.argv[2] ?? "/var/mnt/VMs/Projects/DevAvatar/vector/dev-gesture-editor.html";
const bundle = fs.readFileSync(path.join(STUDIO, "dist/renderer/devatar-page.js"), "utf8");
if (!/window\.devatar/.test(bundle)) throw new Error("devatar bundle looks wrong — run `node build.mjs` first");

const page = `<!doctype html>
<html><head><meta charset="utf-8"><title>Devatar gestures</title>
<style>
  :root{--bg:#0a0d14;--panel:#131824;--line:#243049;--text:#dbe4f5;--muted:#7f8ca8;--accent:#79d4a6}
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;background:var(--bg);color:var(--text);
    font:13px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
  .wrap{display:grid;grid-template-columns:210px 1fr 300px;height:100%}
  .col{overflow:auto;padding:12px}
  .col+.col{border-left:1px solid var(--line)}
  h2{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin:16px 0 8px}
  h2:first-child{margin-top:0}
  button{background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:6px;
    padding:5px 9px;font:inherit;cursor:pointer}
  button:hover{border-color:var(--accent)}
  button[aria-pressed=true]{background:var(--accent);color:#06240f;border-color:var(--accent);font-weight:600}
  input,textarea{background:#0e1320;color:var(--text);border:1px solid var(--line);border-radius:6px;
    padding:5px 7px;font:inherit;width:100%}
  input[type=range]{padding:0;border:0;background:none}
  .list button{display:block;width:100%;text-align:left;margin-bottom:4px}
  .kf{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px}
  .kf button{padding:4px 7px;font-variant-numeric:tabular-nums}
  .row{display:grid;grid-template-columns:52px 1fr 54px;align-items:center;gap:8px;margin-bottom:7px}
  .row span:first-child{color:var(--muted);font-size:11px}
  .row span:last-child{text-align:right;font-variant-numeric:tabular-nums;font-size:11px}
  .shapes{display:flex;flex-wrap:wrap;gap:4px}
  .shapes button{padding:3px 6px;font-size:11px}
  .stage{position:relative;width:100%;aspect-ratio:16/9;background:#07090f;border:1px solid var(--line);
    border-radius:10px;overflow:hidden}
  .stage svg{position:absolute;inset:0;width:100%;height:100%}
  .bar{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
  .hint{color:var(--muted);font-size:11px;margin:6px 0 0}
  .tag{display:inline-block;background:#1b2437;border:1px solid var(--line);border-radius:999px;
    padding:1px 7px;font-size:10px;color:var(--muted);margin-left:6px}
</style></head>
<body><div class="wrap">

<div class="col">
  <h2>Gestures</h2>
  <div class="list" id="list"></div>
  <div class="bar"><button id="addG">+ new gesture</button></div>
  <p class="hint">A gesture runs from home, to a pose, and back. Mark the
  middle keyframe <b>hold</b> and the hand stays there until another gesture
  is asked for.</p>
  <h2>Export</h2>
  <div class="bar"><button id="copy">copy all as TypeScript</button></div>
  <p class="hint" id="copied"></p>
</div>

<div class="col">
  <div class="stage"><svg id="dev"></svg></div>
  <div class="bar">
    <button id="play">play</button>
    <button id="hold">play &amp; hold</button>
    <button id="release">release</button>
    <button id="home">home</button>
    <span class="tag" id="who"></span>
  </div>
  <h2>Name and description</h2>
  <div class="row" style="grid-template-columns:52px 1fr"><span>name</span><input id="gname"></div>
  <div class="row" style="grid-template-columns:52px 1fr"><span>does</span><input id="glabel" placeholder="What this gesture is for, in your words"></div>
  <h2>Keyframes</h2>
  <div class="kf" id="kfs"></div>
  <div class="bar">
    <button id="addK">+ keyframe after</button>
    <button id="delK">delete this one</button>
    <button id="markHold">mark as the hold</button>
  </div>
  <p class="hint">Keyframe 0 and the last one are home, off frame. Times are
  milliseconds from the start of the line the gesture is attached to.</p>
</div>

<div class="col">
  <h2>This keyframe</h2>
  <div class="row"><span>at ms</span><input id="kt" type="number" step="25" min="0"><span id="vt"></span></div>
  <div class="row"><span>upper</span><input id="ua" type="range" min="-10" max="60" step="0.5"><span id="vua"></span></div>
  <div class="row"><span>fore</span><input id="fa" type="range" min="-60" max="140" step="0.5"><span id="vfa"></span></div>
  <div class="row"><span>length</span><input id="len" type="range" min="180" max="520" step="1"><span id="vlen"></span></div>
  <div class="row"><span>rotate</span><input id="rot" type="range" min="-180" max="180" step="1"><span id="vrot"></span></div>
  <div class="row"><span>size</span><input id="scale" type="range" min="0.6" max="3.2" step="0.01"><span id="vscale"></span></div>
  <div class="row"><span>shown</span><input id="vis" type="range" min="0" max="1" step="0.01"><span id="vvis"></span></div>
  <div class="bar"><button id="flip">mirror the hand</button></div>
  <h2>Hand</h2>
  <div class="shapes" id="shapes"></div>
</div>

</div>
<script>${bundle}</script>
<script>
(function(){
"use strict";
var D = window.devatar;
var G = JSON.parse(JSON.stringify(D.gestures()));   // our editable copy
var HOME = { ua: 2, fa: 85, len: 390, rot: 120, scale: 1.6, shape: "soft", vis: 0 };
var sel = Object.keys(G)[0], ki = 1;
var $ = function(id){ return document.getElementById(id); };
var g = function(){ return G[sel]; };
var k = function(){ return g().keys[Math.min(ki, g().keys.length - 1)]; };

function drawList(){
  var box = $("list"); box.innerHTML = "";
  Object.keys(G).forEach(function(n){
    var b = document.createElement("button");
    b.textContent = n;
    if (G[n].hold != null) { var t = document.createElement("span"); t.className = "tag"; t.textContent = "held"; b.appendChild(t); }
    b.setAttribute("aria-pressed", n === sel);
    b.onclick = function(){ sel = n; ki = Math.min(1, G[n].keys.length - 1); drawAll(); };
    box.appendChild(b);
  });
}
function drawKeys(){
  var box = $("kfs"); box.innerHTML = "";
  g().keys.forEach(function(key, i){
    var b = document.createElement("button");
    b.textContent = "K" + i + "  " + Math.round(key.t * 1000) + (g().hold === i ? " ⏸" : "");
    b.setAttribute("aria-pressed", i === ki);
    b.onclick = function(){ ki = i; drawAll(); };
    box.appendChild(b);
  });
}
function drawShapes(){
  var box = $("shapes"); box.innerHTML = "";
  D.shapes().forEach(function(s){
    var b = document.createElement("button");
    b.textContent = s; b.setAttribute("aria-pressed", k().p.shape === s);
    b.onclick = function(){ k().p.shape = s; apply(); drawShapes(); };
    box.appendChild(b);
  });
}
function set(id, v, label, dp){
  $(id).value = v; if (label) $(label).textContent = (dp === 0 ? Math.round(v) : (+v).toFixed(dp || 2));
}
function drawFields(){
  var p = k().p;
  $("gname").value = sel; $("glabel").value = g().label || "";
  set("kt", Math.round(k().t * 1000), "vt", 0);
  set("ua", p.ua, "vua", 1); set("fa", p.fa, "vfa", 1); set("len", p.len, "vlen", 0);
  set("rot", p.rot, "vrot", 0); set("scale", p.scale, "vscale", 2); set("vis", p.vis, "vvis", 2);
  $("flip").setAttribute("aria-pressed", p.flip === false);
  $("who").textContent = sel + " · K" + ki;
}
function drawAll(){ drawList(); drawKeys(); drawShapes(); drawFields(); apply(); }
/** Pin the stage to the keyframe being edited. */
function apply(){ D.pose(Object.assign({}, k().p)); }

[["ua","vua",1],["fa","vfa",1],["len","vlen",0],["rot","vrot",0],["scale","vscale",2],["vis","vvis",2]]
  .forEach(function(row){
    $(row[0]).addEventListener("input", function(){
      k().p[row[0]] = +this.value;
      $(row[1]).textContent = row[2] === 0 ? Math.round(+this.value) : (+this.value).toFixed(row[2]);
      apply();
    });
  });
$("kt").addEventListener("input", function(){ k().t = Math.max(0, +this.value / 1000); drawKeys(); });
$("flip").onclick = function(){ var p = k().p; p.flip = p.flip === false ? undefined : false; drawFields(); apply(); };
$("gname").addEventListener("change", function(){
  var n = this.value.trim().replace(/[^a-z_]/g, "");
  if (!n || G[n]) { this.value = sel; return; }
  G[n] = G[sel]; delete G[sel]; sel = n; drawAll();
});
$("glabel").addEventListener("input", function(){ g().label = this.value; });

$("addG").onclick = function(){
  var n = "gesture" + (Object.keys(G).length + 1);
  G[n] = { label: "", hold: 1, keys: [
    { t: 0, p: Object.assign({}, HOME) },
    { t: 0.5, p: { ua: 16, fa: 18, len: 360, rot: 8, scale: 1.9, shape: "one_up", vis: 1, flip: false } },
    { t: 1.5, p: Object.assign({}, HOME) },
  ] };
  sel = n; ki = 1; drawAll(); $("gname").focus(); $("gname").select();
};
$("addK").onclick = function(){
  var ks = g().keys, a = ks[ki], b = ks[ki + 1];
  var t = b ? (a.t + b.t) / 2 : a.t + 0.5;
  ks.splice(ki + 1, 0, { t: t, p: Object.assign({}, a.p) });
  if (g().hold != null && g().hold > ki) g().hold++;
  ki++; drawAll();
};
$("delK").onclick = function(){
  var ks = g().keys;
  if (ks.length <= 2 || ki === 0 || ki === ks.length - 1) return;   // home at both ends stays
  ks.splice(ki, 1);
  if (g().hold != null) { if (g().hold === ki) delete g().hold; else if (g().hold > ki) g().hold--; }
  ki = Math.max(1, ki - 1); drawAll();
};
$("markHold").onclick = function(){
  if (ki === 0 || ki === g().keys.length - 1) return;
  g().hold = g().hold === ki ? undefined : ki;
  if (g().hold === undefined) delete g().hold;
  drawAll();
};

// ── playing it for real, through the rig's own driver ────────────────────
function live(fn){ D.pose(null); install(); fn(); }
/** The driver reads the built-in table, so push our edits into it first. */
function install(){ var t = D.gestures(); Object.keys(t).forEach(function(n){ delete t[n]; }); Object.keys(G).forEach(function(n){ t[n] = G[n]; }); }
$("play").onclick = function(){ live(function(){ var h = G[sel].hold; delete G[sel].hold; D.gesture(sel); setTimeout(function(){ if (h != null) G[sel].hold = h; }, 50); }); };
$("hold").onclick = function(){ live(function(){ D.gesture(sel); }); };
$("release").onclick = function(){ D.pose(null); D.gesture(null); };
$("home").onclick = function(){ D.gesture(null); setTimeout(function(){ D.pose(null); }, 10); apply(); };

// ── export ───────────────────────────────────────────────────────────────
function ts(){
  var q = function(s){ return JSON.stringify(s); };
  var pose = function(p){
    var bits = ["ua: " + +p.ua.toFixed(2), "fa: " + +p.fa.toFixed(2), "len: " + Math.round(p.len),
                "rot: " + +p.rot.toFixed(1), "scale: " + +p.scale.toFixed(3), "shape: " + q(p.shape),
                "vis: " + +p.vis.toFixed(2)];
    if (p.flip === false) bits.push("flip: false");
    return "{ " + bits.join(", ") + " }";
  };
  var out = ["export const GESTURES: Record<string, Gesture> = {"];
  Object.keys(G).forEach(function(n){
    var g = G[n];
    out.push("  " + n + ": {");
    out.push("    label: " + q(g.label || "") + ",");
    if (g.hold != null) out.push("    hold: " + g.hold + ",");
    out.push("    keys: [");
    g.keys.forEach(function(key){ out.push("      { t: " + +key.t.toFixed(3) + ", p: " + pose(key.p) + " },"); });
    out.push("    ],");
    out.push("  },");
  });
  out.push("};");
  return out.join("\\n");
}
$("copy").onclick = function(){
  var text = ts();
  var done = function(){ $("copied").textContent = "Copied " + Object.keys(G).length + " gestures. Paste over GESTURES in glitch/dev-hands-data.ts."; };
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
  function fallback(){
    var ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.top = "8px"; ta.style.left = "8px";
    ta.style.width = "60vw"; ta.style.height = "70vh"; ta.style.zIndex = 99;
    document.body.appendChild(ta); ta.select();
    $("copied").textContent = "Clipboard blocked — select the box and copy, then click it to dismiss.";
    ta.onclick = function(){ ta.remove(); };
  }
};

// #name or #name@2 opens straight on a gesture and a keyframe
(function(){
  var h = (location.hash || "").slice(1).split("@");
  if (h[0] && G[h[0]]) { sel = h[0]; if (h[1] != null && +h[1] >= 0) ki = +h[1]; }
})();
window.addEventListener("hashchange", function(){ location.reload(); });

D.mood("neutral");
drawAll();
})();
</script></body></html>
`;

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, page);
console.log(`${out}  (${(page.length / 1024 / 1024).toFixed(2)} MB)`);
