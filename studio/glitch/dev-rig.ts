// Avatar Dev: the same character Glitch is, drawn as a person.
//
// He runs on Glitch's machinery on purpose. Same Expr parameter set, same mood
// table, same tweening driver, so a mood cue, a blink or a talk envelope drives
// both of them identically and the post renderer needs no second concept of
// "what is the character doing right now".
//
// What differs is the drawing: no fins, real ears, a human silhouette built
// from Dev's own measured proportions (a sixteen-view FLAME fit of the
// recordings), and the mood color carried in the contour and the eyes rather
// than in a metal shell. Stubble is the mood color lifted toward white; the
// hair is a faceted polygon with strands combed forward over a hairline that
// is receding at the temples.
//
// The body never moves. A bust whose shoulders swing with a head tilt reads as
// a puppet, so every expression rotates the head alone, about a pivot at the
// mouth: a turn about a low point swings the crown and barely moves the chin,
// which is what keeps the jaw sitting in the collar.
import { DevHands, blend, sample, type HandPose } from "./dev-hands";
import { GESTURES, GESTURE_HOME, gestureLength, holdAt } from "./dev-hands-data";
import { BASE, Expr, hexToRgb, moodExpr } from "./moods";
import { GlitchDriver } from "./vex";

const NS = "http://www.w3.org/2000/svg";
const el = (n: string, a: Record<string, any> = {}, p?: Element) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, String(a[k])); p?.appendChild(e); return e; };
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const rgb = (c: number[]) => `rgb(${c.map(Math.round).join(",")})`;
const mix = (c: number[], t: number[], k: number) => c.map((v, i) => lerp(v, t[i], k));
/** sRGB-ish lift toward a target, for the one or two colors picked by eye. */

/** `gesture` is the pose the arm is in this frame, already blended. Absent
 *  means the arm is at rest and the rig draws its own. */
export interface DevState extends Expr { rgb: [number, number, number]; blink: number; talkOpen: number; gesture?: HandPose }

// ── his proportions, from the fit. Ratios, not guesses. ─────────────────────
const H = 250;                                   // brow top to chin
const FACE_W = 0.861 * H;
const JAW_W = 0.815 * 0.860 * H;
const EYE_SPAN = 0.610 * FACE_W;                 // outer corner to outer corner
const EYE_LINE = 0.290 * H;                      // down from brow top
const NOSE_TIP = 0.504 * H;
const LIP_LINE = 0.720 * H;
const CHIN_CREASE = 0.921 * H;
const EYE_W = 0.303 * EYE_SPAN;
// measured opening is 0.309 of eye width, which is genuinely deep-set and at
// avatar size reads as half asleep. This is the one number stylized up.
const EYE_H = 0.46 * EYE_W;
const EYE_X = (EYE_SPAN - EYE_W) / 2;
const NOSE_W = 0.488 * EYE_SPAN;
const MOUTH_W = 0.614 * EYE_SPAN;

const hw = FACE_W / 2, jw = JAW_W / 2;
const browTop = -EYE_LINE, chinY = H - EYE_LINE, crown = browTop - 0.42 * H;
const MOUTH_Y = LIP_LINE - EYE_LINE;
const NOSE_H = (0.504 - 0.271) * H;              // bridge to tip

// looking at Glitch, who lives in the upper left of the frame. The rotation
// and the gaze disagree slightly on purpose: that is what makes it read as
// looking AT something rather than as a tilted head.
export const GLITCH_TILT = 8.5;                  // degrees, clockwise
const GLITCH_LOOK_X = -0.80, GLITCH_LOOK_Y = -0.38;

function sym(pts: number[][]): string {
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length; i += 3) d += ` C${pts[i]} ${pts[i + 1]} ${pts[i + 2]}`;
  for (let i = pts.length - 1; i >= 3; i -= 3)
    d += ` C${-pts[i - 1][0]},${pts[i - 1][1]} ${-pts[i - 2][0]},${pts[i - 2][1]} ${-pts[i - 3][0]},${pts[i - 3][1]}`;
  return d + "Z";
}

