import { useEffect, useState } from "preact/hooks";
import { useStore, toast } from "../store";

interface Session { dir: string; name: string; started: string; takes: number; hasDesktop: boolean; hasCam: boolean; hasMatte: boolean; hasGlitch: boolean; hasOutro: boolean; hasProject: boolean }
interface StepState { id: string; label: string; state: "idle" | "running" | "done" | "failed"; detail?: string }

export function PostView() {
  const { config } = useStore();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sel, setSel] = useState<Session | null>(null);
  const [steps, setSteps] = useState<StepState[]>([]);
  const [log, setLog] = useState("");
  const refresh = async () => { const s = await window.studio.invoke("post:sessions"); setSessions(s); if (sel) setSel(s.find((x: Session) => x.dir === sel.dir) ?? null); };
  useEffect(() => { refresh(); const off1 = window.studio.on("post:step", (st: StepState[]) => setSteps(st)); const off2 = window.studio.on("post:log", (l: string) => setLog((x) => (x + l).slice(-20000))); return () => { off1(); off2(); }; }, []);
  const run = async (what: string) => {
    if (!sel) return; setLog("");
    try { await window.studio.invoke("post:run", sel.dir, what); toast("Done", "ok"); refresh(); } catch (e: any) { toast(e.message, "error"); }
  };
  return (
    <div class="post-view">
      <div class="row"><span class="eyebrow">Sessions in {config?.recordingsRoot}</span><button class="btn sm" onClick={refresh}>Refresh</button></div>
      <div class="panel">
        <table class="takes"><thead><tr><th>Session</th><th>Started</th><th>Takes</th><th>Desktop</th><th>Cam</th><th>Matte</th><th>Glitch</th><th>Outro</th><th>Project</th></tr></thead>
          <tbody>{sessions.map((s) => (
            <tr key={s.dir} onClick={() => setSel(s)} style={{ cursor: "pointer", background: sel?.dir === s.dir ? "var(--panel2)" : "" }}>
              <td>{s.name}</td><td class="mono">{s.started}</td><td>{s.takes}</td>
              {[s.hasDesktop, s.hasCam, s.hasMatte, s.hasGlitch, s.hasOutro, s.hasProject].map((b) => <td>{b ? "●" : "○"}</td>)}
            </tr>))}
            {!sessions.length && <tr><td colSpan={9} class="muted">No sessions yet. Record something first.</td></tr>}
          </tbody></table>
      </div>
      {sel && (
        <div class="panel" style="padding:12px">
          <div class="row" style="margin-bottom:10px">
            <b class="mono">{sel.name}</b><span class="sp" />
            <button class="btn" onClick={() => run("align")}>1 Align</button>
            <button class="btn" onClick={() => run("matte")}>2 Matte cam</button>
            <button class="btn" onClick={() => run("glitch")}>3 Render Glitch</button>
            <button class="btn" onClick={() => run("outro")}>4 Outro</button>
            <button class="btn" onClick={() => run("project")}>5 Build Kdenlive</button>
            <button class="btn primary" onClick={() => run("all")}>Run everything</button>
            <button class="btn ghost" onClick={() => window.studio.invoke("shell:openPath", sel.dir)}>Open folder</button>
          </div>
          <div class="steps">{steps.map((s) => <div class={"step-row " + s.state}><span class="n">{s.state === "done" ? "✓" : s.state === "failed" ? "!" : ""}</span><span>{s.label}</span><span class="muted mono">{s.detail ?? ""}</span></div>)}</div>
          {log && <pre class="log" style="margin-top:10px">{log}</pre>}
        </div>
      )}
    </div>
  );
}
