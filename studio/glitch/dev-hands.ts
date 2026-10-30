// Avatar Dev's gesturing arm.
//
// Every one of Jeromy's videos opens and closes the same way: a palm-forward
// "Greetings!", the same hand to his chest for "I'm Dev the Developer.", and
// at the end a point straight down the lens on "Do it!". Those two moves are
// what this draws. They were dialled in frame by frame against stills pulled
// from his own recordings, so the numbers below are measurements, not taste.
//
// The arm is ONE limb that bends at an elbow BELOW the frame. At rest the
// forearm carries straight on from the upper arm, so the limb leaves the
// bottom of the shot as a single line; a gesture only swings the forearm
// about that hidden elbow. That is simpler to drive than reaching for a wrist
// position, and it is closer to what the recording actually does.
//
//   ua  - upper arm, degrees away from the body (0 = straight down)
//   fa  - forearm, degrees from straight up, POSITIVE toward his body
//   len - forearm length, which is also how far the hand pushes at the lens
//   rot - hand rotation about the wrist
//
// Two layers, because an arm is on both sides of a shirt at once: the upper
// arm runs under the sleeve, the forearm and hand come out of it and cross in
// front of his chest. Putting the whole limb behind the tee hid the hand
// exactly when it mattered.
import type { DevRig, DevState } from "./dev-rig";
import { GESTURES, SVG_HANDS, type HandPose, type HandShape } from "./dev-hands-data";
export { GESTURE_NAMES, GESTURES, gestureLength } from "./dev-hands-data";
export type { HandPose } from "./dev-hands-data";

const NS = "http://www.w3.org/2000/svg";
const el = (n: string, a: Record<string, any> = {}, p?: Element) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, String(a[k])); p?.appendChild(e); return e; };
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = (t: number) => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
/** Turning from +120 to -16 should sweep 136 degrees, not 224 the other way. */
const lerpAngle = (a: number, b: number, t: number) => { const d = ((b - a) % 360 + 540) % 360 - 180; return a + d * t; };

// The joint sits one eyebrow length down and out at 35 degrees from the
// sleeve cap, which puts it inside the tee rather than on its outer seam.
const SHOULDER = { x: -204.3, y: 319.9 };
const UPPER_LEN = 353;                 // puts the elbow below the frame edge
const ARM_STROKE = 3;                  // the rig's own line weight; hands match it

function elbowAt(ua: number) {
  const r = ua * Math.PI / 180;
  return { x: SHOULDER.x - Math.sin(r) * UPPER_LEN, y: SHOULDER.y + Math.cos(r) * UPPER_LEN };
}

/** The resting arm is a tapered shape with a bicep swell, not a plain stroke.
 *  This rebuilds that outline along whatever direction the bone points, so a
 *  raised arm keeps the silhouette the lowered one has. */
function limbGeom(x1: number, y1: number, x2: number, y2: number, w1: number, w2: number, bulge: number) {
  const dx = x2 - x1, dy = y2 - y1, Ln = Math.hypot(dx, dy) || 1;
  const ux = dx / Ln, uy = dy / Ln, nx = -uy, ny = ux;
  const b = bulge;
  const P = (t: number, off: number) => `${(x1 + ux * Ln * t + nx * off).toFixed(1)},${(y1 + uy * Ln * t + ny * off).toFixed(1)}`;
  const side = (sg: number) => `M${P(0, sg * w1 / 2)} C${P(0.30, sg * w1 / 2 * (1 + b))} ${P(0.72, sg * w2 / 2 * 1.06)} ${P(1, sg * w2 / 2)}`;
  return {
    // closed, for the fill
    fill: `M${P(0, w1 / 2)} C${P(0.30, w1 / 2 * (1 + b))} ${P(0.72, w2 / 2 * 1.06)} ${P(1, w2 / 2)}` +
          ` L${P(1, -w2 / 2)} C${P(0.72, -w2 / 2 * 1.06)} ${P(0.30, -w1 / 2 * (1 + b))} ${P(0, -w1 / 2)}Z`,
    // the two long sides only, so nothing draws a line across the wrist
    sides: side(1) + " " + side(-1),
  };
}

/** The pointing hand stays hand-drawn. The foreshortened fist aimed at the
 *  lens is a view none of the sheet's side-on poses can stand in for, and it
 *  is the one frame of his sign-off that has to land. */
const FIST = "M-32,20 q-12,-30 -4,-52 q10,-26 36,-26 q28,0 38,26 q9,22 -2,52 q-10,18 -36,18 q-26,0 -32,-18Z";
const POINT: HandShape = { k: 1, wrist: 40, tf: "", sil: FIST, parts: [
  { d: FIST },
  { d: "M-30,-6 q30,10 62,2 M-29,8 q30,10 60,1 M-27,22 q28,9 56,0", op: .55 },
  { d: "M30,-26 q14,16 8,40 q-4,14 -14,16", op: .75 },
  { d: "M-6,-30 m-17,0 a17,21 0 1,0 34,0 a17,21 0 1,0 -34,0Z" },
  { d: "M-6,-34 m-8,0 a8,9 0 1,0 16,0 a8,9 0 1,0 -16,0Z", op: .5 },
] };

export const SHAPES: Record<string, HandShape> = { ...SVG_HANDS, soft: SVG_HANDS.flat, point: POINT };

const REST: HandPose = { ua: 30, fa: 210, len: 430, rot: 0, scale: 1, shape: "soft", vis: 0 };