const HEAD = sym([
  [0, chinY],
  [jw * 0.60, chinY - 1], [jw * 0.93, chinY - 18], [jw * 1.00, CHIN_CREASE - EYE_LINE - 8],
  [hw * 0.97, LIP_LINE - EYE_LINE - 34], [hw, NOSE_TIP - EYE_LINE - 28], [hw, 10],
  [hw, -34], [hw * 0.99, browTop + 14], [hw * 0.93, browTop - 28],
  [hw * 0.86, crown + 56], [hw * 0.50, crown + 2], [0, crown],
]);
const STUBBLE = sym([
  [0, chinY - 3],
  [jw * 0.58, chinY - 4], [jw * 0.93, chinY - 20], [jw * 0.99, CHIN_CREASE - EYE_LINE - 10],
  [hw * 0.94, LIP_LINE - EYE_LINE - 6], [hw * 0.90, NOSE_TIP - EYE_LINE + 30], [hw * 0.78, NOSE_TIP - EYE_LINE + 40],
  [hw * 0.48, NOSE_TIP - EYE_LINE + 26], [hw * 0.26, LIP_LINE - EYE_LINE - 28], [0, LIP_LINE - EYE_LINE - 32],
]);

/** The hair mass: straight segments, no curves. On a character built out of
 *  flat planes a faceted cap reads as deliberate where a smooth blob reads as
 *  a wig. Two points hold the center level — a single one spikes into a
 *  widow's peak he does not have. */
const HAIR = (() => {
  const pts = [
    [-hw * 0.94, browTop - 4], [-hw * 0.99, browTop - 48], [-hw * 0.96, crown + 72],
    [-hw * 0.78, crown + 28], [-hw * 0.44, crown + 4], [0, crown - 4],
    [hw * 0.44, crown + 4], [hw * 0.78, crown + 28], [hw * 0.96, crown + 72],
    [hw * 0.99, browTop - 48], [hw * 0.94, browTop - 4],
    [hw * 0.80, browTop - 28], [hw * 0.56, browTop - 56], [hw * 0.30, browTop - 44],
    [hw * 0.12, browTop - 38], [-hw * 0.12, browTop - 38], [-hw * 0.30, browTop - 44],
    [-hw * 0.56, browTop - 56], [-hw * 0.80, browTop - 28],
  ];
  return "M" + pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" L") + "Z";
})();

function hairStrands(): [string, number, number][] {
  const out: [string, number, number][] = [], n = 15;
  for (let i = 0; i < n; i++) {
    const u = (i / (n - 1)) * 2 - 1, a = Math.abs(u);
    const sx = u * hw * 0.58, sy = crown + 8 + a * a * 44;
    const ex = u * hw * (0.66 + a * 0.26), ey = browTop - 34 + a * a * 70;
    const cx = u * hw * 0.26, cy = crown - 2 + a * 14;
    out.push([`M${sx.toFixed(1)},${sy.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)}`, 1.8 + (1 - a) * 1.2, 0.55 + (1 - a) * 0.35]);
  }
  return out;
}

const EAR = "M0,-34 C15,-39 28,-22 27,-3 C26,14 19,29 9,35 C2,39 -3,34 -4,27 C-7,10 -8,-18 0,-34Z";
const EAR_FOLD = "M5,-21 C15,-18 17,-3 12,9 C9,17 5,21 1,23";

// shoulders: deltoid-led, widest at the cap, tapering to the waist
const SH = hw * 2.62, BOT = chinY + 430;
const NT = jw * 0.74, NB = jw * 1.02;
/** His boom mic, measured off a matted frame and converted into rig units.
 *  Mount at the upper right, grille down near his chest: 224 units long at
 *  58 degrees, which is a CLOCKWISE rotation in SVG. Getting that sign wrong
 *  points it off his shoulder into the air. Taken by fitting the long axis
 *  of the mic's own blob in the matted frame, not read off a screenshot. */
const MIC = { x: 242, y: 197, rot: 58.3, w: 91 };
const ARM_TOP_X = SH * 0.88 + Math.sin((25 * Math.PI) / 180) * NOSE_H;
const ARM_TOP_Y = chinY + 70 + Math.cos((25 * Math.PI) / 180) * NOSE_H;

