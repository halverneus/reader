import { useEffect, useRef, useState } from "preact/hooks";
import { GlitchStage } from "./glitch-stage";
import { production, useProduction, LogEvent } from "../production";
import { useStore } from "../store";
import { cleanText } from "../../shared/script";

/** Live view of Glitch and avatar Dev during an unattended run.
 *
 *  Why it exists: the avatars are composited in POST, so the first time
 *  anybody saw a gesture or a mood land was in the finished render, hours
 *  later. The drivers are already ticking during a take (production.ts owns
 *  them), so the only thing missing was somewhere to look. This mounts the
 *  same stage the Record tab uses, next to the cue tail, so an animation bug
 *  is visible while it happens instead of after the render.
 *
 *  The cue tail is polled rather than subscribed: moods and gestures fire
 *  several times per line and re-rendering the whole Run view on each one is
 *  a cost worth avoiding. */
const KINDS: Record<string, string> = {
  mood: "#9b7fe8", gesture: "#3fc9c0", slide: "#e8a830", avatar: "#e85a6a",
  "line-start": "#5a6f88", keys: "#5a6f88", "intro-hold": "#e8a830",
};

export function RunPreview() {
  const p = useProduction();
  const { script } = useStore();
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [clock, setClock] = useState("00:00.0");
  const tail = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const i = setInterval(() => {
      setEvents(production.recentEvents().slice(-14));
      setClock(production.clockText());
    }, 250);
    return () => clearInterval(i);
  }, []);
  useEffect(() => { if (tail.current) tail.current.scrollTop = tail.current.scrollHeight; }, [events.length]);

  // The line on the current marker, so a reaction can be read against the words.
  const line = script.entries.find((e) => e.start === p.marker && e.type === "line") as any;
  const spoken = line ? cleanText(line.text) : "";

  return (
    <div class="run-preview">
      <div>
        <GlitchStage devPos={p.devPos} avatar={p.avatar} />
        <div class="rp-bar">
          {p.recording ? <><span class="rec-dot" /><span class="chip" style="border-color:#e74c3c;color:#e74c3c">REC</span></>
                       : <span class="chip">idle</span>}
          <span class="clock">{clock}</span>
          <span class="muted mono">marker {p.marker < 0 ? "—" : p.marker}</span>
          {p.avatar && <span class="chip" title="Dev is being drawn, not filmed">avatar</span>}
          <span style="flex:1" />
          <span class="muted mono">Dev: {p.devPos}</span>
        </div>
        {spoken && <div class="rp-line"><b>{line.actor}</b> {spoken}</div>}
      </div>
      <div class="rp-tail" ref={tail}>
        {events.length === 0 && <div class="muted" style="font-size:12px">Cues appear here as they fire.</div>}
        {events.map((e, i) => (
          <div key={i} class="rp-ev">
            <span class="rp-kind" style={{ color: KINDS[e.kind] ?? "#8497ab" }}>{e.kind}</span>
            <span class="muted mono">
              {e.kind === "mood" ? `${e.actor ?? "Glitch"} → ${e.mood}`
                : e.kind === "gesture" ? `${e.name}`
                : e.kind === "slide" ? `${e.actor} → ${e.to}`
                : e.kind === "line-start" ? `${e.actor}` : ""}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
