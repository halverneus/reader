import { useEffect, useRef, useState } from "preact/hooks";
import { useStore } from "../store";

interface SourceInfo { id?: string; name: string; kind: "video" | "audio"; thumb?: string; level?: number; peak?: number; clip?: boolean; frozen?: boolean; status?: string; detail?: string }
interface CaptureStatus { backend?: "gstreamer" | "obs"; connected: boolean; recording: boolean; message?: string; encoder?: string; needsPick?: boolean; sources: SourceInfo[]; kokoro: "down" | "starting" | "ready"; vm: string | null }
interface KeyCfg { enabled: boolean; color: string; similarity: number; smoothness: number; spill: number }
type DevPos = "home" | "left" | "hidden";

export function Sources({ devPos = "home" }: { devPos?: DevPos }) {
  const { config } = useStore();
  const backend: "gstreamer" | "obs" = config?.capture?.backend ?? "gstreamer";
  const [st, setSt] = useState<CaptureStatus>({ connected: false, recording: false, sources: [], kokoro: "down", vm: null });
  useEffect(() => window.studio.on(backend === "obs" ? "obs:status" : "capture:status", (s: CaptureStatus) => setSt(s)), [backend]);
  const thumb = (id: string) => st.sources.find((s) => s.id === id)?.thumb;
  return (
    <div class="sources">
      <div class="row" style="padding:0 2px;flex-wrap:wrap;gap:6px">
        {backend === "obs"
          ? <span class="status"><span class={"led " + (st.connected ? "ok" : "bad")} />OBS {st.connected ? "connected" : "offline"}</span>
          : <span class="status" title={st.encoder ? `encoder: ${st.encoder}` : ""}><span class={"led " + (st.connected ? "ok" : "bad")} />Capture {st.connected ? "ready" : "offline"}</span>}
        <span class="status"><span class={"led " + (st.kokoro === "ready" ? "ok" : st.kokoro === "starting" ? "warn" : "bad")} />Kokoro</span>
        <span class="status"><span class={"led " + (st.vm ? "ok" : "warn")} />VM {st.vm ?? "none"}</span>
        <span style="flex:1" />
        {backend === "obs" ? <>
          {!st.connected && <button class="btn sm" onClick={() => window.studio.invoke("obs:connect")}>Connect</button>}
          {st.connected && <button class="btn sm" onClick={() => window.studio.invoke("obs:setup")} title="Create the Metrik scene and sources in OBS">Setup scene</button>}
        </> : <>
          <button class={"btn sm" + (st.needsPick ? " primary" : "")} disabled={st.recording} onClick={() => window.studio.invoke("capture:pick")} title="Choose the VM window to record (remembered for next time)">Pick window</button>
          <button class="btn sm" onClick={() => window.studio.invoke("capture:resetCamera")} title="Re-open the camera">Reset cam</button>
          {!st.connected && <button class="btn sm" onClick={() => window.studio.invoke("capture:restart")}>Restart</button>}
        </>}
      </div>
      {st.message && <div class="muted" style="font-size:12px;padding:0 2px">{st.message}</div>}
      {backend !== "obs" && (thumb("desktop") || thumb("cam")) && <KeyedMonitor desk={thumb("desktop")} cam={thumb("cam")} keyCfg={config?.capture?.key} rect={config?.dev?.rect} leftX={config?.dev?.leftX ?? 0} devPos={devPos} />}
      {st.sources.map((s) => (
        <div class="src" key={s.id ?? s.name}>
          <div class="thumb">{s.kind === "video" ? (s.thumb ? <img src={s.thumb} /> : "no signal") : <Meter level={s.level ?? 0} peak={s.peak ?? 0} />}{s.frozen && <div class="frozen">FROZEN</div>}</div>
          <div class="info">
            <b>{s.name}{s.clip && <span class="chip" style="margin-left:6px;border-color:var(--rose);color:var(--rose);font-size:10px">CLIP</span>}</b>
            <span class="muted" style={s.status === "error" ? "color:var(--rose)" : ""}>{s.detail || (s.kind === "video" ? "video" : "audio")}</span>
            {s.kind === "audio" && <div class="meter"><div class="fill" style={{ transform: `scaleX(${s.level ?? 0})` }} /><div class="peak" style={{ left: `${(s.peak ?? 0) * 100}%` }} /></div>}
          </div>
        </div>
      ))}
    </div>
  );
}

function Meter({ level, peak }: { level: number; peak: number }) {
  const bars = 12;
  return <div style="display:flex;gap:2px;align-items:flex-end;height:60%;width:80%">{Array.from({ length: bars }, (_, i) => <div style={{ flex: 1, height: `${(i + 1) / bars * 100}%`, background: i / bars < level ? (i > bars * .85 ? "var(--rose)" : i > bars * .7 ? "var(--amber)" : "var(--green)") : "#1e2230", opacity: i / bars < peak ? 1 : .7 }} />)}</div>;
}

