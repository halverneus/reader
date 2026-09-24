import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { yaml } from "@codemirror/lang-yaml";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { useStore, toast } from "../store";
import { loadScriptFile, saveScript, setScriptText, updateScript, createScript } from "../script-io";
import { Entry, markers, entriesAt, markerBetween, newId, validate, STEP_HELP, outroPhases, OUTRO_PHASES, cleanText } from "../../shared/script";
import { MOOD_NAMES } from "../../../glitch/moods";
import type { ScriptFileInfo } from "../../shared/ipc";
import { Assist } from "../components/assist";

export function ScriptView() {
  const s = useStore();
  const [mode, setMode] = useState<"slots" | "yaml">("slots");
  const [files, setFiles] = useState<ScriptFileInfo[]>([]);
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState(false);
  const refreshFiles = () => window.studio.invoke("scripts:list").then(setFiles);
  useEffect(() => { refreshFiles(); }, [s.config?.scriptsRoot, s.scriptPath]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); saveScript(); } };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, []);
  const byCourse = useMemo(() => {
    const m = new Map<string, ScriptFileInfo[]>();
    for (const f of files) if (!filter || (f.course + f.week + f.lesson).toLowerCase().includes(filter.toLowerCase())) (m.get(f.course) ?? m.set(f.course, []).get(f.course)!).push(f);
    return m;
  }, [files, filter]);
  const issues = useMemo(() => validate(s.script), [s.script]);
  return (
    <div class="script-view">
      <div class="files">
        <div class="row" style="padding:8px 10px;border-bottom:1px solid var(--line)">
          <input style="flex:1;background:#0d0f17;border:1px solid var(--line);border-radius:6px;padding:4px 8px" placeholder="filter…" value={filter} onInput={(e: any) => setFilter(e.currentTarget.value)} />
          <button class="btn sm primary" title="New script from the standard template" onClick={() => setCreating(true)}>+ New</button>
          <button class="btn sm" title="Open any Script.yml" onClick={async () => { const p = await window.studio.invoke("dialog:openFile", { filters: [{ name: "Script", extensions: ["yml", "yaml"] }] }); if (p) loadScriptFile(p); }}>…</button>
        </div>
        {creating && <NewScript onDone={() => { setCreating(false); refreshFiles(); }} />}
        <div class="list">
          {[...byCourse.entries()].map(([course, fs]) => (<div key={course}><div class="course">{course.split(" - ")[0]}</div>
            {fs.map((f) => <button key={f.path} class={"item" + (f.path === s.scriptPath ? " active" : "")} title={f.path} onClick={() => loadScriptFile(f.path)}><small>{f.week.replace("Week ", "W")}</small>{f.lesson}</button>)}</div>))}
          {!files.length && <div class="muted" style="padding:12px">No scripts found under the courses root. Set it in Settings.</div>}
        </div>
      </div>
      <div class="slots">
        <div class="toolbar">
          <button class={"btn sm" + (mode === "slots" ? " primary" : "")} onClick={() => setMode("slots")}>Slots</button>
          <button class={"btn sm" + (mode === "yaml" ? " primary" : "")} onClick={() => setMode("yaml")}>YAML</button>
          <span style="flex:1" />
          <span class="muted mono" style="font-size:12px">{s.script.entries.length} entries · {markers(s.script).length} markers{issues.length ? ` · ${issues.length} issues` : ""}</span>
          <button class="btn sm" onClick={() => updateScript((sc) => { const m = markers(sc); const start = m.length ? m[m.length - 1] + 100 : 100; sc.entries.push({ id: newId(), type: "line", actor: "Dev", start, end: start + 100, text: "" }); })}>+ marker</button>
          <button class="btn sm primary" disabled={!s.dirty} onClick={() => saveScript()}>Save <kbd>⌃S</kbd></button>
        </div>
        {mode === "slots" ? <SlotEditor /> : <YamlEditor />}
        {(s.errors.length > 0 || issues.length > 0) && <div class="issues">{s.errors.map((e) => <div>⚠ {e}</div>)}{issues.slice(0, 20).map((i) => <div>• {i.msg}</div>)}</div>}
      </div>
      <Assist />
    </div>
  );
}