function sample(name: string, t: number): HandPose {
  const k = GESTURES[name];
  if (!k) return REST;
  if (t <= k[0].t) return k[0].p;
  for (let i = 1; i < k.length; i++) {
    if (t <= k[i].t) {
      const a = k[i - 1], b = k[i], u = ease((t - a.t) / Math.max(1e-6, b.t - a.t));
      return {
        ua: lerp(a.p.ua, b.p.ua, u), fa: lerp(a.p.fa, b.p.fa, u), len: lerp(a.p.len, b.p.len, u),
        rot: lerpAngle(a.p.rot, b.p.rot, u), scale: lerp(a.p.scale, b.p.scale, u),
        // fingers do not interpolate into other fingers: shapes toggle
        shape: u < 0.5 ? a.p.shape : b.p.shape, flip: u < 0.5 ? a.p.flip : b.p.flip,
        vis: lerp(a.p.vis, b.p.vis, u),
      };
    }
  }
  return k[k.length - 1].p;
}

export class DevHands {
  private upper: SVGElement; private foreFill: SVGElement; private fore: SVGElement;
  private handG: SVGElement; private silG: SVGElement; private silh: SVGElement; private handInner: SVGElement;
  private backParts: SVGElement[] = []; private handParts: SVGElement[] = [];
  private shown = false;

  constructor(private rig: DevRig) {
    const backG = el("g", {}, rig.gestureLayer());
    const armG = el("g", {}, rig.gestureFrontLayer());
    this.upper = el("path", { "stroke-width": ARM_STROKE, "stroke-linejoin": "round" }, backG);
    this.foreFill = el("path", { stroke: "none" }, armG);
    this.fore = el("path", { fill: "none", "stroke-width": ARM_STROKE, "stroke-linecap": "round" }, armG);
    this.handG = el("g", {}, armG);
    this.silG = el("g", {}, this.handG);
    this.silh = el("path", { stroke: "none" }, this.silG);
    this.handInner = el("g", {}, this.handG);
  }

  private build(n: number) {
    while (this.backParts.length < n) this.backParts.push(el("path", { "stroke-linejoin": "round", "stroke-linecap": "round", fill: "none" }, this.handInner));
    while (this.handParts.length < n) this.handParts.push(el("path", { "stroke-linejoin": "round", "stroke-linecap": "round" }, this.handInner));
    this.backParts.forEach((p, i) => p.setAttribute("display", i < n ? "inline" : "none"));
    this.handParts.forEach((p, i) => p.setAttribute("display", i < n ? "inline" : "none"));
  }

  /** Draw the arm for this frame. `g` is null when no gesture is running, and
   *  the limb goes back to being the rig's own resting shape. */
  update(g: { name: string; t: number } | null, s: DevState) {
    const live = !!g && GESTURES[g.name] != null;
    if (live !== this.shown) {
      this.shown = live;
      // the rig draws its own resting arm on this side; ours replaces it
      this.rig.showArm(-1, !live);
      for (const e of [this.upper, this.foreFill, this.fore, this.handG]) e.setAttribute("display", live ? "inline" : "none");
    }
    if (!live) return;

    const pose = sample(g!.name, g!.t);
    const e = elbowAt(pose.ua);
    const upper = limbGeom(SHOULDER.x, SHOULDER.y, e.x, e.y, 122, 100, 0.16);
    this.upper.setAttribute("d", upper.fill);

    const r = pose.fa * Math.PI / 180;
    const wx = e.x + Math.sin(r) * pose.len, wy = e.y - Math.cos(r) * pose.len;
    const shp = SHAPES[pose.shape] ?? SHAPES.palm;
    const wristW = shp.wrist * pose.scale;         // the arm ends as wide as the hand starts
    const fore = limbGeom(e.x, e.y, wx, wy, 100, wristW, 0.10);
    this.foreFill.setAttribute("d", fore.fill);
    this.fore.setAttribute("d", fore.sides);

    this.handG.setAttribute("opacity", String(pose.vis));
    this.fore.setAttribute("opacity", String(pose.vis));
    this.foreFill.setAttribute("opacity", String(pose.vis));
    if (pose.vis <= 0.002) return;
    this.handG.setAttribute("transform", `translate(${wx},${wy}) rotate(${pose.rot - pose.fa}) scale(${pose.scale})`);

    // the sheet is drawn as a camera-RIGHT hand; this arm is camera left
    const mirror = pose.flip === false ? "" : "scale(-1,1) ";
    this.silh.setAttribute("d", shp.sil ?? "");
    this.silh.setAttribute("display", shp.sil ? "inline" : "none");
    this.silG.setAttribute("transform", `${mirror}scale(${shp.k || 1})`);
    this.handInner.setAttribute("transform", mirror + (shp.tf || ""));

    const c = `rgb(${s.rgb.map(Math.round).join(",")})`;
    const body = "#0c0f17";
    this.upper.setAttribute("fill", body); this.upper.setAttribute("stroke", c);
    this.foreFill.setAttribute("fill", body);
    this.fore.setAttribute("stroke", c);
    this.silh.setAttribute("fill", body);

    const lw = ARM_STROKE / ((shp.k || 1) * Math.max(0.01, pose.scale));
    this.build(shp.parts.length);
    shp.parts.forEach((q, i) => {
      // the backing is the same stroke fattened, in the body colour: it stops
      // a line-art hand reading as see-through over his shirt
      const b = this.backParts[i], f = this.handParts[i];
      b.setAttribute("d", q.d); b.setAttribute("stroke-width", String(lw * 6));
      b.setAttribute("stroke", body); b.setAttribute("fill", "none"); b.setAttribute("opacity", "1");
      f.setAttribute("d", q.d); f.setAttribute("stroke-width", String(lw * (q.w ? q.w / 3 : 1)));
      f.setAttribute("stroke", c); f.setAttribute("fill", "none");
      f.setAttribute("opacity", String(q.op ?? 1));
    });
  }
}