/** What the edit will look like: the VM window with the camera keyed over Dev's corner. Preview only — the recording
 *  keeps the raw camera so the key (or the RVM matte) can be redone in post. */
function KeyedMonitor({ desk, cam, keyCfg, rect, leftX, devPos }: { desk?: string; cam?: string; keyCfg?: KeyCfg; rect?: { x: number; y: number; w: number; h: number }; leftX: number; devPos: DevPos }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const work = useRef<{ desk: HTMLImageElement; cam: HTMLImageElement; buf: HTMLCanvasElement } | null>(null);
  const [keyed, setKeyed] = useState(true);
  useEffect(() => {
    const cv = ref.current; if (!cv) return;
    const w = work.current ?? (work.current = { desk: new Image(), cam: new Image(), buf: document.createElement("canvas") });
    let cancelled = false;
    const load = (img: HTMLImageElement, src?: string) => new Promise<boolean>((res) => {
      if (!src) return res(false);
      if (img.src === src && img.complete) return res(true);
      img.onload = () => res(true); img.onerror = () => res(false); img.src = src;
    });
    Promise.all([load(w.desk, desk), load(w.cam, cam)]).then(([hasDesk, hasCam]) => {
      if (cancelled) return;
      const g = cv.getContext("2d")!; const W = cv.width, H = cv.height;
      g.fillStyle = "#0b0d14"; g.fillRect(0, 0, W, H);
      if (hasDesk) g.drawImage(w.desk, 0, 0, W, H);
      if (!hasCam || devPos === "hidden" || !rect) return;
      const b = w.buf; b.width = w.cam.naturalWidth; b.height = w.cam.naturalHeight;
      const bg = b.getContext("2d", { willReadFrequently: true })!;
      bg.drawImage(w.cam, 0, 0);
      if (keyed && keyCfg && keyCfg.enabled !== false) { const px = bg.getImageData(0, 0, b.width, b.height); chromaKey(px.data, keyCfg); bg.putImageData(px, 0, 0); }
      const s = W / 1920;
      g.drawImage(b, (devPos === "left" ? leftX : rect.x) * s, rect.y * s, rect.w * s, rect.h * s);
    });
    return () => { cancelled = true; };
  }, [desk, cam, keyed, keyCfg?.enabled, keyCfg?.color, keyCfg?.similarity, keyCfg?.smoothness, keyCfg?.spill, devPos, rect?.x, rect?.y, rect?.w, rect?.h, leftX]);
  return (
    <div style="position:relative">
      <canvas ref={ref} width={480} height={270} style="width:100%;aspect-ratio:16/9;border-radius:6px;display:block;background:#0b0d14;border:1px solid var(--line)" />
      <label class="row" style="position:absolute;top:4px;right:6px;gap:4px;font-size:11px;background:rgba(11,13,20,.7);padding:1px 6px;border-radius:4px" title="Green-screen key on the preview (Settings → Capture)">
        <input type="checkbox" checked={keyed} onChange={(e: any) => setKeyed(e.currentTarget.checked)} /> key
      </label>
    </div>
  );
}

/** OBS-style chroma key on RGBA pixels: distance from the key colour in CbCr → alpha (smoothstep), then green spill
 *  pulled back toward the other channels. similarity/smoothness use OBS's scale divided by 1000. */
export function chromaKey(d: Uint8ClampedArray, k: KeyCfg) {
  const hex = parseInt(k.color.replace("#", ""), 16);
  const kr = ((hex >> 16) & 255) / 255, kg = ((hex >> 8) & 255) / 255, kb = (hex & 255) / 255;
  const kcb = -0.1146 * kr - 0.3854 * kg + 0.5 * kb, kcr = 0.5 * kr - 0.4542 * kg - 0.0458 * kb;
  const sim = k.similarity, smooth = Math.max(1e-3, k.smoothness), spill = k.spill ?? 0.5;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
    const cb = -0.1146 * r - 0.3854 * g + 0.5 * b, cr = 0.5 * r - 0.4542 * g - 0.0458 * b;
    let a = (Math.hypot(cb - kcb, cr - kcr) - sim) / smooth;
    a = a <= 0 ? 0 : a >= 1 ? 1 : a * a * (3 - 2 * a);
    d[i + 3] = a * 255;
    const m = Math.max(r, b);
    if (a > 0 && g > m) d[i + 1] = (m + (g - m) * (1 - spill)) * 255;
  }
}
