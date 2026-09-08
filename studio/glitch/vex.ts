// Vex v2: Glitch's head on a slim articulated wall arm, attached to the left edge of a 1920x1080 frame.
// Pure SVG + JS so the same code runs live in the app and offline in the post renderer.
import { BASE, Expr, MOODS, hexToRgb, moodExpr } from "./moods";

const NS = "http://www.w3.org/2000/svg";
const el = (n: string, a: Record<string, any> = {}, p?: Element) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, String(a[k])); p?.appendChild(e); return e; };
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const rgb = (c: number[]) => `rgb(${c.map(Math.round).join(",")})`;

export interface RenderState extends Expr { rgb: [number, number, number]; blink: number; talkOpen: number; pos: number; x: number; y: number; visible: number }

// ── mouth geometry shared by helpers ─────────────────────────────────────────
function mouthCurves(cx: number, cy: number, W: number, H: number, s: Expr, open: number) {
  const w = W * s.mouthW, up = s.mouthCurve * H, sm = s.smirk * H * .7, op = open * H * 1.3;
  const xl = cx - w / 2, xr = cx + w / 2, yl = cy - up - sm, yr = cy - up + sm;
  const cb = cy + up * .9 + op, ct = cy + up * .9 - op * .55;
  return { xl, xr, yl, yr, cb, ct, path: `M${xl},${yl} Q${cx},${cb} ${xr},${yr} Q${cx},${ct} ${xl},${yl}Z` };
}

function makeEye(parent: Element, o: { w: number; h: number; rx: number; skin: string }) {
  const g = el("g", {}, parent);
  const glow = el("rect", { x: -o.w / 2 - 10, y: -o.h / 2 - 10, width: o.w + 20, height: o.h + 20, rx: o.rx + 10, filter: "url(#gx-blur)" }, g);
  const body = el("rect", { x: -o.w / 2, y: -o.h / 2, width: o.w, height: o.h, rx: o.rx }, g);
  const iris = el("circle", { r: o.w * .27, fill: "rgba(0,0,0,.25)" }, g);
  const pupil = el("circle", { r: o.w * .17, fill: "#070910" }, g);
  const hi = el("circle", { r: o.w * .06, cx: -o.w * .1, cy: -o.h * .14, fill: "#fff", opacity: .85 }, g);
  const lidT = el("rect", { x: -o.w, y: -o.h * 1.5, width: o.w * 2, height: o.h * 1.5, fill: o.skin }, g);
  const lidB = el("rect", { x: -o.w, y: 0, width: o.w * 2, height: o.h * 1.5, fill: o.skin }, g);
  const arc = el("path", { fill: "none", "stroke-width": o.w * .16, "stroke-linecap": "round", filter: "url(#gx-glow)" }, g);
  const brow = el("line", { "stroke-width": o.w * .11, "stroke-linecap": "round" }, g);
  return {
    g,
    update(s: RenderState, side: -1 | 1) {
      const c = rgb(s.rgb);
      body.setAttribute("fill", c); glow.setAttribute("fill", c); arc.setAttribute("stroke", c); brow.setAttribute("stroke", c);
      glow.setAttribute("opacity", String(.35 * s.glow));
      const lt = clamp(Math.max(s.lidT + (side > 0 ? s.asym * .25 : 0), s.blink), -.2, 1);
      const lb = clamp(s.lidB, -.2, 1);
      lidT.setAttribute("transform", `translate(0,${-o.h / 2 + lt * o.h}) rotate(${s.browA * 14 * -side})`);
      lidB.setAttribute("transform", `translate(0,${o.h / 2 - lb * o.h * .6})`);
      const px = s.lookX * o.w * .22, py = s.lookY * o.h * .2;
      pupil.setAttribute("transform", `translate(${px},${py}) scale(${s.pupil})`);
      iris.setAttribute("transform", `translate(${px * .7},${py * .7}) scale(${lerp(1, s.pupil, .6)})`);
      hi.setAttribute("transform", `translate(${px * .5},${py * .5})`);
      const sq = s.squint;
      for (const e of [body, iris, pupil, hi, lidT, lidB]) e.setAttribute("opacity", String(1 - sq));
      arc.setAttribute("opacity", String(sq));
      arc.setAttribute("d", `M${-o.w / 2},${o.h * .12} Q0,${-o.h * .55} ${o.w / 2},${o.h * .12}`);
      const by = -o.h * .78 - s.browY * o.h * .28 - (side < 0 ? s.asym * o.h * .22 : 0);
      const tb = s.browA * o.h * .22 * side;
      brow.setAttribute("x1", String(-side * o.w * .45)); brow.setAttribute("y1", String(by + tb));
      brow.setAttribute("x2", String(side * o.w * .45)); brow.setAttribute("y2", String(by - tb));
      brow.setAttribute("opacity", ".9");
    },
  };
}

