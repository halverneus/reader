import { useEffect, useState } from "preact/hooks";
import { useStore } from "../store";
import { GlitchStage } from "../components/glitch-stage";
import { MoodPalette } from "../components/mood-palette";
import { Prompter } from "../components/prompter";
import { Sources } from "../components/sources";
import { production, useProduction } from "../production";

export function RecordView() {
  const { script, config } = useStore();
  const p = useProduction();
  const [clock, setClock] = useState("00:00.0");
  useEffect(() => { const i = setInterval(() => setClock(production.clockText()), 100); return () => clearInterval(i); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement; if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT")) return;
      if (e.key === "ArrowDown" || e.key === " " || e.key === "PageDown") { e.preventDefault(); production.advance(); }
      else if (e.key === "ArrowUp" || e.key === "PageUp") { e.preventDefault(); production.rewind(); }
      else if (e.key === "Escape") production.stopAll();
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div class="record-view">
      <Prompter />
      <aside class="side">
        <GlitchStage devPos={p.devPos} />
        <MoodPalette compact />
        <Sources devPos={p.devPos} />
      </aside>
      <div class="transport">
        {p.recording ? <><span class="rec-dot" /><span class="chip" style="border-color:#e74c3c;color:#e74c3c">REC</span></> : <span class="chip">REHEARSAL</span>}
        <span class="clock">{clock}</span>
        <label class="row" style="gap:5px;font-size:12px" title="Off: keystrokes and mouse are simulated with the same timing (rehearse without the VM)"><input type="checkbox" checked={p.sendKeys} onChange={(e: any) => production.setSendKeys(e.currentTarget.checked)} /> send keys to VM</label>
        <span class="muted mono">marker {p.marker < 0 ? "—" : p.marker} / {script.entries.length ? Math.max(...script.entries.map((e) => e.start)) : 0}</span>
        <span class="muted">take {p.take}</span>
        <span style="flex:1" />
        <button class="btn" onClick={() => production.reset()} title="Back to the top">⟲ Reset</button>
        <button class="btn" onClick={() => production.rewind()} title="↑">◀ Back</button>
        <button class="btn primary" onClick={() => production.advance()} title="↓ / Space">Next ▶</button>
        {!p.recording
          ? <button class="btn rec" disabled={!config} onClick={() => production.startRecording()}>● Record</button>
          : <button class="btn" onClick={() => production.stopRecording()}>■ Stop</button>}
      </div>
    </div>
  );
}