function NewScript({ onDone }: { onDone: () => void }) {
  const [courses, setCourses] = useState<{ course: string; weeks: string[] }[]>([]);
  const [course, setCourse] = useState(""); const [week, setWeek] = useState(""); const [lesson, setLesson] = useState("");
  useEffect(() => { window.studio.invoke("scripts:courses").then((c: any) => { setCourses(c); if (c[0]) { setCourse(c[0].course); setWeek(c[0].weeks.at(-1) ?? "Week 01"); } }); }, []);
  const weeks = courses.find((c) => c.course === course)?.weeks ?? [];
  const nextLesson = () => { const n = files_for(course, week).length + 1; return `${String(n).padStart(2, "0")} - `; };
  const files_for = (_c: string, _w: string) => [] as string[];
  const submit = async () => { if (await createScript(course, week, lesson.trim())) onDone(); };
  return (
    <div style="padding:10px 12px;border-bottom:1px solid var(--line);display:flex;flex-direction:column;gap:6px;background:var(--panel)">
      <span class="eyebrow">New script</span>
      <div class="field"><label>Course</label><select value={course} onChange={(e: any) => { setCourse(e.currentTarget.value); setWeek(courses.find((c) => c.course === e.currentTarget.value)?.weeks.at(-1) ?? ""); }}>{courses.map((c) => <option value={c.course}>{c.course}</option>)}</select></div>
      <div class="field"><label>Week (folder)</label><input list="weeks" value={week} onInput={(e: any) => setWeek(e.currentTarget.value)} placeholder="Week 01" /><datalist id="weeks">{weeks.map((w) => <option value={w} />)}</datalist></div>
      <div class="field"><label>Lesson (folder)</label><input value={lesson} placeholder={nextLesson() + "Topic"} onInput={(e: any) => setLesson(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === "Enter") submit(); }} /></div>
      <div class="row"><button class="btn sm primary" disabled={!course || !week || !lesson.trim()} onClick={submit}>Create</button><button class="btn sm ghost" onClick={onDone}>Cancel</button></div>
      <span class="muted" style="font-size:11px">Creates …/{course || "Course"}/Course/{week || "Week"}/{lesson || "NN - Topic"}/Script.yml from the standard opening + closing template.</span>
    </div>
  );
}

function SlotEditor() {
  const s = useStore();
  const ms = markers(s.script);
  return (
    <div class="body">
      {ms.map((m) => <Slot key={m} marker={m} entries={entriesAt(s.script, m)} />)}
      {!ms.length && <div class="muted" style="padding:20px">Empty script. Add a marker, or ask the assistant to draft one.</div>}
    </div>
  );
}

function Slot({ marker, entries }: { marker: number; entries: Entry[] }) {
  const has = (t: string) => entries.some((e) => e.type === t);
  const add = (type: Entry["type"]) => updateScript((sc) => {
    const end = entries[0]?.end ?? marker + 100; const base = { id: newId(), start: marker, end };
    const e: Entry = type === "line" ? { ...base, type, actor: has("line") ? "Glitch" : "Dev", text: "" } : type === "editor" ? { ...base, type, text: "" } : type === "keys" ? { ...base, type, keystrokes: [] } : type === "face" ? { ...base, type, mood: "curious" } : type === "outro" ? { ...base, type: "outro", next: "", thanks: [] } : { ...base, type: "slide", actor: "Dev", to: "left" };
    sc.entries.push(e);
  });
  const insertAfter = () => updateScript((sc) => { const m = markerBetween(sc, marker); sc.entries.push({ id: newId(), type: "line", actor: "Dev", start: m, end: entries[0]?.end ?? m + 100, text: "" }); });
  return (
    <div class="slot">
      <div class="marker"><span>{marker}</span>
        <button onClick={() => add("line")} title="add dialogue">+line</button><button onClick={() => add("editor")} title="add editor note">+note</button><button onClick={() => add("keys")} title="add keys">+keys</button><button onClick={() => add("face")} title="add Glitch expression">+face</button><button onClick={() => add("slide")} title="add slide">+slide</button><button onClick={() => add("outro")} title="add the branded outro (last marker)">+outro</button>
        <button onClick={insertAfter} title="insert a marker after this one">↓ ins</button>
      </div>
      <div class="cells">{entries.map((e) => <Cell key={e.id} e={e} />)}</div>
    </div>
  );
}

