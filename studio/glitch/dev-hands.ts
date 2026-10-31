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
import { GESTURES, HOME, SVG_HANDS, type HandPose, type HandShape } from "./dev-hands-data";
export { gestureNames, GESTURES, gestureLength } from "./dev-hands-data";
export type { HandPose } from "./dev-hands-data";

const NS = "http://www.w3.org/2000/svg";
const el = (n: string, a: Record<string, any> = {}, p?: Element) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, String(a[k])); p?.appendChild(e); return e; };
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = (t: number) => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
/** Turning from +120 to -16 should sweep 136 degrees, not 224 the other way. */
const lerpAngle = (a: number, b: number, t: number) => { const d = ((b - a) % 360 + 540) % 360 - 180; return a + d * t; };

// The joint sits one eyebrow length down and out at 35 degrees from the
// sleeve cap, which puts it inside the tee rather than on its outer seam.
// Nudged out by 4 units and the shoulder end widened to 130 so the resting
// limb sits exactly where the rig's own arm did: now that this one is always
// the arm on screen, it has to match the UNTOUCHED right arm or he comes out
// lopsided. Measured against it rather than eyeballed.
const SHOULDER = { x: -206.0, y: 319.9 };
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
  // the soft crease the rig draws down the outside of its own arms
  const crease = `M${P(0.42, w1 * 0.34)} C${P(0.62, w1 * 0.33)} ${P(0.80, w2 * 0.33)} ${P(1, w2 * 0.31)}`;
  return {
    crease,
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
/** The pointing hand, traced from the one Jeromy drew: a foreshortened fist
 *  with the index finger coming at the lens. It is the only pose the sheet
 *  cannot stand in for, and the only one that is not a side-on view.
 *
 *  Same shape as every other hand: `sil` is the filled outline in raw file
 *  units anchored on the wrist, `parts` are his contour strokes in the file's
 *  own coordinates, and `tf` brings them to the wrist. He drew it with the
 *  heel already level, so nothing needs rotating. The fill he coloured blue
 *  is the silhouette; it takes the body colour here like all the others. */
const POINT: HandShape = { k: 0.5277, wrist: 44.6, tf: "scale(0.5277) translate(-76.0,-210.12)",
  sil: "M4.4,-166.8 L1.8,-166.5 L-1.0,-165.2 L-3.0,-163.8 L-5.0,-161.4 L-6.5,-156.0 L-8.6,-153.0 L-10.4,-149.4 L-13.8,-138.2 L-17.5,-131.6 L-26.4,-119.5 L-27.5,-116.5 L-27.2,-113.5 L-25.2,-110.2 L-21.6,-106.9 L-11.6,-102.5 L-7.0,-101.0 L2.4,-100.4 L18.4,-101.5 L21.9,-101.2 L-42.4,-0.2 L-36.9,6.4 L-35.0,10.0 L-19.5,21.5 L-15.8,22.8 L-13.0,22.5 L-9.4,21.4 L4.8,15.5 L10.2,12.1 L13.6,8.2 L17.0,8.0 L25.1,6.2 L38.8,2.1 L41.4,0.8 L43.0,-0.8 L43.4,-3.6 L44.4,-5.0 L50.0,-8.4 L52.2,-10.2 L54.9,-16.0 L55.6,-19.5 L55.8,-23.1 L54.9,-25.9 L52.1,-29.0 L51.8,-30.1 L52.5,-32.0 L55.8,-36.6 L57.8,-49.0 L57.4,-54.2 L56.6,-55.6 L54.4,-57.5 L59.8,-63.5 L61.0,-67.5 L61.2,-76.5 L60.0,-85.0 L58.1,-89.5 L54.0,-94.2 L47.5,-98.2 L42.1,-100.0 L34.0,-101.1 L21.9,-101.6 L18.8,-108.5 L17.8,-112.0 L17.6,-114.4 L20.5,-124.5 L23.1,-128.2 L25.2,-133.8 L26.1,-138.2 L26.1,-141.9 L25.5,-145.0 L22.0,-153.0 L18.5,-158.6 L12.6,-163.5 L7.8,-165.9Z",
  parts: [{d:"m 33.636,209.995 c 12.727,14.091 1.364,5.909 12.727,14.091 11.363,8.182 11.363,10.909 20.909,7.273 9.545,-3.636 18.530,-7.429 20.292,-10.425 1.762,-2.995 2.290,-2.467 4.581,-2.643 2.290,-0.176 19.380,-3.876 24.489,-6.871 5.109,-2.995 1.057,-3.876 4.052,-6.343 2.995,-2.467 5.638,-2.643 7.752,-5.285 2.114,-2.643 4.405,-10.747 2.995,-14.447 -1.409,-3.700 -4.228,-3.524 -3.347,-5.990 0.881,-2.467 3.347,-3.524 3.876,-6.343 0.529,-2.819 2.467,-11.628 1.762,-16.033 -0.705,-4.405 -4.405,-2.995 -2.819,-4.933 1.586,-1.938 4.933,-4.052 5.814,-7.400 0.881,-3.347 1.586,-17.618 -2.643,-24.137 -4.228,-6.519 -11.804,-9.866 -18.323,-10.747 -6.519,-0.881 -11.804,-1.409 -23.256,-0.881 -11.452,0.529 -20.613,2.643 -29.246,-1.762 -8.633,-4.405 -7.928,-2.114 -12.157,-6.871 -4.228,-4.757 -3.171,-7.928 2.114,-14.623 5.286,-6.695 9.141,-12.041 10.457,-18.114 1.316,-6.073 3.745,-10.830 5.061,-12.146 1.316,-1.316 0.506,-2.227 1.822,-5.466 1.316,-3.239 5.263,-6.073 8.705,-6.478 3.441,-0.405 13.158,3.947 16.802,10.223 3.644,6.275 6.680,11.741 6.174,17.814 -0.506,6.073 -3.239,11.336 -4.757,13.259 -1.518,1.923 0,-1.417 -1.619,4.251 -1.619,5.668 -2.632,6.073 -1.822,9.818 0.810,3.745 4.049,9.818 4.049,9.818"},{d:"m 95.161,93.681 c 0,0 5.380,7.667 8.003,9.415 2.623,1.749 5.515,1.950 8.877,2.354 3.363,0.404 34.836,0.067 37.526,0.404 2.690,0.336 5.515,1.749 7.532,3.564 2.018,1.816 7.801,8.944 8.272,12.509 0.471,3.564 0,6.456 -0.605,8.137 -0.605,1.681 -1.009,0.471 0,2.219 1.009,1.749 3.363,6.053 2.825,10.827 -0.538,4.775 -6.860,7.936 -10.088,8.944 -3.228,1.009 -11.769,-1.480 -14.728,-3.161 -2.959,-1.681 -5.784,-5.649 -5.784,-5.649"},{d:"m 130.502,152.916 c 0,0 -3.834,2.212 -7.742,3.023 -3.908,0.811 -11.059,1.991 -16.442,1.548 -5.382,-0.442 -12.976,-0.516 -19.243,-2.875 -6.267,-2.359 -19.391,-9.290 -19.391,-9.290"},{d:"m 127.921,179.311 c 0,0 -8.700,6.709 -11.870,8.037 -3.170,1.327 -9.069,1.180 -13.271,0.664 -4.203,-0.516 -16.515,-1.548 -20.792,-2.654 -4.276,-1.106 -18.580,-6.931 -18.580,-6.931"},{d:"m 50.136,89.803 c 0,0 -2.433,3.465 -4.055,8.258 -1.622,4.792 -4.498,8.921 -7.447,12.903 -2.949,3.981 -7.594,8.774 -9.364,12.534 -1.770,3.760 2.064,17.695 1.843,22.266 -0.221,4.571 -0.442,6.341 -2.286,12.608 -1.843,6.267 -1.770,7.815 -4.792,16.884 -3.023,9.069 -5.014,14.598 -5.014,14.598"},{d:"m 89.845,218.490 c 0,0 -7.922,-1.697 -10.104,-2.465"},{d:"m 69.509,53.766 c 0,0 -1.243,9.897 -0.644,13.211 0.598,3.314 0.598,5.892 2.762,9.299 2.164,3.406 3.268,1.795 4.419,0.967 1.151,-0.829 1.151,-2.762 -0.046,-3.867 C 74.803,72.271 72.087,70.844 71.995,69.003 71.903,67.161 71.672,59.474 71.811,57.126 c 0.138,-2.348 0.460,-5.708 1.427,-7.411 0.967,-1.703 2.624,-2.900 2.440,-3.591 -0.184,-0.690 -1.059,-0.967 -1.059,-0.967"},{d:"m 96.594,85.390 c 0,0 -1.968,1.766 -4.138,2.372 -2.170,0.606 -6.561,1.918 -9.034,1.312"}] };

export const SHAPES: Record<string, HandShape> = { ...SVG_HANDS, soft: SVG_HANDS.flat, point: POINT };

const REST: HandPose = { ua: 30, fa: 210, len: 430, rot: 0, scale: 1, shape: "soft", vis: 0 };

/** Blend two poses. Shapes TOGGLE at the halfway point rather than tween:
 *  one finger cannot morph into two, so it swaps while the hand is moving
 *  and nobody sees the join. */
export function blend(a: HandPose, b: HandPose, u: number): HandPose {
  return {
    ua: lerp(a.ua, b.ua, u), fa: lerp(a.fa, b.fa, u), len: lerp(a.len, b.len, u),
    rot: lerpAngle(a.rot, b.rot, u), scale: lerp(a.scale, b.scale, u),
    shape: u < 0.5 ? a.shape : b.shape, flip: u < 0.5 ? a.flip : b.flip,
    vis: lerp(a.vis, b.vis, u),
  };
}

/** The pose a gesture is in `t` seconds after it started. */
export function sample(name: string, t: number): HandPose {
  const g = GESTURES[name];
  if (!g) return REST;
  const k = g.keys;
  if (t <= k[0].t) return k[0].p;
  for (let i = 1; i < k.length; i++) {
    if (t <= k[i].t) {
      const a = k[i - 1], b = k[i];
      return blend(a.p, b.p, ease((t - a.t) / Math.max(1e-6, b.t - a.t)));
    }
  }
  return k[k.length - 1].p;
}

export class DevHands {
  private upper: SVGElement; private crease: SVGElement; private foreFill: SVGElement; private fore: SVGElement;
  private handG: SVGElement; private silG: SVGElement; private silh: SVGElement; private handInner: SVGElement;
  private backParts: SVGElement[] = []; private handParts: SVGElement[] = [];
  private shown = false;

  constructor(private rig: DevRig) {
    const backG = el("g", {}, rig.gestureLayer());
    const armG = el("g", {}, rig.gestureFrontLayer());
    this.upper = el("path", { "stroke-width": ARM_STROKE, "stroke-linejoin": "round" }, backG);
    this.crease = el("path", { fill: "none", "stroke-width": 2, opacity: 0.3, "stroke-linecap": "round" }, backG);
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
  update(pose: HandPose | null, s: DevState) {
    // This arm is ALWAYS the one on screen, resting at HOME when nothing is
    // playing. Swapping it in only for the length of a gesture meant the
    // rig's own arm blinked out a frame before this one blinked in, which
    // read as the arm going black just before it moved.
    if (!this.shown) { this.shown = true; this.rig.showArm(-1, false); }
    pose = pose ?? HOME;

    const e = elbowAt(pose!.ua);
    const upper = limbGeom(SHOULDER.x, SHOULDER.y, e.x, e.y, 134, 96, 0.16);
    this.upper.setAttribute("d", upper.fill);
    this.crease.setAttribute("d", upper.crease);

    const r = pose!.fa * Math.PI / 180;
    const wx = e.x + Math.sin(r) * pose!.len, wy = e.y - Math.cos(r) * pose!.len;
    const shp = SHAPES[pose!.shape] ?? SHAPES.palm;
    const wristW = shp.wrist * pose!.scale;         // the arm ends as wide as the hand starts
    const fore = limbGeom(e.x, e.y, wx, wy, 100, wristW, 0.10);
    this.foreFill.setAttribute("d", fore.fill);
    this.fore.setAttribute("d", fore.sides);

    // The arm's colours, every frame. These used to sit below the early
    // return, so a resting arm was drawn with no stroke at all and read as a
    // black shape until the hand faded in.
    const c = `rgb(${s.rgb.map(Math.round).join(",")})`;
    const body = "#0c0f17";
    this.upper.setAttribute("fill", body); this.upper.setAttribute("stroke", c);
    this.crease.setAttribute("stroke", c);
    this.foreFill.setAttribute("fill", body);
    this.fore.setAttribute("stroke", c);

    // `vis` is the HAND fading in, not the arm. The arm is always solid; at
    // home it is simply below the bottom of the frame.
    this.handG.setAttribute("opacity", String(pose!.vis));
    if (pose!.vis <= 0.002) return;
    this.handG.setAttribute("transform", `translate(${wx},${wy}) rotate(${pose!.rot - pose!.fa}) scale(${pose!.scale})`);

    // the sheet is drawn as a camera-RIGHT hand; this arm is camera left
    const mirror = pose!.flip === false ? "" : "scale(-1,1) ";
    this.silh.setAttribute("d", shp.sil ?? "");
    this.silh.setAttribute("display", shp.sil ? "inline" : "none");
    this.silG.setAttribute("transform", `${mirror}scale(${shp.k || 1})`);
    this.handInner.setAttribute("transform", mirror + (shp.tf || ""));

    this.silh.setAttribute("fill", body);

    const lw = ARM_STROKE / ((shp.k || 1) * Math.max(0.01, pose!.scale));
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