let EYE_ID = 0;
function makeEye(parent: Element, o: { w: number; h: number; rx: number }) {
  const g = el("g", {}, parent);
  // Glitch hides his lid rectangles behind a dark visor. Dev has no visor, so
  // unclipped they paint a band straight across his face at eye level.
  const cid = `dvx-eye${++EYE_ID}`;
  el("rect", { x: -o.w / 2, y: -o.h / 2, width: o.w, height: o.h, rx: o.rx }, el("clipPath", { id: cid }, g));
  const inner = el("g", { "clip-path": `url(#${cid})` }, g);
  const glow = el("rect", { x: -o.w / 2 - 10, y: -o.h / 2 - 10, width: o.w + 20, height: o.h + 20, rx: o.rx + 10, filter: "url(#dvx-blur)" }, g);
  const body = el("rect", { x: -o.w / 2, y: -o.h / 2, width: o.w, height: o.h, rx: o.rx }, inner);
  const iris = el("circle", { r: o.w * 0.27, fill: "rgba(0,0,0,.25)" }, inner);
  const pupil = el("circle", { r: o.w * 0.17, fill: "#070910" }, inner);
  const hi = el("circle", { r: o.w * 0.06, cx: -o.w * 0.1, cy: -o.h * 0.14, fill: "#fff", opacity: 0.85 }, inner);
  const lidT = el("rect", { x: -o.w, y: -o.h * 1.5, width: o.w * 2, height: o.h * 1.5 }, inner);
  const lidB = el("rect", { x: -o.w, y: 0, width: o.w * 2, height: o.h * 1.5 }, inner);
  const arc = el("path", { fill: "none", "stroke-width": o.w * 0.14, "stroke-linecap": "round", filter: "url(#dvx-glow)" }, g);
  const brow = el("path", { fill: "none", "stroke-width": o.w * 0.13, "stroke-linecap": "round" }, g);
  return {
    g, lids: [lidT, lidB],
    update(s: DevState, side: -1 | 1, skin: string) {
      const c = rgb(s.rgb);
      body.setAttribute("fill", c); glow.setAttribute("fill", c);
      arc.setAttribute("stroke", c); brow.setAttribute("stroke", c);
      glow.setAttribute("opacity", String(0.32 * s.glow));
      lidT.setAttribute("fill", skin); lidB.setAttribute("fill", skin);
      const lt = clamp(Math.max(s.lidT + (side > 0 ? s.asym * 0.25 : 0), s.blink), -0.2, 1);
      lidT.setAttribute("transform", `translate(0,${-o.h / 2 + lt * o.h}) rotate(${s.browA * 14 * -side})`);
      lidB.setAttribute("transform", `translate(0,${o.h / 2 - clamp(s.lidB, -0.2, 1) * o.h * 0.6})`);
      const px = s.lookX * o.w * 0.22, py = s.lookY * o.h * 0.2;
      pupil.setAttribute("transform", `translate(${px},${py}) scale(${s.pupil})`);
      iris.setAttribute("transform", `translate(${px * 0.7},${py * 0.7}) scale(${lerp(1, s.pupil, 0.6)})`);
      hi.setAttribute("transform", `translate(${px * 0.5},${py * 0.5})`);
      const sq = s.squint;
      for (const e of [body, iris, pupil, hi, lidT, lidB]) e.setAttribute("opacity", String(1 - sq));
      arc.setAttribute("opacity", String(sq));
      arc.setAttribute("d", `M${-o.w / 2},${o.h * 0.12} Q0,${-o.h * 0.75} ${o.w / 2},${o.h * 0.12}`);
      const by = -o.h * 1.55 - s.browY * o.h * 0.5 - (side < 0 ? s.asym * o.h * 0.4 : 0);
      const tb = s.browA * o.h * 0.42 * side;
      brow.setAttribute("d", `M${-side * o.w * 0.52},${by + tb} Q0,${by - o.h * 0.34} ${side * o.w * 0.52},${by - tb * 0.6}`);
      brow.setAttribute("opacity", "0.92");
    },
  };
}

function mouthPath(W: number, Hh: number, s: Expr, open: number) {
  const w = W * s.mouthW, up = s.mouthCurve * Hh, sm = s.smirk * Hh * 0.7, op = open * Hh * 1.3;
  const xl = -w / 2, xr = w / 2, yl = -up - sm, yr = -up + sm;
  const cb = up * 0.9 + op, ct = up * 0.9 - op * 0.55;
  return { xl, xr, yl, yr, cb, path: `M${xl},${yl} Q0,${cb} ${xr},${yr} Q0,${ct} ${xl},${yl}Z` };
}

/** Where the bust sits in the 1920x1080 frame. `y` is his EYE LINE, because
 *  the rig's local origin is the eye line, and `scale` is set so the avatar's
 *  outer-eye span matches his.
 *
 *  Measured 2026-10-29 against a matted frame from Week 06 / 07: his span is
 *  179 px, centred at x 965 with the eye line at y 357. Re-measure if the
 *  camera or the seating ever moves. */
export const DEV_LAYOUT = { W: 1920, H: 1080, x: 965, y: 357, scale: 1.363 };