function Cell({ e }: { e: Entry }) {
  const patch = (p: Partial<Entry>) => updateScript((sc) => { const i = sc.entries.findIndex((x) => x.id === e.id); if (i >= 0) sc.entries[i] = { ...sc.entries[i], ...p } as Entry; });
  const remove = () => updateScript((sc) => { sc.entries = sc.entries.filter((x) => x.id !== e.id); });
  const chip = e.type === "line" ? e.actor : e.type;
  const keysRef = useRef<HTMLTextAreaElement>(null);
  return (
    <div class="cell">
      <div class="who">
        <span class={"chip " + chip}>{chip}</span>
        <label class="muted" style="font-size:11px"><input type="checkbox" checked={!!e.auto} onChange={(ev: any) => patch({ auto: ev.currentTarget.checked || undefined })} /> auto</label>
        <span class="muted mono" style="font-size:10px">→{e.end}</span>
      </div>
      <div>
        {e.type === "line" && <>
          <textarea value={e.text} rows={Math.max(1, e.text.split("\n").length)} onInput={(ev: any) => patch({ text: ev.currentTarget.value } as any)} placeholder="Dialogue. Inline cues like [curious] change Glitch's face mid-line." />
          <div class="meta">
            {e.actor === "Glitch" && <SayButton text={e.text} actor="Glitch" />}
            <select value={e.actor} onChange={(ev: any) => patch({ actor: ev.currentTarget.value } as any)}><option>Dev</option><option>Glitch</option></select>
            <select value={e.mood ?? ""} onChange={(ev: any) => patch({ mood: ev.currentTarget.value || undefined } as any)}><option value="">mood: (keep)</option>{MOOD_NAMES.map((m) => <option value={m}>{m}</option>)}</select>
            {e.text.split("\n").some((l) => l.length > 70) && <span class="mono" style="color:var(--rose);font-size:11px">line &gt; 70 chars</span>}
          </div></>}
        {e.type === "editor" && <textarea value={e.text} rows={Math.max(1, e.text.split("\n").length)} onInput={(ev: any) => patch({ text: ev.currentTarget.value } as any)} placeholder="Notes for the editor (never spoken)" />}
        {e.type === "keys" && <>
          <textarea ref={keysRef} class="mono" value={e.keystrokes.join("\n")} rows={Math.max(2, e.keystrokes.length)} onInput={(ev: any) => patch({ keystrokes: ev.currentTarget.value.split("\n") } as any)} placeholder={STEP_HELP} title={STEP_HELP} />
          <div class="meta"><SendKeysButton e={e} area={keysRef} /><span class="muted" style="font-size:11px">speed</span><input type="number" min={1} max={10} style="width:56px" value={e.speed ?? 10} onChange={(ev: any) => patch({ speed: +ev.currentTarget.value } as any)} /><span class="muted" style="font-size:11px">one step per line · k: t: p: w: m:</span></div></>}
        {e.type === "face" && <div class="meta">
          <select value={e.mood} onChange={(ev: any) => patch({ mood: ev.currentTarget.value } as any)}>{MOOD_NAMES.map((m) => <option value={m}>{m}</option>)}</select>
          <span class="muted" style="font-size:11px" title="wait this long after the marker before the face changes">delay ms</span><input type="number" min={0} step={100} style="width:80px" value={e.delay ?? 0} onChange={(ev: any) => patch({ delay: +ev.currentTarget.value || undefined } as any)} />
          <span class="muted" style="font-size:11px" title="hold the face this long, then go back to the previous one">hold ms</span><input type="number" min={0} step={100} style="width:80px" value={e.hold ?? 0} onChange={(ev: any) => patch({ hold: +ev.currentTarget.value || undefined } as any)} /></div>}
        {e.type === "outro" && <OutroCell e={e} patch={patch} />}
        {e.type === "slide" && <div class="meta">
          <select value={e.actor} onChange={(ev: any) => patch({ actor: ev.currentTarget.value } as any)}><option>Dev</option><option>Glitch</option></select>
          <select value={e.to} onChange={(ev: any) => patch({ to: ev.currentTarget.value } as any)}>{["left", "right", "top", "bottom", "hide", "show"].map((t) => <option value={t}>{t}</option>)}</select>
          <span class="muted" style="font-size:11px">over ms</span><input type="number" style="width:80px" value={e.over ?? 600} onChange={(ev: any) => patch({ over: +ev.currentTarget.value } as any)} /></div>}
      </div>
      <button class="x" title="remove" onClick={remove}>×</button>
    </div>
  );
}

// one keys run at a time (the VM has one keyboard)
let keysStop: (() => void) | null = null;

