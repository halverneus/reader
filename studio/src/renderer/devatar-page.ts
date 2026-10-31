// Standalone avatar-Dev page: the offline renderer steps it frame by frame,
// exactly the way glitch-page.ts is stepped, so the two stay in sync.
import { DevRig, DevDriver } from "../../glitch/dev-rig";
import { SHAPES } from "../../glitch/dev-hands";
import { GESTURES } from "../../glitch/dev-hands-data";
const svg = document.getElementById("dev") as unknown as SVGSVGElement;
const q = new URLSearchParams(location.search);
const rig = new DevRig(svg, {
  x: q.get("x") ? parseFloat(q.get("x")!) : undefined,
  y: q.get("y") ? parseFloat(q.get("y")!) : undefined,
  scale: q.get("scale") ? parseFloat(q.get("scale")!) : undefined,
});
const driver = new DevDriver(parseInt(q.get("seed") ?? "7"));
let manual = q.get("manual") === "1";
let last = performance.now();
function loop(now: number) { if (!manual) rig.update(driver.tick(Math.min(.05, (now - last) / 1000)), performance.now() / 1000, driver.gl); last = now; requestAnimationFrame(loop); }
requestAnimationFrame(loop);
(window as any).devatar = {
  driver, rig,
  mood: (m: string, hold?: number) => driver.setMood(m, hold),
  talk: (v: boolean) => driver.setTalking(v),
  toGlitch: (v: boolean) => driver.setToGlitch(v),
  gesture: (n: string | null) => driver.playGesture(n),
  // for the gesture editor only: pin one pose, and what shapes exist
  pose: (p: any) => driver.forcePose(p),
  shapes: () => Object.keys(SHAPES),
  gestures: () => GESTURES,
  step: (fps = 30, frame = 0) => { manual = true; rig.update(driver.tick(1 / fps), frame / fps, driver.gl); },
  frame: (): Promise<string> => new Promise((resolve, reject) => {
    const W = 1920, H = 1080;
    const src = new XMLSerializer().serializeToString(svg);
    const img = new Image();
    img.onload = () => { const c = canvas(W, H); const ctx = c.getContext("2d")!; ctx.clearRect(0, 0, W, H); ctx.drawImage(img, 0, 0, W, H); resolve(c.toDataURL("image/png")); };
    img.onerror = () => reject(new Error("svg rasterise failed"));
    const withNs = src.includes('xmlns="http://www.w3.org/2000/svg"') ? src : src.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(withNs.replace("<svg", '<svg width="1920" height="1080"'));
  }),
};
let _c: HTMLCanvasElement | null = null;
function canvas(w: number, h: number) { if (!_c) { _c = document.createElement("canvas"); _c.width = w; _c.height = h; } return _c; }
