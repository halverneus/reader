import { useEffect, useMemo, useState } from "preact/hooks";
import { toast } from "../store";

/** Everything the voice service has rendered, and the controls to curate it.
 *
 *  The audio itself lives as files in the cache directory and the service
 *  owns them; this screen only ever talks to its HTTP API. That is what keeps
 *  a single-writer index out of a tug of war between Electron and Python.
 *
 *  The one thing worth doing here that cannot be done anywhere else is
 *  recording an override: a line the model keeps getting wrong gets performed
 *  by hand once, and from then on that take is what plays. */
interface Clip { key: string; text: string; actor?: string; lesson?: string; bytes: number; seconds: number; source: string; created: number }
interface Stats { clips: number; bytes: number; recorded: number; lessons: { lesson: string; clips: number; bytes: number }[] }

const mb = (n: number) => (n / 1048576).toFixed(1) + " MB";

export function VoiceView() {
  const [clips, setClips] = useState<Clip[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [lesson, setLesson] = useState("");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [rec, setRec] = useState<{ key: string; chunks: Blob[]; mr: MediaRecorder } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const [a, b] = await Promise.all([
      window.studio.invoke("devvoice:list", { lesson, search: q }).catch(() => null),
      window.studio.invoke("devvoice:stats").catch(() => null),
    ]);
    setClips((a as any)?.clips ?? []); setStats(b as any);
  };
  useEffect(() => { refresh(); }, [lesson, q]);

  const play = async (k: string) => {
    const b64: any = await window.studio.invoke("devvoice:clip", k).catch(() => null);
    if (b64) new Audio("data:audio/wav;base64," + b64).play().catch(() => {});
  };

  const remove = async () => {
    if (!sel.size) return;
    setBusy(true);
    try {
      await window.studio.invoke("devvoice:delete", [...sel]);
      toast(`Deleted ${sel.size} clip(s)`, "info"); setSel(new Set()); refresh();
    } finally { setBusy(false); }
  };

  // ── recording an override ────────────────────────────────────────────────
  // Captured as WebM from the browser, then handed to the main process to be
  // decoded to a RIFF wav, because the service stores and serves wavs and the
  // renderer has no encoder of its own.
  const startRec = async (c: Clip) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false } });
      const mr = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      mr.ondataavailable = (e) => chunks.push(e.data);
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const buf = new Uint8Array(await new Blob(chunks).arrayBuffer());
        const r: any = await window.studio.invoke("devvoice:override", { text: c.text, webm: Array.from(buf) });
        if (r?.ok) { toast("Override saved — this take now plays instead", "info"); refresh(); }
        else toast(`Override failed: ${r?.error ?? "unknown"}`, "error");
      };
      mr.start(); setRec({ key: c.key, chunks, mr });
    } catch (e: any) { toast(`Microphone: ${e.message}`, "error"); }
  };
  const stopRec = () => { rec?.mr.stop(); setRec(null); };

  const clearOverride = async (c: Clip) => {
    await window.studio.invoke("devvoice:unoverride", c.text);
    toast("Back to the generated take", "info"); refresh();
  };

  const lessons = useMemo(() => stats?.lessons ?? [], [stats]);

  return (
    <div class="pane" style="padding:14px;overflow:auto">
      <div class="toolbar" style="margin-bottom:10px">
        <strong style="font-size:14px">Voice library</strong>
        <span style="flex:1" />
        {stats && <span class="muted mono" style="font-size:12px">{stats.clips} clips · {mb(stats.bytes)}{stats.recorded ? ` · ${stats.recorded} recorded` : ""}</span>}
        <button class="btn sm" onClick={refresh}>Refresh</button>
        <button class="btn sm" disabled={!sel.size || busy} onClick={remove}>Delete {sel.size || ""}</button>
      </div>

      <div class="toolbar" style="margin-bottom:10px">
        <select value={lesson} onChange={(e: any) => setLesson(e.currentTarget.value)}>
          <option value="">every lesson</option>
          {lessons.map((l) => <option value={l.lesson === "(unfiled)" ? "" : l.lesson}>{l.lesson} ({l.clips})</option>)}
        </select>
        <input placeholder="search the words…" value={q} onInput={(e: any) => setQ(e.currentTarget.value)} style="flex:1;min-width:0" />
      </div>

      {!stats && <p class="muted">The voice service is not answering. It starts with the app; check the Settings tab.</p>}

      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <tbody>
          {clips.map((c) => (
            <tr key={c.key} style="border-bottom:1px solid var(--line,#2a3140)">
              <td style="width:22px;padding:5px 4px">
                <input type="checkbox" checked={sel.has(c.key)} onChange={(e: any) => {
                  const n = new Set(sel); e.currentTarget.checked ? n.add(c.key) : n.delete(c.key); setSel(n);
                }} />
              </td>
              <td style="padding:5px 6px">
                <div>{c.text || <span class="muted">(adopted from disk, text unknown)</span>}</div>
                <div class="muted mono" style="font-size:10px">
                  {c.lesson ?? "unfiled"}{c.actor ? " · " + c.actor : ""} · {c.seconds}s · {Math.round(c.bytes / 1024)} KB
                  {c.source === "recorded" && <span style="color:var(--amber,#ffb44a)"> · recorded</span>}
                </div>
              </td>
              <td style="width:220px;padding:5px 4px;text-align:right;white-space:nowrap">
                <button class="btn sm" onClick={() => play(c.key)}>▶</button>{" "}
                {rec?.key === c.key
                  ? <button class="btn sm primary" onClick={stopRec}>■ stop</button>
                  : <button class="btn sm" disabled={!c.text || !!rec} title="Perform this line yourself; your take then always plays" onClick={() => startRec(c)}>record</button>}
                {" "}
                {c.source === "recorded" && <button class="btn sm" onClick={() => clearOverride(c)} title="Throw the recording away and go back to the generated take">undo</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!clips.length && stats && <p class="muted" style="margin-top:12px">Nothing matches.</p>}
    </div>
  );
}