/** Send a keys block to the VM now, exactly as a recording would (same steps, speed and timing), to check it
 *  before the take. Shows the step being sent, so a wrong one is easy to spot. Shift-click sends only the line
 *  the cursor is on. Click again to stop. */
function SendKeysButton({ e, area }: { e: Entry & { type: "keys" }; area: { current: HTMLTextAreaElement | null } }) {
  const [st, setSt] = useState<{ step: number; of: number; only?: number } | null>(null);
  const token = useRef(0);
  const runId = useRef("");
  useEffect(() => window.studio.on("keys:progress", ({ entryId, step }: any) => {
    if (entryId === runId.current) setSt((cur) => (cur ? { ...cur, step } : cur));
  }), []);
  const stop = () => { token.current++; window.studio.invoke("keys:cancel"); runId.current = ""; keysStop = null; setSt(null); };
  useEffect(() => () => { if (keysStop === stop) stop(); }, []);
  const click = async (ev: MouseEvent) => {
    if (st) return stop();
    keysStop?.(); // stop any other block that is still typing
    let steps = e.keystrokes, only: number | undefined;
    if (ev.shiftKey && area.current) {
      only = area.current.value.slice(0, area.current.selectionStart ?? 0).split("\n").length - 1;
      steps = [e.keystrokes[only] ?? ""];
    }
    if (!steps.some((x) => x.trim())) { toast("Nothing to send on that line", "info"); return; }
    const my = ++token.current; keysStop = stop;
    runId.current = `preview:${e.id}:${my}`;
    setSt({ step: 0, of: steps.length, only });
    try { await window.studio.invoke("keys:run", { entryId: runId.current, steps, speed: e.speed ?? 10, dryRun: false }); }
    catch (err: any) {
      if (token.current !== my) return;
      const msg = String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
      toast(/No running VM/.test(msg) ? "No running VM — start it in Boxes, then try again" : `Keys: ${msg}`, "error");
    }
    if (token.current === my) { runId.current = ""; keysStop = null; setSt(null); }
  };
  const line = st ? (st.only ?? st.step) : -1;
  const now = st && st.step < st.of ? (e.keystrokes[line] ?? "").trim() : "";
  const color = st ? "var(--teal)" : "currentColor";
  return (
    <>
      <button class="btn sm" disabled={!e.keystrokes.some((x) => x.trim())} onClick={click as any} style="padding:2px 6px;display:inline-flex;align-items:center"
        title={st ? "Stop" : "Send these keys to the VM now (shift-click: only the line the cursor is on)"}>
        <svg width="22" height="14" viewBox="0 0 34 20" fill="none" stroke={color} stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2" y="3" width="22" height="14" rx="2.5" />
          <path d="M6 7.5h2M11 7.5h2M16 7.5h2M6 12.5h12" opacity={st ? 1 : 0.7} />
          <path d="M27 6l4 4-4 4" opacity={st ? 1 : 0.55} />
        </svg>
      </button>
      {st && <span class="mono" style="font-size:11px;color:var(--teal);max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title={now}>
        {st.only != null ? `line ${st.only + 1}` : `${Math.min(st.step + 1, st.of)}/${st.of}`}{now ? ` · ${now}` : ""}</span>}
    </>
  );
}

// one preview at a time across the whole script
let previewAudio: HTMLAudioElement | null = null;
let previewStop: (() => void) | null = null;