function defs(svg: SVGSVGElement) {
  const d = el("defs", {}, svg);
  const f1 = el("filter", { id: "gx-blur", x: "-50%", y: "-50%", width: "200%", height: "200%" }, d); el("feGaussianBlur", { stdDeviation: 12 }, f1);
  const f2 = el("filter", { id: "gx-glow", x: "-50%", y: "-50%", width: "200%", height: "200%" }, d);
  el("feGaussianBlur", { stdDeviation: 4, result: "b" }, f2); const m = el("feMerge", {}, f2); el("feMergeNode", { in: "b" }, m); el("feMergeNode", { in: "SourceGraphic" }, m);
  const gr = el("linearGradient", { id: "gx-metal", x1: 0, y1: 0, x2: 0, y2: 1 }, d); el("stop", { offset: 0, "stop-color": "#4a5068" }, gr); el("stop", { offset: 1, "stop-color": "#2a2f40" }, gr);
  const gr2 = el("linearGradient", { id: "gx-metalH", x1: 0, y1: 0, x2: 1, y2: 0 }, d); el("stop", { offset: 0, "stop-color": "#3a3f55" }, gr2); el("stop", { offset: 1, "stop-color": "#252a38" }, gr2);
  const fg = el("filter", { id: "gx-static", x: "-10%", y: "-10%", width: "120%", height: "120%" }, d);
  el("feTurbulence", { type: "fractalNoise", baseFrequency: "0.9 0.05", numOctaves: 1, seed: 3, result: "n" }, fg);
  el("feDisplacementMap", { in: "SourceGraphic", in2: "n", scale: 18, xChannelSelector: "R", yChannelSelector: "G" }, fg);
}

/** Frame layout: head "home" position, rail, arm lengths. Scaled for 1920x1080. */
export const LAYOUT = { W: 1920, H: 1080, mountX: 0, homeY: 300, topY: 230, bottomY: 830, headX: 250, reachPx: 140, hideX: -320, L1: 150, L2: 150 };

