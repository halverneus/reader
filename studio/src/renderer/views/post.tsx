import { useEffect, useState } from "preact/hooks";
import { useStore, toast, setState } from "../store";
import { renderBatch, cancelRun, RunStep } from "../runner";

interface Session { dir: string; name: string; started: string; takes: number; hasDesktop: boolean; hasCam: boolean; hasMatte: boolean; hasGlitch: boolean; hasOutro: boolean; hasProject: boolean; hasRender: boolean }
interface StepState { id: string; label: string; state: "idle" | "running" | "done" | "failed"; detail?: string }

export function PostView() {
  const { config } = useStore();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sel, setSel] = useState<Session | null>(null);
  const [steps, setSteps] = useState<StepState[]>([]);
  const [log, setLog] = useState("");
  const [thumbs, setThumbs] = useState<{ dir: string; files: string[]; selected: string | null } | null>(null);
  // The overnight job: tick several sessions and post them one after another.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [batch, setBatch] = useState<RunStep[]>([]);
  const [batching, setBatching] = useState(false);
  const pick = (dir: string) => setPicked((p) => { const n = new Set(p); n.has(dir) ? n.delete(dir) : n.add(dir); return n; });
  const runQueue = async () => {
    const dirs = sessions.filter((s) => picked.has(s.dir)).map((s) => s.dir).reverse();  // oldest first
    if (!dirs.length) return;
    setBatching(true);
    try { await renderBatch(dirs, setBatch); } finally { setBatching(false); refresh(); }
  };
  useEffect(() => { if (sel) window.studio.invoke("post:thumbnails", sel.dir).then(setThumbs).catch(() => setThumbs(null)); }, [sel?.dir]);
  const deleteSession = async () => {
    if (!sel) return;
    try {
      const info = await window.studio.invoke("post:sessionInfo", sel.dir);
      if (!confirm(`Move this recording session to the Trash?\n\n${sel.name}\n${sel.started} · ${info.sizeGB.toFixed(1)} GB (recordings, matte, Glitch, outro, voice)\n\nYou can restore it from the Trash.`)) return;
      let withProject = false;
      if (info.project) withProject = confirm(`Also move its Kdenlive project to the Trash?\n\n${info.project}${info.projectEdited ? "\n\n⚠ This project has been edited in Kdenlive since it was generated." : ""}`);
      const r = await window.studio.invoke("post:deleteSession", sel.dir, withProject);
      toast(`Moved to Trash: ${r.length === 2 ? "session + project" : "session"}`, "ok");
      setSel(null); setSteps([]); setLog(""); refresh();
    } catch (e: any) { toast(e.message, "error"); }
  };
  const chooseThumb = async (file: string) => {
    if (!sel) return;
    await window.studio.invoke("post:setThumbnail", sel.dir, file);
    setThumbs((t) => (t ? { ...t, selected: file } : t));
    toast("Thumbnail saved — press 5 Build Kdenlive to apply", "ok");
  };
  // newest session preselected, so the post buttons are visible without hunting for a row to click
  const refresh = async () => { const s = await window.studio.invoke("post:sessions"); setSessions(s); setSel((cur) => (cur ? s.find((x: Session) => x.dir === cur.dir) ?? null : s[0] ?? null)); };
  useEffect(() => { refresh(); const off1 = window.studio.on("post:step", (st: StepState[]) => setSteps(st)); const off2 = window.studio.on("post:log", (l: string) => setLog((x) => (x + l).slice(-20000))); return () => { off1(); off2(); }; }, []);
  const run = async (what: string) => {
    if (!sel) return; setLog("");
    try { await window.studio.invoke("post:run", sel.dir, what); toast("Done", "ok"); refresh(); } catch (e: any) { toast(e.message, "error"); }
  };
  return (
    <div class="post-view">
      <div class="row"><span class="eyebrow">Sessions in {config?.recordingsRoot}</span><button class="btn sm" onClick={refresh}>Refresh</button></div>
      <div class="panel">
        <table class="takes"><thead><tr><th style="width:26px"></th><th>Session</th><th>Started</th><th>Takes</th><th>Desktop</th><th>Cam</th><th>Matte</th><th>Glitch</th><th>Outro</th><th>Project</th><th>Video</th></tr></thead>
          <tbody>{sessions.map((s) => (
            <tr key={s.dir} onClick={() => setSel(s)} style={{ cursor: "pointer", background: sel?.dir === s.dir ? "var(--panel2)" : "" }}>
              <td onClick={(e: any) => e.stopPropagation()}>
                <input type="checkbox" disabled={batching} checked={picked.has(s.dir)} onChange={() => pick(s.dir)} />
              </td>
              <td>{s.name}{batch.find((b) => b.path === s.dir) ? <span class="muted mono" style="margin-left:8px">{batch.find((b) => b.path === s.dir)!.state}</span> : null}</td>
              <td class="mono">{s.started}</td><td>{s.takes}</td>
              {[s.hasDesktop, s.hasCam, s.hasMatte, s.hasGlitch, s.hasOutro, s.hasProject, s.hasRender].map((b) => <td>{b ? "●" : "○"}</td>)}
            </tr>))}
            {!sessions.length && <tr><td colSpan={11} class="muted">No sessions yet. Record something first.</td></tr>}
          </tbody></table>
      </div>
      {picked.size > 0 && (
        <div class="panel" style="padding:10px 12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <b>{picked.size} session{picked.size === 1 ? "" : "s"} queued</b>
          <span class="muted" style="font-size:12px;max-width:60ch">
            Runs everything on each in turn, oldest first, and carries on past a failure. Hours, not minutes — start it
            and leave.
          </span>
          <span class="sp" style="flex:1" />
          {batch.some((b) => b.error) && <span class="muted mono" style="color:#e74c3c;font-size:12px">{batch.filter((b) => b.error).length} failed</span>}
          <button class="btn" disabled={batching} onClick={() => { setPicked(new Set()); setBatch([]); }}>Clear</button>
          <button class="btn" disabled={!batching} onClick={() => { cancelRun(); toast("Will stop after this session", "info"); }}>Stop after this one</button>
          <button class="btn primary" disabled={batching} onClick={runQueue}>{batching ? "Running…" : `Post all ${picked.size}`}</button>
        </div>
      )}
      {sel && (
        <div class="panel" style="padding:12px">
          <div class="row" style="margin-bottom:10px">
            <b class="mono">{sel.name}</b><span class="sp" />
            <button class="btn" onClick={() => run("align")}>1 Align</button>
            <button class="btn" onClick={() => run("clean")} title="Low cut + RNNoise + soft gate → mic-clean.flac">Clean mic</button>
            <button class="btn" onClick={() => run("matte")}>2 Matte cam</button>
            <button class="btn" onClick={() => run("glitch")}>3 Render Glitch</button>
            <button class="btn" onClick={() => run("outro")}>4 Outro</button>
            <button class="btn" onClick={() => run("project")}>5 Build Kdenlive</button>
            <button class="btn" onClick={() => run("render")} title="Render the Kdenlive project to an MP4 (Settings → Locations → Render folder)">6 Render video</button>
            <button class="btn primary" onClick={() => run("all")}>Run everything</button>
            <label class="row" style="gap:5px;font-size:12px" title="When ticked, Run everything finishes by rendering the video, so you can walk away and check the result later">
              <input type="checkbox" checked={!!config?.post?.autoRender} onChange={async (e: any) => setState({ config: await window.studio.invoke("config:set", { post: { autoRender: e.currentTarget.checked } }) })} /> render video
            </label>
            <button class="btn ghost" onClick={() => window.studio.invoke("shell:openPath", sel.dir)}>Open folder</button>
            <button class="btn danger" onClick={deleteSession} title="Move this recording session (and optionally its Kdenlive project) to the Trash">Delete session…</button>
          </div>
          {thumbs && thumbs.files.length > 0 && (
            <div class="row" style="gap:10px;margin-bottom:10px;align-items:center">
              <span class="muted">Thumbnail</span>
              <select value={thumbs.selected ?? ""} onChange={(e: any) => chooseThumb(e.currentTarget.value)}>
                {thumbs.files.map((f) => <option value={f}>{f.replace(/\s*Video Thumbnail Sized\.png$/i, "").replace(/\.png$/i, "")}</option>)}
              </select>
              {thumbs.selected && <img src={encodeURI(`file://${thumbs.dir}/${thumbs.selected}`)} style="height:54px;border-radius:4px;border:1px solid var(--line)" />}
            </div>
          )}
          <div class="steps">{steps.map((s) => <div class={"step-row " + s.state}><span class="n">{s.state === "done" ? "✓" : s.state === "failed" ? "!" : ""}</span><span>{s.label}</span><span class="muted mono">{s.detail ?? ""}</span></div>)}</div>
          {log && <pre class="log" style="margin-top:10px">{log}</pre>}
        </div>
      )}
    </div>
  );
}