export class DevRig {
  private root: SVGElement; private inner: SVGElement; private headG!: SVGElement; private neckG!: SVGElement;
  private face!: SVGElement; private glowFace!: SVGElement; private contour!: SVGElement; private stubble!: SVGElement;
  private nose!: SVGElement; private nostrils!: SVGElement; private hairMass!: SVGElement; private hairStrokes: SVGElement[] = [];
  private ears: { shell: SVGElement; fold: SVGElement }[] = [];
  private eyeL; private eyeR;
  private mouthShape!: SVGElement; private mouthLine!: SVGElement;
  private neck!: SVGElement; private sterno!: SVGElement; private shirt!: SVGElement; private seams!: SVGElement;
  private armShapes: { body: SVGElement; line: SVGElement; side: number }[] = [];
  private gLayer?: SVGElement;
  private gFront?: SVGElement;
  private hands?: DevHands;
  private micG!: SVGElement;
  private micParts: SVGElement[] = []; private micDetail!: SVGElement; private micDot!: SVGElement;

  constructor(svg: SVGSVGElement | SVGGElement, opts: { x?: number; y?: number; scale?: number } = {}) {
    if (svg.tagName.toLowerCase() === "svg") svg.setAttribute("viewBox", `0 0 ${DEV_LAYOUT.W} ${DEV_LAYOUT.H}`);
    defs(svg as SVGSVGElement);
    // Spreading opts would let an explicit `undefined` (which is exactly what
    // the page passes when a query param is absent) overwrite the default and
    // produce translate(undefined,undefined), which SVG silently ignores.
    const L = {
      x: opts.x ?? DEV_LAYOUT.x,
      y: opts.y ?? DEV_LAYOUT.y,
      scale: opts.scale ?? DEV_LAYOUT.scale,
    };
    this.root = el("g", { transform: `translate(${L.x},${L.y}) scale(${L.scale})` }, svg);
    this.inner = el("g", {}, this.root);
    let h = this.inner;

    // ── body ──────────────────────────────────────────────────────────────
    const body = el("g", {}, h);
    this.neckG = el("g", {}, body);
    this.neck = el("path", {
      "stroke-width": 2.5,
      d: `M${-NT},${chinY - 34} C${-NT * 1.02},${chinY + 14} ${-NB * 0.92},${chinY + 40} ${-NB},${chinY + 118}` +
         ` L${NB},${chinY + 118} C${NB * 0.92},${chinY + 40} ${NT * 1.02},${chinY + 14} ${NT},${chinY - 34}Z`,
    }, this.neckG);
    this.sterno = el("path", {
      fill: "none", "stroke-width": 2.2, opacity: 0.34,
      d: `M${-NT * 0.62},${chinY - 18} C${-NT * 0.52},${chinY + 24} ${-NB * 0.46},${chinY + 48} ${-NB * 0.4},${chinY + 72}` +
         ` M${NT * 0.62},${chinY - 18} C${NT * 0.52},${chinY + 24} ${NB * 0.46},${chinY + 48} ${NB * 0.4},${chinY + 72}`,
    }, this.neckG);

    for (const as of [-1, 1]) {
      const a = el("path", {
        "stroke-width": 2.5,
        d: `M${as * ARM_TOP_X},${ARM_TOP_Y} C${as * SH},${chinY + 190} ${as * SH},${chinY + 290} ${as * SH * 0.93},${BOT}` +
           ` L${as * SH * 0.5},${BOT} C${as * SH * 0.56},${chinY + 270} ${as * SH * 0.58},${chinY + 150} ${as * SH * 0.58},${chinY + 70}Z`,
      }, body);
      const ln = el("path", {
        fill: "none", "stroke-width": 2, opacity: 0.3,
        d: `M${as * SH * 0.86},${chinY + 250} C${as * SH * 0.84},${chinY + 320} ${as * SH * 0.8},${chinY + 380} ${as * SH * 0.78},${BOT}`,
      }, body);
      this.armShapes.push({ body: a, line: ln, side: as });
    }

    this.shirt = el("path", {
      "stroke-width": 2.5,
      d: `M${-SH * 1.05},${chinY + 212} C${-SH * 1.1},${chinY + 128} ${-SH * 0.99},${chinY + 64} ${-SH * 0.62},${chinY + 44}` +
         ` C${-NB * 1.3},${chinY + 30} ${-NB * 1.08},${chinY + 26} ${-NB * 0.96},${chinY + 28}` +
         ` C${-NB * 0.66},${chinY + 66} ${NB * 0.66},${chinY + 66} ${NB * 0.96},${chinY + 28}` +
         ` C${NB * 1.08},${chinY + 26} ${NB * 1.3},${chinY + 30} ${SH * 0.62},${chinY + 44}` +
         ` C${SH * 0.99},${chinY + 64} ${SH * 1.1},${chinY + 128} ${SH * 1.05},${chinY + 212}` +
         ` L${SH * 0.6},${chinY + 168} C${SH * 0.57},${chinY + 280} ${SH * 0.54},${chinY + 380} ${SH * 0.54},${BOT}` +
         ` L${-SH * 0.54},${BOT} C${-SH * 0.54},${chinY + 380} ${-SH * 0.57},${chinY + 280} ${-SH * 0.6},${chinY + 168}Z`,
    }, body);
    this.seams = el("path", {
      fill: "none", "stroke-width": 2.4, opacity: 0.45,
      d: `M${-NB * 0.96},${chinY + 36} C${-NB * 0.64},${chinY + 72} ${NB * 0.64},${chinY + 72} ${NB * 0.96},${chinY + 36}` +
         ` M${-SH * 1.05},${chinY + 212} L${-SH * 0.6},${chinY + 168}` +
         ` M${SH * 1.05},${chinY + 212} L${SH * 0.6},${chinY + 168}`,
    }, body);

    // ── the boom mic ───────────────────────────────────────────────────────
    // It is in frame in every real shot, so without one here it would vanish
    // mid-dissolve: a conspicuous thing disappearing at the exact moment the
    // audience should be watching his face. Positioned off a matted frame
    // from Week 06 / 07, in the rig's own local units.
    const mic = el("g", { transform: `translate(${MIC.x},${MIC.y}) rotate(${MIC.rot})` }, body);
    this.micG = mic;
    this.micParts = [];
    const mw = MIC.w;
    // A stub, not a boom. His real arm is dark and off frame, so a long bright
    // diagonal here is the one thing in the drawing with no counterpart in the
    // shot, and the eye goes straight to it during the dissolve.
    this.micParts.push(el("rect", { x: -mw * 0.1, y: -52, width: mw * 0.2, height: 64, rx: mw * 0.09, "stroke-width": 2.5 }, mic));
    // shock-mount yoke
    this.micParts.push(el("rect", { x: -mw * 0.3, y: -22, width: mw * 0.6, height: 34, rx: 7, "stroke-width": 2.5 }, mic));
    // body
    this.micParts.push(el("rect", { x: -mw / 2, y: 6, width: mw, height: 144, rx: mw * 0.16, "stroke-width": 3 }, mic));
    // grille
    this.micParts.push(el("rect", { x: -mw * 0.48, y: 150, width: mw * 0.96, height: 82, rx: mw * 0.3, "stroke-width": 3 }, mic));
    // the few details that make it read as a condenser and not a baton
    this.micDetail = el("path", {
      fill: "none", "stroke-width": 2.2, opacity: 0.5,
      d: `M${-mw * 0.4},172 L${mw * 0.4},172 M${-mw * 0.44},196 L${mw * 0.44},196 M${-mw * 0.4},220 L${mw * 0.4},220` +
         ` M${-mw / 2},50 L${mw / 2},50 M${-mw / 2},128 L${mw / 2},128`,
    }, mic);
    this.micDot = el("circle", { cx: 0, cy: 92, r: mw * 0.055 }, mic);

    // ── head, in its own group so the body can stay still ─────────────────
    h = this.headG = el("g", {}, this.inner);
    const earY = (NOSE_TIP - EYE_LINE) * 0.3;
    for (const es of [-1, 1]) {
      const eg = el("g", { transform: `translate(${es * hw * 0.955},${earY}) scale(${es * 1.02},1.12)` }, h);
      this.ears.push({
        shell: el("path", { d: EAR, "stroke-width": 2.6, "stroke-linejoin": "round" }, eg),
        fold: el("path", { d: EAR_FOLD, fill: "none", "stroke-width": 2.2, "stroke-linecap": "round", opacity: 0.6 }, eg),
      });
    }
    this.glowFace = el("path", { d: HEAD, filter: "url(#dvx-blur)", opacity: 0 }, h);
    this.face = el("path", { d: HEAD, fill: "#0c0f17" }, h);
    this.stubble = el("path", { d: STUBBLE, opacity: 0.22, mask: "url(#dvx-stubmask)" }, h);
    this.contour = el("path", { d: HEAD, fill: "none", "stroke-width": 3.5, "stroke-linejoin": "round", filter: "url(#dvx-glow)" }, h);
    this.nose = el("path", { fill: "none", "stroke-width": 5, "stroke-linecap": "round", "stroke-linejoin": "round", opacity: 0.95, filter: "url(#dvx-glow)" }, h);
    this.nostrils = el("path", { opacity: 0.5 }, h);

    const hair = el("g", { opacity: 0.8 }, h);
    this.hairMass = el("path", { d: HAIR, "stroke-width": 2, "stroke-linejoin": "round" }, hair);
    const strandG = el("g", { "clip-path": "url(#dvx-hairclip)" }, hair);
    for (const [d, w, o] of hairStrands())
      this.hairStrokes.push(el("path", { d, fill: "none", "stroke-width": w, "stroke-linecap": "round", opacity: o }, strandG));

    const vis = el("g", {}, h);
    this.eyeL = makeEye(vis, { w: EYE_W, h: EYE_H, rx: EYE_H * 0.42 });
    this.eyeL.g.setAttribute("transform", `translate(${-EYE_X},0)`);
    this.eyeR = makeEye(vis, { w: EYE_W, h: EYE_H, rx: EYE_H * 0.42 });
    this.eyeR.g.setAttribute("transform", `translate(${EYE_X},0)`);

    const mg = el("g", { transform: `translate(0,${MOUTH_Y})` }, h);
    this.mouthShape = el("path", { filter: "url(#dvx-glow)" }, mg);
    this.mouthLine = el("path", { fill: "none", "stroke-width": 5, "stroke-linecap": "round", filter: "url(#dvx-glow)" }, mg);
  }