/** Hear a line the way it will be spoken while recording: same voice, same [mood]-tag clean-up and [pause]s. Nothing is saved. */
function SayButton({ text, actor }: { text: string; actor: string }) {
  const { config } = useStore();
  const [st, setSt] = useState<"idle" | "loading" | "playing">("idle");
  const token = useRef(0);
  const clean = cleanText(text ?? "");
  const stop = () => { token.current++; previewAudio?.pause(); previewAudio = null; previewStop = null; setSt("idle"); };
  useEffect(() => () => { if (previewStop === stop) stop(); }, []);
  const click = async () => {
    if (st !== "idle") return stop();
    previewStop?.(); // silence any other line that's playing
    const my = ++token.current; previewStop = stop; setSt("loading");
    try {
      const r = await window.studio.invoke("tts:speak", { text, voice: config?.voices?.[actor] ?? "am_puck", name: "preview", save: false });
      if (token.current !== my) return;
      const a = new Audio("data:audio/wav;base64," + r.audio);
      previewAudio = a; a.onended = () => { if (token.current === my) stop(); };
      await a.play(); setSt("playing");
    } catch (err: any) { if (token.current === my) { stop(); toast(`Kokoro: ${err.message}`, "error"); } }
  };
  const color = st === "playing" ? "var(--teal)" : st === "loading" ? "var(--amber)" : "currentColor";
  return (
    <button class="btn sm" disabled={!clean} onClick={click} style="padding:2px 6px;display:inline-flex;align-items:center"
      title={st === "idle" ? `Hear how ${actor} says this line` : "Stop"}>
      <svg width="22" height="14" viewBox="0 0 34 20" fill="none" stroke={color} stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style={st === "loading" ? "opacity:.6" : ""}>
        <path d="M2 10 C5 4 10 3 12 5.5 C14 3 19 4 22 10 C19 16 5 16 2 10 Z" />
        <path d="M5.5 10 C9 11.8 15 11.8 18.5 10" />
        <path d="M26 6 Q28.5 10 26 14" opacity={st === "idle" ? 0.55 : 1} />
        <path d="M29.5 3 Q33.5 10 29.5 17" opacity={st === "playing" ? 1 : 0.3} />
      </svg>
    </button>
  );
}

function OutroCell({ e, patch }: { e: Entry & { type: "outro" }; patch: (p: any) => void }) {
  const phases = outroPhases(e);
  const setPhase = (name: string, field: string, value: string) => {
    const cur = e.phases?.length ? e.phases : OUTRO_PHASES.map((phase) => ({ phase }));
    patch({ phases: cur.map((p) => (p.phase === name ? { ...p, [field]: value || undefined } : p)) });
  };
  return (
    <div>
      <div class="meta"><span class="muted" style="font-size:11px">next lesson</span><input style="flex:1;min-width:220px" value={e.next ?? ""} placeholder="topic shown and read by Glitch" onChange={(ev: any) => patch({ next: ev.currentTarget.value || undefined })} /></div>
      <div class="meta" style="align-items:flex-start"><span class="muted" style="font-size:11px;padding-top:6px">thanks to</span><textarea style="flex:1;min-height:40px" placeholder="one name per line" value={(e.thanks ?? []).join("\n")} onChange={(ev: any) => patch({ thanks: ev.currentTarget.value.split("\n").map((x: string) => x.trim()).filter(Boolean) })} /></div>
      {phases.map((ph) => (
        <div class="meta" style="align-items:flex-start;margin-top:6px" key={ph.phase}>
          <span class="chip face" style="margin-top:6px;min-width:76px;text-align:center">{ph.phase}</span>
          <textarea style="flex:1;min-height:34px" value={ph.text} rows={Math.max(1, ph.text.split("\n").length)} onChange={(ev: any) => setPhase(ph.phase, "text", ev.currentTarget.value)} title="What Glitch says during this phase. Inline [mood] tags allowed." />
          <SayButton text={ph.text} actor="Glitch" />
          <select value={ph.mood} onChange={(ev: any) => setPhase(ph.phase, "mood", ev.currentTarget.value)}>{MOOD_NAMES.map((m) => <option value={m}>{m}</option>)}</select>
        </div>
      ))}
      <div class="meta" style="margin-top:6px"><span class="muted" style="font-size:11px">Phases run in order; each waits for Glitch's line. Titles/subtitles can be overridden in YAML.</span><button class="btn sm" onClick={() => window.studio.invoke("outro:preview")}>▶ Preview outro (demo data)</button></div>
    </div>
  );
}

function YamlEditor() {
  const s = useStore();
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: s.scriptText,
        extensions: [lineNumbers(), highlightActiveLine(), history(), yaml(), syntaxHighlighting(defaultHighlightStyle), highlightSelectionMatches(), EditorView.theme({ "&": { background: "#0d0f17", color: "#ccd0e0" }, ".cm-gutters": { background: "#12141f", color: "#5a6280", border: "none" }, ".cm-activeLine": { background: "#1c2130" } }, { dark: true }),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
          EditorView.updateListener.of((u) => { if (u.docChanged) setScriptText(u.state.doc.toString()); })],
      }),
    });
    view.current = v; return () => v.destroy();
  }, []);
  useEffect(() => { const v = view.current; if (v && v.state.doc.toString() !== s.scriptText) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: s.scriptText } }); }, [s.scriptText]);
  return <div class="cm-wrap body" ref={host} />;
}
