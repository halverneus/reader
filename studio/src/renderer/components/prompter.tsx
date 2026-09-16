import { useEffect, useRef } from "preact/hooks";
import { useStore } from "../store";
import { Entry, markers, entriesAt, splitMoodTags, parseStep, outroPhases } from "../../shared/script";
import { useProduction } from "../production";

/** One vertical timeline. Every marker is a row with three cells (dialogue | notes | keys) that share a height,
 *  so the three tracks stay in step and nothing needs to be scrolled separately. */
export function Prompter() {
  const { script } = useStore();
  const p = useProduction();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const body = box.current;
    const now = body?.querySelector(".mrow.now") as HTMLElement | null;
    if (!now || !body) return;
    // Measure against the scroll box, not offsetTop: the row's offsetParent is the page (nothing in the
    // chain is positioned), so offsetTop also counts the topbar and the column header and scrolls too far,
    // hiding the first line of the row behind the header.
    const top = body.scrollTop + now.getBoundingClientRect().top - body.getBoundingClientRect().top;
    body.scrollTo({ top: Math.max(0, top - 16), behavior: "smooth" });
  }, [p.marker]);
  const ms = markers(script);
  return (
    <div class="prompter">
      <div class="phead"><span>Dialogue</span><span>Editor notes</span><span>Keys &amp; mouse {p.keysRunning && <span class="led ok" title="keystrokes running" />}</span></div>
      <div class="pbody" ref={box}>
        {ms.map((m) => {
          const es = entriesAt(script, m);
          const st = m === p.marker ? " now" : m < p.marker ? " done" : "";
          const talk = es.filter((e) => e.type === "line" || e.type === "face" || e.type === "slide" || e.type === "outro");
          const notes = es.filter((e) => e.type === "editor");
          const keys = es.filter((e) => e.type === "keys");
          return (
            <div key={m} class={"mrow" + st}>
              <div class="mnum"><span>{m}</span>{es.some((e) => e.auto) && <span class="chip" title="auto-advances when everything here finishes">auto</span>}</div>
              <div class="mcell dlg">{talk.map((e) => <Talk key={e.id} e={e} p={p} />)}</div>
              <div class="mcell note">{notes.map((e) => e.type === "editor" && <div key={e.id} class="txt">{e.text}</div>)}</div>
              <div class="mcell keys">{keys.map((e) => e.type === "keys" && (
                <div key={e.id}>
                  {e.speed != null && <div class="muted mono" style="font-size:11px">speed {e.speed}</div>}
                  {e.keystrokes.map((k, i) => { const cls = p.keysEntryId === e.id ? (i < p.keysStep ? " done" : i === p.keysStep ? " active" : "") : ""; const s = parseStep(k); const label = s.kind === "type" && s.text.length > 90 ? "t:" + s.text.slice(0, 90) + "…" : k; return <div class={"step" + cls}>{label}</div>; })}
                  {p.keysEntryId === e.id && p.keysRunning && <div class="wait">⌛ wait for keys to finish</div>}
                </div>))}</div>
            </div>
          );
        })}
        {!ms.length && <div class="muted" style="padding:20px">No script loaded.</div>}
        <div style="height:60vh" />
      </div>
    </div>
  );
}

function Talk({ e, p }: { e: Entry; p: any }) {
  if (e.type === "line") return (
    <div class={"pitem " + e.actor}>
      <div class="who"><span class={"chip " + e.actor}>{e.actor}</span>{e.mood && <span class="chip face">{e.mood}</span>}</div>
      <div class="txt">{splitMoodTags(e.text).segments.map((sg) => <>{sg.mood && <span class="tag">[{sg.mood}] </span>}{sg.pause != null && <span class="tag">[pause {sg.pause}] </span>}{sg.text}</>)}</div>
    </div>);
  if (e.type === "face") return <div class="pitem face"><span class="chip face">face</span> <span class="muted">{e.delay ? `after ${e.delay} ms, ` : ""}Glitch → {e.mood}{e.hold ? ` for ${e.hold} ms` : ""}</span></div>;
  if (e.type === "slide") return <div class="pitem slide"><span class="chip slide">slide</span> <span class="muted">{e.actor} → {e.to}</span></div>;
  if (e.type === "outro") return (
    <div class="pitem outro"><div class="who"><span class="chip outro">outro</span></div>
      {outroPhases(e).map((ph, i) => <div class="txt" style={{ fontSize: "15px", color: p.outroPhase === i && e.start === p.marker ? "var(--text)" : "var(--muted)", marginBottom: "6px" }}><span class="chip face">{ph.phase}</span> {ph.title}{ph.subtitle ? ` · ${ph.subtitle}` : ""}{ph.names.length ? ` · ${ph.names.join(", ")}` : ""}<br />{splitMoodTags(ph.text).segments.map((sg) => <>{sg.mood && <span class="tag">[{sg.mood}] </span>}{sg.pause != null && <span class="tag">[pause {sg.pause}] </span>}{sg.text}</>)}</div>)}
    </div>);
  return null;
}