export class Vex {
  private rig: SVGElement; private mount: SVGElement; private seg1: SVGElement; private seg2: SVGElement; private elbow: SVGElement; private wrist: SVGElement;
  private head: SVGElement; private finL: SVGElement; private finR: SVGElement; private finGlow: SVGElement[]; private crest: SVGElement; private eyeL; private eyeR; private mouthShape: SVGElement; private mouthLine: SVGElement; private neckLight: SVGElement; private headInner: SVGElement;
  constructor(public svg: SVGSVGElement | SVGGElement) {
    if (svg.tagName.toLowerCase() === "svg") svg.setAttribute("viewBox", `0 0 ${LAYOUT.W} ${LAYOUT.H}`);
    defs(svg as SVGSVGElement);
    this.rig = el("g", {}, svg);
    // wall rail + mount (slim)
    el("rect", { x: 0, y: 0, width: 12, height: LAYOUT.H, fill: "url(#gx-metalH)", opacity: .9 }, this.rig);
    for (let y = 30; y < LAYOUT.H; y += 60) el("rect", { x: 3, y, width: 6, height: 10, rx: 2, fill: "#171a26" }, this.rig);
    this.mount = el("g", {}, this.rig);
    el("rect", { x: 0, y: -34, width: 30, height: 68, rx: 6, fill: "#3a3f55", stroke: "#5a6280", "stroke-width": 2 }, this.mount);
    el("circle", { cx: 22, cy: 0, r: 13, fill: "#4a5068", stroke: "#1a1d2e", "stroke-width": 3 }, this.mount);
    // arm segments (drawn as thick rounded lines with a darker core = robo-dog arm look)
    this.seg1 = el("g", {}, this.rig); this.seg2 = el("g", {}, this.rig);
    for (const seg of [this.seg1, this.seg2]) {
      el("line", { x1: 0, y1: 0, x2: 1, y2: 0, stroke: "#2a2f40", "stroke-width": 26, "stroke-linecap": "round", class: "bone" }, seg);
      el("line", { x1: 0, y1: 0, x2: 1, y2: 0, stroke: "#4a5068", "stroke-width": 16, "stroke-linecap": "round", class: "bone" }, seg);
      el("line", { x1: 0, y1: 0, x2: 1, y2: 0, stroke: "#171a26", "stroke-width": 4, "stroke-dasharray": "10 14", class: "bone" }, seg);
    }
    this.elbow = el("g", {}, this.rig); el("circle", { r: 17, fill: "#3a3f55", stroke: "#5a6280", "stroke-width": 2 }, this.elbow); el("circle", { r: 6, fill: "#171a26" }, this.elbow);
    this.wrist = el("g", {}, this.rig); el("circle", { r: 14, fill: "#3a3f55", stroke: "#5a6280", "stroke-width": 2 }, this.wrist);
    this.neckLight = el("circle", { r: 5, filter: "url(#gx-glow)" }, this.wrist);
    // head
    this.head = el("g", {}, this.rig);
    this.headInner = el("g", {}, this.head);
    const h = this.headInner;
    el("rect", { x: -16, y: 60, width: 32, height: 50, rx: 6, fill: "#252a38" }, h); // neck stub
    this.finL = el("g", {}, h); this.finR = el("g", {}, h);
    const finPath = "M0,0 L-30,-112 L40,-56 Z";
    el("path", { d: finPath, fill: "url(#gx-metal)", stroke: "#5a6280", "stroke-width": 2 }, this.finL);
    el("path", { d: finPath, fill: "url(#gx-metal)", stroke: "#5a6280", "stroke-width": 2, transform: "scale(-1,1)" }, this.finR);
    this.finGlow = [el("path", { d: "M-4,-20 L-18,-76 L18,-46 Z", filter: "url(#gx-glow)", opacity: .8 }, this.finL), el("path", { d: "M-4,-20 L-18,-76 L18,-46 Z", filter: "url(#gx-glow)", opacity: .8, transform: "scale(-1,1)" }, this.finR)];
    el("path", { d: "M-106,-36 L-74,-104 L74,-104 L106,-36 L106,54 L74,100 L-74,100 L-106,54 Z", fill: "url(#gx-metal)", stroke: "#5a6280", "stroke-width": 2 }, h);
    el("path", { d: "M-52,-104 L-36,-124 L36,-124 L52,-104 Z", fill: "#3a3f55" }, h);
    this.crest = el("rect", { x: -20, y: -120, width: 40, height: 6, rx: 3, filter: "url(#gx-glow)" }, h);
    el("path", { d: "M-96,-40 L96,-40 L96,36 L-96,36 Z", fill: "#0c0f17", stroke: "#1e2230", "stroke-width": 4 }, h);
    const vis = el("g", { transform: "translate(0,-4)" }, h);
    this.eyeL = makeEye(vis, { w: 56, h: 36, rx: 11, skin: "#0c0f17" }); this.eyeL.g.setAttribute("transform", "translate(-44,0)");
    this.eyeR = makeEye(vis, { w: 56, h: 36, rx: 11, skin: "#0c0f17" }); this.eyeR.g.setAttribute("transform", "translate(44,0)");
    el("path", { d: "M-88,-34 L88,-34", stroke: "rgba(255,255,255,.07)", "stroke-width": 4 }, h);
    el("path", { d: "M-74,46 L74,46 L56,90 L-56,90 Z", fill: "#1e2230" }, h);
    const mg = el("g", { transform: "translate(0,68)" }, h);
    this.mouthShape = el("path", { filter: "url(#gx-glow)" }, mg);
    this.mouthLine = el("path", { fill: "none", "stroke-width": 6, "stroke-linecap": "round", filter: "url(#gx-glow)" }, mg);
  }