  /** An empty group BEHIND the shirt, for something else to draw a limb into.
   *  A gesturing arm has to sit under the tee the way the resting ones do, or
   *  it reads as laid on top of him. */
  gestureLayer(): SVGElement {
    if (!this.gLayer) {
      this.gLayer = el("g");
      this.shirt.parentNode!.insertBefore(this.gLayer, this.shirt);
    }
    return this.gLayer;
  }

  /** An empty group over the shirt but UNDER the mic, for the forearm and
   *  hand. A hand is outside the tee but it still passes behind the
   *  microphone, which is a physical object between him and the lens. */
  gestureFrontLayer(): SVGElement {
    if (!this.gFront) {
      this.gFront = el("g");
      this.micG.parentNode!.insertBefore(this.gFront, this.micG);
    }
    return this.gFront;
  }

  /** Hide one resting arm, for when something else is drawing it: a gesture
   *  needs the limb to bend at an elbow below the frame, which the static
   *  shape cannot do. `side` is -1 for camera left. Default is both shown. */
  showArm(side: number, visible: boolean) {
    for (const a of this.armShapes) {
      if (a.side !== side) continue;
      for (const e of [a.body, a.line]) e.setAttribute("display", visible ? "inline" : "none");
    }
  }

  /** `gl` 0..1 is "turned toward Glitch". */
  update(s: DevState, t: number, gl = 0) {
    const c = rgb(s.rgb), dark = [12, 15, 23];
    const faceCol = "#0c0f17";
    this.glowFace.setAttribute("fill", c);
    this.glowFace.setAttribute("opacity", String(0.1 * s.glow));
    this.contour.setAttribute("stroke", c);
    this.nose.setAttribute("stroke", c);
    this.stubble.setAttribute("fill", rgb(mix(s.rgb, [255, 255, 255], 0.42)));
    const hairCol = rgb(mix(dark, s.rgb, 0.52));
    this.hairMass.setAttribute("fill", hairCol);
    this.hairMass.setAttribute("stroke", rgb(mix(s.rgb, [255, 255, 255], 0.1)));
    for (const p of this.hairStrokes) p.setAttribute("stroke", rgb(mix(s.rgb, [255, 255, 255], 0.3)));
    for (const e of this.ears) { e.shell.setAttribute("fill", faceCol); e.shell.setAttribute("stroke", c); e.fold.setAttribute("stroke", c); }
    this.neck.setAttribute("fill", faceCol); this.neck.setAttribute("stroke", c); this.sterno.setAttribute("stroke", c);
    this.shirt.setAttribute("fill", rgb(mix([19, 24, 34], s.rgb, 0.16))); this.shirt.setAttribute("stroke", c);
    this.seams.setAttribute("stroke", c);
    for (const a of this.armShapes) { a.body.setAttribute("fill", faceCol); a.body.setAttribute("stroke", c); a.line.setAttribute("stroke", c); }
    for (const m of this.micParts) { m.setAttribute("fill", rgb(mix([19, 24, 34], s.rgb, 0.10))); m.setAttribute("stroke", c); }
    this.micDetail.setAttribute("stroke", c);
    this.micDot.setAttribute("fill", c);

    const nb = NOSE_TIP - EYE_LINE, nw = NOSE_W / 2;
    this.nose.setAttribute("d",
      `M${-nw * 0.3},${-EYE_H * 0.9} C${-nw * 0.46},${nb * 0.45} ${-nw * 0.52},${nb * 0.8} ${-nw * 0.4},${nb - 4}` +
      ` Q0,${nb + 12} ${nw * 0.4},${nb - 4}` +
      ` M${-nw * 0.72},${nb - 2} q${nw * 0.16},11 ${nw * 0.32},10` +
      ` M${nw * 0.72},${nb - 2} q${-nw * 0.16},11 ${-nw * 0.32},10`);
    this.nostrils.setAttribute("fill", rgb(mix(dark, s.rgb, 0.25)));
    this.nostrils.setAttribute("d",
      `M${-nw * 0.46},${nb + 5} a${nw * 0.13},4 0 1,0 0.1,0 Z` +
      `M${nw * 0.33},${nb + 5} a${nw * 0.13},4 0 1,0 0.1,0 Z`);

    const oldX = s.lookX, oldY = s.lookY;
    if (gl > 0.001) { s.lookX = lerp(s.lookX, GLITCH_LOOK_X, gl); s.lookY = lerp(s.lookY, GLITCH_LOOK_Y, gl); }
    this.eyeL.update(s, -1, faceCol); this.eyeR.update(s, 1, faceCol);
    s.lookX = oldX; s.lookY = oldY;

    const open = Math.max(s.mouthOpen, s.talkOpen);
    const m = mouthPath(MOUTH_W, 12, s, open);
    this.mouthShape.setAttribute("d", m.path);
    this.mouthShape.setAttribute("fill", c);
    this.mouthShape.setAttribute("opacity", open > 0.05 ? "0.92" : "0");
    this.mouthLine.setAttribute("d", `M${m.xl},${m.yl} Q0,${m.cb} ${m.xr},${m.yr}`);
    this.mouthLine.setAttribute("stroke", c);

    const shake = s.shake * Math.sin(t * 40) * 3;
    const ang = s.tilt * 9 + gl * GLITCH_TILT + Math.sin(t * 0.8) * 0.7;
    this.headG.setAttribute("transform",
      `translate(${shake},${Math.sin(t * 1.3) * 2.2 * s.bob - s.lift * 8}) rotate(${ang},0,${MOUTH_Y})`);
    // the neck comes along for part of the ride, the way a neck does. Without
    // it the jaw opens a gap on one side of the collar and overlaps the other.
    this.neckG.setAttribute("transform", `rotate(${ang * 0.42},0,${chinY + 112})`);

    if (s.glitch > 0.05) {
      const on = Math.sin(t * 37) * Math.sin(t * 11) > 0.2 - s.glitch * 0.6;
      this.inner.setAttribute("filter", on ? "url(#dvx-static)" : "");
      this.inner.setAttribute("opacity", on ? String(0.75 + Math.random() * 0.25) : "1");
    } else { this.inner.removeAttribute("filter"); this.inner.setAttribute("opacity", "1"); }

    // The gesturing arm replaces the rig's own resting one for good, not just
    // for the length of a gesture: handing over mid-shot made the arm blink.
    // With no gesture running it draws the same limb at HOME.
    (this.hands ??= new DevHands(this)).update(s.gesture ?? null, s);
  }
}

