import { useEffect, useMemo, useState } from "preact/hooks";
import { toast } from "../store";
import { runBatch, cancelRun, abortRun, preflight, watchRun, runActive, RunStep, RunOptions, DEFAULT_OPTIONS } from "../runner";
import { parseScript, cameraPlan } from "../../shared/script";
import { RunPreview } from "../components/run-preview";
import { useProduction } from "../production";

interface ScriptFileInfo { path: string; course: string; week: string; lesson: string; mtime: number }
interface VmInfo { vm: { uri: string; domain: string } | null; state: string; boxes: boolean; agent: boolean }

const fmt = (ms?: number) => (ms == null ? "" : `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}`);
const DOT: Record<string, string> = { pending: "·", prep: "⚙", recording: "●", post: "⏵", done: "✓", failed: "✕", skipped: "–" };

export function RunView() {
  const [all, setAll] = useState<ScriptFileInfo[]>([]);
  const [week, setWeek] = useState<string>("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [eligible, setEligible] = useState<Record<string, string>>({}); // path → "" ok, else why not
  const [opts, setOpts] = useState<RunOptions>(DEFAULT_OPTIONS);
  const [steps, setSteps] = useState<RunStep[]>([]);
  const [running, setRunning] = useState(runActive());
  const [vm, setVm] = useState<VmInfo | null>(null);
  const [blocked, setBlocked] = useState<string[]>([]);
  const [preview, setPreview] = useState(true);
  const prod = useProduction();

  useEffect(() => { window.studio.invoke("scripts:list").then(setAll).catch(() => {}); refreshVm(); }, []);
  // An autorun (started from the command line) drives the same runner, so the
  // tab shows its progress rather than sitting there looking idle.
  useEffect(() => watchRun((s, r) => { setSteps(s); setRunning(r); }), []);
  const refreshVm = () => {
    window.studio.invoke("vm:state").then(setVm).catch(() => setVm(null));
    preflight(opts).then(setBlocked).catch(() => setBlocked([]));
  };
  // Re-check whenever an option that preflight depends on changes.
  useEffect(() => { if (!running) preflight(opts).then(setBlocked).catch(() => setBlocked([])); }, [opts.prep, opts.reboot, running]);

  const weeks = useMemo(() => [...new Set(all.map((s) => `${s.course} / ${s.week}`))].sort(), [all]);
  const lessons = useMemo(
    () => all.filter((s) => `${s.course} / ${s.week}` === week).sort((a, b) => a.lesson.localeCompare(b.lesson)),
    [all, week]);

  // Read each lesson once to say, before anything runs, which can go unattended.
  useEffect(() => {
    let dead = false;
    (async () => {
      const out: Record<string, string> = {};
      for (const l of lessons) {
        try {
          const { script, errors } = parseScript(await window.studio.invoke("scripts:read", l.path));
          out[l.path] = errors.length ? `${errors.length} parse issue(s)`
            : cameraPlan(script).srcs.length === 1 ? "" : "needs Dev on camera";
        } catch (e: any) { out[l.path] = e?.message ?? "unreadable"; }
      }
      if (!dead) {
        setEligible(out);
        setPicked(new Set(lessons.filter((l) => out[l.path] === "").map((l) => l.path)));
      }
    })();
    return () => { dead = true; };
  }, [lessons]);

  const toggle = (p: string) => setPicked((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; });
  const order = lessons.filter((l) => picked.has(l.path)).map((l) => l.path);

  async function start() {
    if (!order.length) { toast("Nothing selected", "error"); return; }
    setRunning(true);
    try { await runBatch(order, opts, setSteps); }
    finally { setRunning(false); refreshVm(); }
  }

  const opt = (k: keyof RunOptions, lbl: string, title: string) => (
    <label class="row" style="gap:5px;font-size:12px" title={title}>
      <input type="checkbox" disabled={running} checked={!!opts[k]} onChange={(e: any) => setOpts({ ...opts, [k]: e.currentTarget.checked })} /> {lbl}
    </label>
  );

  return (
    <div class="pad" style="display:flex;flex-direction:column;gap:14px;overflow:auto">
      <div>
        <h2 style="margin:0 0 4px">Unattended run</h2>
        <p class="muted" style="margin:0;max-width:70ch">
          Records and posts a list of lessons with nobody in the room. Only works for episodes where
          avatar Dev is on from the first marker: those read every line themselves and film the screen
          alone. Anything that needs Dev on camera is listed but cannot be selected.
        </p>
      </div>

      <div class="row" style="gap:10px;align-items:center;flex-wrap:wrap">
        <select disabled={running} value={week} onChange={(e: any) => setWeek(e.currentTarget.value)}>
          <option value="">Pick a week…</option>
          {weeks.map((w) => <option key={w} value={w}>{w}</option>)}
        </select>
        <span style="flex:1" />
        <span class="muted mono" style="font-size:12px">
          VM: {vm?.vm ? `${vm.vm.domain} (${vm.state})` : "none found"}
          {vm?.boxes ? " · Boxes running" : ""}{vm?.agent ? " · guest agent" : " · no guest agent"}
        </span>
        <button class="btn" onClick={refreshVm} disabled={running}>↻</button>
      </div>

      {!!lessons.length && (
        <table class="rows" style="width:100%">
          <tbody>
            {lessons.map((l) => {
              const why = eligible[l.path];
              const st = steps.find((s) => s.path === l.path);
              return (
                <tr key={l.path}>
                  <td style="width:26px">
                    <input type="checkbox" disabled={running || why !== ""} checked={picked.has(l.path)} onChange={() => toggle(l.path)} />
                  </td>
                  <td>{l.lesson}</td>
                  <td class="muted" style="font-size:12px">{why === undefined ? "checking…" : why || "avatar episode"}</td>
                  <td class="mono" style="width:140px">
                    {st ? <>{DOT[st.state] ?? "·"} {st.state}{st.ms ? ` ${fmt(st.ms)}` : ""}</> : ""}
                  </td>
                  <td class="muted" style="font-size:12px;color:#e74c3c">{st?.error ?? ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {preview && (running || prod.marker >= 0) && <RunPreview />}

      <div class="row" style="gap:16px;flex-wrap:wrap;align-items:center">
        <label class="row" style="gap:5px;font-size:12px" title="Glitch and avatar Dev, live, in their real positions. The drivers run during a take either way; this only decides whether you can see them.">
          <input type="checkbox" checked={preview} onChange={(e: any) => setPreview(e.currentTarget.checked)} /> show the avatars while recording
        </label>
        {opt("stage", "load each lesson's deck in the VM", "Before each take: empty the Workbench SQL tab, then open this lesson's own Slides.html fullscreen on slide 1. Without it a batch records the next script over the last lesson's slides")}
        {opt("post", "run post after each", "Build the Kdenlive project (and render, if that is on in Settings) as soon as a take finishes")}
        {opt("reboot", "reboot the VM between lessons", "Clears the Activate Windows watermark. Needs the VM reachable over libvirt")}
        {opt("prep", "prep the VM desktop first", "Blind keystrokes: alt+tab, F11, click the deck, Home. It cannot see the screen, so check the first take")}
      </div>

      {opts.reboot && !vm?.agent && (
        <p class="muted" style="margin:0;font-size:12px;max-width:70ch">
          No guest agent in the VM, so after a reboot there is no way to ask whether the desktop is
          back. The runner will wait {Math.round(opts.settleMs / 1000)}s and carry on regardless. Installing
          qemu-guest-agent in the guest turns that guess into a check.
        </p>
      )}

      {!!blocked.length && !running && (
        <div class="box warn" style="border:1px solid #e74c3c;border-radius:6px;padding:10px 12px">
          <strong style="color:#e74c3c">Cannot start</strong>
          <ul style="margin:6px 0 0;padding-left:18px">
            {blocked.map((b) => <li key={b} style="font-size:13px;line-height:1.5">{b}</li>)}
          </ul>
        </div>
      )}

      <div class="row" style="gap:8px">
        <button class="btn" onClick={refreshVm} disabled={running}>Re-check</button>
        <button class="btn primary" disabled={running || !order.length || blocked.length > 0} onClick={start}>
          {running ? "Running…" : `Run ${order.length} lesson${order.length === 1 ? "" : "s"}`}
        </button>
        <button class="btn" disabled={!running} onClick={() => { cancelRun(); toast("Will stop after this lesson", "info"); }}>
          Stop after this one
        </button>
        <button class="btn" disabled={!running} title="Abandon the take that is running now. The partial recording is kept, so it can be posted or thrown away afterwards."
          onClick={() => { abortRun(); toast("Stopping this take now", "info"); }}>
          Stop now
        </button>
      </div>
    </div>
  );
}