  update(s: RenderState, t: number) {
    const c = rgb(s.rgb);
    const L = LAYOUT;
    // target head position: slide (y), reach (x), lift, hide
    const baseY = s.y;
    const hx = lerp(L.hideX, L.headX + s.reach * L.reachPx, s.visible);
    const hy = baseY - s.lift * 40 + Math.sin(t * 1.3) * 3 * s.bob;
    const shake = s.shake * Math.sin(t * 40) * 4;
    // mount follows head y loosely (it slides on the rail)
    const my = baseY + 40;
    this.mount.setAttribute("transform", `translate(0,${my})`);
    // 2-bone IK from shoulder (22,my) to wrist (hx-100, hy+70) with elbow bent up
    const sx = 22, sy = my, wx = hx - 96 + shake * .3, wy = hy + 62;
    let dx = wx - sx, dy = wy - sy; let d = Math.hypot(dx, dy);
    const maxD = L.L1 + L.L2 - 2; if (d > maxD) { dx *= maxD / d; dy *= maxD / d; d = maxD; }
    const a = Math.acos(clamp((L.L1 * L.L1 + d * d - L.L2 * L.L2) / (2 * L.L1 * d), -1, 1));
    const ang = Math.atan2(dy, dx) - a; // elbow above
    const ex = sx + Math.cos(ang) * L.L1, ey = sy + Math.sin(ang) * L.L1;
    const bone = (g: SVGElement, x1: number, y1: number, x2: number, y2: number) => g.querySelectorAll(".bone").forEach((l) => { l.setAttribute("x1", String(x1)); l.setAttribute("y1", String(y1)); l.setAttribute("x2", String(x2)); l.setAttribute("y2", String(y2)); });
    bone(this.seg1, sx, sy, ex, ey); bone(this.seg2, ex, ey, wx, wy);
    this.elbow.setAttribute("transform", `translate(${ex},${ey})`);
    this.wrist.setAttribute("transform", `translate(${wx},${wy})`);
    this.neckLight.setAttribute("fill", c);
    // head hangs off the wrist via the neck stub; tilt about neck
    this.head.setAttribute("transform", `translate(${hx + shake},${hy}) rotate(${s.tilt * 11 + Math.sin(t * .8) * .8})`);
    const fa = -s.fin * 38 + 18;
    this.finL.setAttribute("transform", `translate(-100,34) rotate(${fa})`);
    this.finR.setAttribute("transform", `translate(100,34) rotate(${-fa})`);
    for (const e of [...this.finGlow, this.crest]) e.setAttribute("fill", c);
    this.eyeL.update(s, -1); this.eyeR.update(s, 1);
    const open = Math.max(s.mouthOpen, s.talkOpen);
    const m = mouthCurves(0, 0, 84, 13, s, open);
    this.mouthShape.setAttribute("d", m.path); this.mouthShape.setAttribute("fill", c); this.mouthShape.setAttribute("opacity", open > .05 ? ".95" : "0");
    this.mouthLine.setAttribute("d", `M${m.xl},${m.yl} Q0,${m.cb} ${m.xr},${m.yr}`); this.mouthLine.setAttribute("stroke", c);
    // digital glitch burst: displacement filter + flicker
    if (s.glitch > .05) {
      const on = Math.sin(t * 37) * Math.sin(t * 11) > .2 - s.glitch * .6;
      this.headInner.setAttribute("filter", on ? "url(#gx-static)" : "");
      this.headInner.setAttribute("opacity", on ? String(.75 + Math.random() * .25) : "1");
      this.headInner.setAttribute("transform", on ? `translate(${(Math.random() - .5) * 14 * s.glitch},0)` : "");
    } else { this.headInner.removeAttribute("filter"); this.headInner.setAttribute("opacity", "1"); this.headInner.removeAttribute("transform"); }
  }
}