function defs(svg: SVGSVGElement) {
  const d = el("defs", {}, svg);
  const f1 = el("filter", { id: "dvx-blur", x: "-50%", y: "-50%", width: "200%", height: "200%" }, d);
  el("feGaussianBlur", { stdDeviation: 12 }, f1);
  const f2 = el("filter", { id: "dvx-glow", x: "-50%", y: "-50%", width: "200%", height: "200%" }, d);
  el("feGaussianBlur", { stdDeviation: 4, result: "b" }, f2);
  const mg = el("feMerge", {}, f2); el("feMergeNode", { in: "b" }, mg); el("feMergeNode", { in: "SourceGraphic" }, mg);
  const fg = el("filter", { id: "dvx-static", x: "-10%", y: "-10%", width: "120%", height: "120%" }, d);
  el("feTurbulence", { type: "fractalNoise", baseFrequency: "0.9 0.05", numOctaves: 1, seed: 3, result: "n" }, fg);
  el("feDisplacementMap", { in: "SourceGraphic", in2: "n", scale: 18, xChannelSelector: "R", yChannelSelector: "G" }, fg);
  el("path", { d: HAIR }, el("clipPath", { id: "dvx-hairclip" }, d));
  // Stubble stamped at one opacity reads as a painted-on beard mask; fade it
  // upward so it thins into the cheek the way it actually does.
  const sg = el("linearGradient", { id: "dvx-stub", x1: 0, x2: 0, gradientUnits: "userSpaceOnUse", y1: NOSE_TIP - EYE_LINE + 10, y2: chinY - 20 }, d);
  el("stop", { offset: 0, "stop-color": "#fff", "stop-opacity": 0 }, sg);
  el("stop", { offset: 0.45, "stop-color": "#fff", "stop-opacity": 0.85 }, sg);
  el("stop", { offset: 1, "stop-color": "#fff", "stop-opacity": 1 }, sg);
  const mk = el("mask", { id: "dvx-stubmask" }, d);
  el("rect", { x: -hw * 2, y: crown - 60, width: hw * 4, height: chinY - crown + 200, fill: "url(#dvx-stub)" }, mk);
}

