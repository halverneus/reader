// Standalone Glitch page: used by the offline renderer (deterministic stepping) and as an OBS browser source if wanted.
import { Vex, GlitchDriver } from "../../glitch/vex";
const svg = document.getElementById("glitch") as unknown as SVGSVGElement;
const q = new URLSearchParams(location.search);
const vex = new Vex(svg, { size: parseFloat(q.get("size") ?? "1") });
const driver = new GlitchDriver(parseInt(q.get("seed") ?? "7"));
if (q.get("y")) driver.slide(parseFloat(q.get("y")!), 1);
let manual = q.get("manual") === "1"; // offline renderer steps frames itself
let last = performance.now();
function loop(now: number) { if (!manual) { vex.update(driver.tick(Math.min(.05, (now - last) / 1000)), performance.now() / 1000); } last = now; requestAnimationFrame(loop); }
requestAnimationFrame(loop);
(window as any).glitch = {
  driver, vex,
  mood: (m: string, hold?: number) => driver.setMood(m, hold),
  talk: (v: boolean) => driver.setTalking(v),
  slide: (to: any, over?: number) => driver.slide(to, over),
  /** Offline: advance exactly one frame at fps. */
  step: (fps = 60, frame = 0) => { manual = true; vex.update(driver.tick(1 / fps), frame / fps); },
  /** Offline: rasterise the current SVG to a PNG data URL (deterministic, no GPU capture needed). */
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
// Live control over WebSocket (the app's local hub) if a port is given.
const port = q.get("ws");
if (port) {
  const connect = () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/glitch`);
    ws.onmessage = (ev) => { try { const m = JSON.parse(ev.data); if (m.mood) driver.setMood(m.mood, m.hold); if (m.talk != null) driver.setTalking(!!m.talk); if (m.slide) driver.slide(m.slide, m.over); } catch {} };
    ws.onclose = () => setTimeout(connect, 1000);
  };
  connect();
}