// ── Driver: tweens moods, blinks, talk envelope, slides. Deterministic when seeded (post render). ──
export class GlitchDriver {
  cur: RenderState; target: Expr & { rgb: [number, number, number] };
  talking = false; private nextBlink = 2; private blinkT = 0; private rnd: () => number;
  private slideFrom = LAYOUT.homeY; private slideTo = LAYOUT.homeY; private slideT = 1; private slideDur = .6;
  private visFrom = 1; private visTo = 1; private visT = 1; private visDur = .6;
  private holdUntil = -1; private holdReturn = "neutral"; mood = "neutral"; private t = 0;
  private glitchBurstUntil = -1;
  constructor(seed = 7) {
    let x = seed >>> 0 || 1; this.rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
    const e = moodExpr("neutral");
    this.target = { ...e, rgb: hexToRgb(e.color) };
    this.cur = { ...e, rgb: hexToRgb(e.color), blink: 0, talkOpen: 0, pos: 0, x: LAYOUT.headX, y: LAYOUT.homeY, visible: 1 };
  }
  setMood(name: string, holdMs?: number) {
    if (!MOODS[name]) return;
    if (holdMs && holdMs > 0) { this.holdReturn = this.mood === name ? "neutral" : this.mood; this.holdUntil = this.t + holdMs / 1000; } else this.holdUntil = -1;
    this.mood = name; const e = moodExpr(name); this.target = { ...e, rgb: hexToRgb(e.color) };
    if (name === "glitch") this.glitchBurstUntil = this.t + .9;
  }
  setTalking(v: boolean) { this.talking = v; }
  slide(to: "top" | "bottom" | "hide" | "show" | number, overMs = 600) {
    if (to === "hide" || to === "show") { this.visFrom = this.cur.visible; this.visTo = to === "show" ? 1 : 0; this.visT = 0; this.visDur = Math.max(.05, overMs / 1000); return; }
    const y = to === "top" ? LAYOUT.topY : to === "bottom" ? LAYOUT.bottomY : to;
    this.slideFrom = this.cur.y; this.slideTo = y; this.slideT = 0; this.slideDur = Math.max(.05, overMs / 1000);
  }
  tick(dt: number): RenderState {
    this.t += dt; const c = this.cur, tg = this.target;
    if (this.holdUntil > 0 && this.t >= this.holdUntil) { this.holdUntil = -1; this.setMood(this.holdReturn); }
    if (this.glitchBurstUntil > 0 && this.t > this.glitchBurstUntil) { this.glitchBurstUntil = -1; if (this.mood === "glitch") this.setMood("neutral"); }
    const rate = 1 - Math.pow(.0015, dt);
    for (const k of Object.keys(BASE) as (keyof Expr)[]) if (k !== "color") (c as any)[k] = lerp((c as any)[k], (tg as any)[k], rate);
    c.rgb = c.rgb.map((v, i) => lerp(v, tg.rgb[i], rate)) as [number, number, number];
    // talk envelope
    const env = this.talking ? Math.abs(Math.sin(this.t * 9.3)) * Math.abs(Math.sin(this.t * 3.1 + 1)) * .9 + Math.abs(Math.sin(this.t * 17)) * .15 : 0;
    c.talkOpen = lerp(c.talkOpen, env, this.talking ? .6 : rate);
    // blink
    this.nextBlink -= dt;
    if (this.nextBlink <= 0) { this.blinkT = .16; this.nextBlink = 2.5 + this.rnd() * 3.5; }
    if (this.blinkT > 0) { this.blinkT -= dt; c.blink = Math.sin((1 - this.blinkT / .16) * Math.PI); } else c.blink = 0;
    // idle gaze drift
    c.lookX += Math.sin(this.t * .7) * .08 + Math.sin(this.t * 2.3) * .03; c.lookY += Math.cos(this.t * .5) * .06;
    // slides
    if (this.slideT < 1) { this.slideT = Math.min(1, this.slideT + dt / this.slideDur); const k = this.slideT * this.slideT * (3 - 2 * this.slideT); c.y = lerp(this.slideFrom, this.slideTo, k); }
    if (this.visT < 1) { this.visT = Math.min(1, this.visT + dt / this.visDur); const k = this.visT * this.visT * (3 - 2 * this.visT); c.visible = lerp(this.visFrom, this.visTo, k); }
    return c;
  }
}