/** Glitch's driver plus "turned toward Glitch", which Dev needs and Glitch does not. */
export class DevDriver {
  private g: GlitchDriver;
  gl = 0; toGlitch = false;
  constructor(seed = 7) { this.g = new GlitchDriver(seed); }
  get mood() { return this.g.mood; }
  /** The state as last ticked. Read-only; anything drawing alongside the rig
   *  (a gesture layer, an overlay) needs the current mood colour. */
  get cur(): DevState { return (this.g as any).cur as DevState; }
  // ── the arm ──────────────────────────────────────────────────────────
  // A gesture is keyframes from home and back. A HELD one stops at its hold
  // keyframe and stays there until something else is asked for; asking for
  // another one tweens straight across from wherever the hand is, rather
  // than dropping home and coming back up, which would read as a stutter.
  private gname: string | null = null;    // what is playing or held
  private gt = 0;                         // seconds into it
  private tweenFrom: HandPose | null = null;   // a cross-fade between two holds
  private tweenTo: HandPose | null = null;
  private tweenT = 0; private tweenDur = 0;
  private tweenName: string | null = null;     // what we land on when it ends
  private pose: HandPose | null = null;        // what was drawn last frame

  /** Start a gesture. `null` or "home" releases whatever is held. */
  playGesture(name: string | null) {
    const next = name && name !== GESTURE_HOME && GESTURES[name] ? name : null;
    if (next && next === this.gname && this.tweenName == null) return;  // already there
    const out = this.pose && this.pose.vis > 0.01;                      // hand currently on screen
    const hold = next ? holdAt(next) : null;

    if (next && hold != null && out) {
      // hand is already up: cross over to the new shape in place
      this.tweenFrom = this.pose!; this.tweenTo = sample(next, hold);
      this.tweenT = 0; this.tweenDur = Math.max(.08, hold);
      this.tweenName = next; this.gname = next; this.gt = hold;
      return;
    }
    if (!next && this.gname && holdAt(this.gname) != null) {
      // release: run the rest of the held gesture's keys, which are its way home
      this.gt = Math.max(this.gt, holdAt(this.gname)!);
      this.released = true;
      this.tweenFrom = this.tweenTo = this.tweenName = null;
      return;
    }
    this.tweenFrom = this.tweenTo = this.tweenName = null;
    this.released = false;
    this.gname = next; this.gt = 0;
  }

