import { useEffect, useState } from "preact/hooks";
import { MOODS, GROUPS } from "../../../glitch/moods";
import { glitch } from "./glitch-stage";
import { production, useProduction } from "../production";

export function MoodPalette({ compact }: { compact?: boolean }) {
  const [cur, setCur] = useState(glitch.mood);
  const p = useProduction();
  useEffect(() => { const i = setInterval(() => setCur(glitch.mood), 200); return () => clearInterval(i); }, []);
  const groups = Object.keys(GROUPS) as (keyof typeof GROUPS)[];
  if (!p.improvise) return (
    <div class="moods" style="justify-content:space-between">
      <span class="muted" style="font-size:12px;padding:3px 2px">Glitch follows the script's cues (<span class="mono">mood:</span>, <span class="tag">[tags]</span>, face). Current: <b>{cur}</b></span>
      <button class="mood" onClick={() => production.setImprovise(true)} title="Show the mood palette. Clicks are applied live and logged, so they end up in the cut.">🎭 improvise</button>
    </div>
  );
  return (
    <div class="moods">
      <button class="mood active" onClick={() => production.setImprovise(false)} title="Hide the palette">✕ done</button>
      {groups.map((g) => Object.entries(MOODS).filter(([, m]) => m.group === g).map(([k, m]) => (
        <button key={k} class={"mood" + (cur === k ? " active" : "")} title={m.quote} onClick={() => production.improviseMood(k)}>
          <span class="dot" style={{ background: m.expr.color ?? "#3fc9c0" }} />{compact ? m.label : m.label}
        </button>
      )))}
      <button class="mood" onClick={() => glitch.setTalking(!glitch.talking)}>🗣 talk</button>
      <button class="mood" onClick={() => glitch.slide("top")}>↑ top</button>
      <button class="mood" onClick={() => glitch.slide("bottom")}>↓ bottom</button>
      <button class="mood" onClick={() => glitch.slide(glitch.cur.visible > .5 ? "hide" : "show")}>⇆ hide/show</button>
    </div>
  );
}