  /** Pin the arm to one pose and stop the clock. The gesture editor needs
   *  this to dial a single keyframe in; nothing in a recording uses it. */
  forcePose(p: HandPose | null) { this.forced = p; }
  private forced: HandPose | null = null;

  /** The pose for this frame, or null when the arm is away and the rig
   *  should draw its own. */
  private tickArm(dt: number): HandPose | null {
    if (this.forced) return (this.pose = this.forced);
    if (this.tweenTo) {
      this.tweenT += dt;
      const u = Math.min(1, this.tweenT / this.tweenDur);
      this.pose = blend(this.tweenFrom!, this.tweenTo, u < .5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2);
      if (u >= 1) { this.tweenFrom = this.tweenTo = this.tweenName = null; }
      return this.pose;
    }
    if (!this.gname) { this.pose = null; return null; }
    const hold = holdAt(this.gname);
    this.gt += dt;
    // a held gesture waits at its hold keyframe until it is released
    if (hold != null && this.gt > hold && !this.released) this.gt = hold;
    if (this.gt > gestureLength(this.gname)) { this.gname = null; this.released = false; this.pose = null; return null; }
    this.pose = sample(this.gname, this.gt);
    return this.pose;
  }
  private released = false;

  setMood(m: string, hold?: number) { this.g.setMood(m, hold); }
  setTalking(v: boolean) { this.g.setTalking(v); }
  setToGlitch(v: boolean) { this.toGlitch = v; }
  tick(dt: number): DevState {
    const s = this.g.tick(dt) as unknown as DevState;
    this.gl = lerp(this.gl, this.toGlitch ? 1 : 0, 1 - Math.pow(0.004, dt));
    s.gesture = this.tickArm(dt) ?? undefined;
    return s;
  }
}

/** How long the last leg of a gesture takes: the way back home. */
function lastLeg(name: string): number {
  const k = GESTURES[name]?.keys; if (!k || k.length < 2) return .8;
  return k[k.length - 1].t - k[k.length - 2].t;
}

export { BASE, moodExpr, hexToRgb };
