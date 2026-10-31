import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { toast } from "../store";
import { DevRig, DevDriver } from "../../../glitch/dev-rig";
import { SHAPES } from "../../../glitch/dev-hands";
import { applyGestures, GESTURES, HOME, type Gesture, type HandPose } from "../../../glitch/dev-hands-data";
import { LAYOUT } from "../../../glitch/vex";

/** Authoring avatar Dev's hand gestures.
 *
 *  A gesture is keyframes from home and back. Mark a middle one as the HOLD
 *  and the hand goes up and stays there until something else is asked for,
 *  which is what makes "two fingers" a state you can leave running across a
 *  sentence rather than a two-second animation you have to time.
 *
 *  What he saves goes to gestures.json beside the config, not into the
 *  source: only the entries that differ from the shipped table are kept, so
 *  a later change to a built-in is not silently pinned to today's numbers. */

const SLIDERS: { k: keyof HandPose; label: string; min: number; max: number; step: number; dp: number }[] = [
  { k: "ua", label: "upper", min: -10, max: 60, step: 0.5, dp: 1 },
  { k: "fa", label: "fore", min: -60, max: 140, step: 0.5, dp: 1 },
  { k: "len", label: "length", min: 180, max: 520, step: 1, dp: 0 },
  { k: "rot", label: "rotate", min: -180, max: 180, step: 1, dp: 0 },
  { k: "scale", label: "size", min: 0.6, max: 3.2, step: 0.01, dp: 2 },
  { k: "vis", label: "shown", min: 0, max: 1, step: 0.01, dp: 2 },
];

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const newGesture = (): Gesture => ({
  label: "", hold: 1,
  keys: [
    { t: 0, p: { ...HOME } },
    { t: 0.5, p: { ua: 16, fa: 18, len: 360, rot: 8, scale: 1.9, shape: "one_up", vis: 1, flip: false } },
    { t: 1.5, p: { ...HOME } },
  ],
});

export function GesturesView() {
  const [table, setTable] = useState<Record<string, Gesture>>(() => clone(GESTURES));
  const [builtin, setBuiltin] = useState<Record<string, Gesture>>({});
  const [sel, setSel] = useState<string>(Object.keys(GESTURES)[0] ?? "");
  const [ki, setKi] = useState(1);
  const [dirty, setDirty] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const driver = useMemo(() => new DevDriver(7), []);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    window.studio.invoke("gestures:get").then((g: any) => {
      setBuiltin(g.builtin ?? {});
      applyGestures(g.user ?? {});
      setTable(clone(GESTURES));
    }).catch(() => {});
  }, []);

  // its own rig, so nothing here disturbs the one the prompter is driving
  useEffect(() => {
    const svg = svgRef.current!; svg.replaceChildren();
    const rig = new DevRig(svg);
    let last = performance.now(), raf = 0;
    const loop = (now: number) => {
      rig.update(driver.tick(Math.min(.05, (now - last) / 1000)), now / 1000, driver.gl);
      last = now; raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    driver.setMood("neutral");
    return () => cancelAnimationFrame(raf);
  }, []);

  const g = table[sel];
  const keys = g?.keys ?? [];
  const idx = Math.min(ki, Math.max(0, keys.length - 1));
  const key = keys[idx];

  // while editing, the stage is pinned to the keyframe in hand
  useEffect(() => { if (!playing && key) driver.forcePose({ ...key.p }); }, [playing, key, sel, idx, table]);

  const edit = (fn: (t: Record<string, Gesture>) => void) => {
    setTable((prev) => { const next = clone(prev); fn(next); return next; });
    setDirty(true);
  };
  /** The rig reads the live table, so push edits into it before playing. */
  const live = () => applyGestures(table);

  const play = (hold: boolean) => {
    live(); setPlaying(true); driver.forcePose(null);
    if (!hold && g?.hold != null) {
      // "play" shows the whole thing through, hold and all
      const t = clone(table); delete t[sel].hold; applyGestures(t);
      setTimeout(() => applyGestures(table), 60);
    }
    driver.playGesture(sel);
  };
  const release = () => { driver.playGesture(null); };
  const home = () => { setPlaying(false); driver.playGesture(null); driver.forcePose(key ? { ...key.p } : null); };

  const save = async () => {
    try {
      await window.studio.invoke("gestures:set", table);
      applyGestures(table); setDirty(false);
      toast(`Saved ${Object.keys(table).length} gestures`, "ok");
    } catch (e: any) { toast(`Save: ${e.message}`, "error"); }
  };
  const revert = () => {
    if (!builtin[sel]) return;
    edit((t) => { t[sel] = clone(builtin[sel]); });
    toast(`${sel} is back to the shipped version`, "info");
  };

  const rename = (raw: string) => {
    const n = raw.trim().toLowerCase().replace(/[^a-z_]/g, "");
    if (!n || (n !== sel && table[n])) return;
    edit((t) => { t[n] = t[sel]; delete t[sel]; });
    setSel(n);
  };

  if (!g) return <div class="body" style="padding:20px"><span class="muted">No gestures.</span></div>;

  return (
    <div class="body gestures">
      <div class="gcol">
        <h3>Gestures</h3>
        {Object.keys(table).map((n) => (
          <button key={n} class={"grow" + (n === sel ? " on" : "")} onClick={() => { setSel(n); setKi(1); setPlaying(false); }}>
            {n}{table[n].hold != null && <span class="chip">held</span>}
            {!builtin[n] && <span class="chip new">yours</span>}
          </button>
        ))}
        <div class="gbar">
          <button onClick={() => {
            let n = "gesture"; let i = 2; while (table[n]) n = `gesture${i++}`;
            edit((t) => { t[n] = newGesture(); }); setSel(n); setKi(1);
          }}>+ new</button>
          <button disabled={!builtin[sel]} onClick={revert} title="Put this one back the way it shipped">revert</button>
          <button disabled={!!builtin[sel]} onClick={() => { const names = Object.keys(table).filter((n) => n !== sel); edit((t) => { delete t[sel]; }); setSel(names[0] ?? ""); }}>delete</button>
        </div>
        <p class="ghint">A gesture runs from home, to a pose, and back. Mark
        the middle keyframe <b>hold</b> and the hand stays there until another
        gesture is asked for. Use it in a Dev line as <code>[hand {sel}]</code>,
        and <code>[hand home]</code> to put the arm away.</p>
        <div class="gbar">
          <button class="btn" disabled={!dirty} onClick={save}>{dirty ? "Save gestures" : "Saved"}</button>
        </div>
      </div>

      <div class="gcol wide">
        <div class="gstage"><svg ref={svgRef} viewBox={`0 0 ${LAYOUT.W} ${LAYOUT.H}`} /></div>
        <div class="gbar">
          <button onClick={() => play(false)}>play</button>
          <button onClick={() => play(true)}>play &amp; hold</button>
          <button onClick={release}>release</button>
          <button onClick={home}>back to editing</button>
        </div>
        <h3>Name and description</h3>
        <div class="grow2"><span>name</span><input value={sel} onChange={(e: any) => rename(e.currentTarget.value)} /></div>
        <div class="grow2"><span>does</span><input value={g.label} placeholder="What this gesture is for, in your words"
          onInput={(e: any) => edit((t) => { t[sel].label = e.currentTarget.value; })} /></div>
        <h3>Keyframes</h3>
        <div class="gkeys">
          {keys.map((k, i) => (
            <button key={i} class={"gk" + (i === idx ? " on" : "")} onClick={() => { setPlaying(false); setKi(i); }}>
              K{i} · {Math.round(k.t * 1000)}{g.hold === i ? " ⏸" : ""}
            </button>
          ))}
        </div>
        <div class="gbar">
          <button onClick={() => {
            edit((t) => {
              const ks = t[sel].keys, a = ks[idx], b = ks[idx + 1];
              ks.splice(idx + 1, 0, { t: b ? (a.t + b.t) / 2 : a.t + 0.5, p: clone(a.p) });
              if (t[sel].hold != null && t[sel].hold! > idx) t[sel].hold!++;
            });
            setKi(idx + 1);
          }}>+ keyframe after</button>
          <button disabled={idx === 0 || idx === keys.length - 1 || keys.length <= 2}
            onClick={() => { edit((t) => {
              t[sel].keys.splice(idx, 1);
              if (t[sel].hold === idx) delete t[sel].hold; else if (t[sel].hold != null && t[sel].hold! > idx) t[sel].hold!--;
            }); setKi(Math.max(1, idx - 1)); }}>delete this one</button>
          <button disabled={idx === 0 || idx === keys.length - 1}
            onClick={() => edit((t) => { if (t[sel].hold === idx) delete t[sel].hold; else t[sel].hold = idx; })}>
            {g.hold === idx ? "stop holding here" : "hold here"}
          </button>
        </div>
        <p class="ghint">Keyframe 0 and the last one are home, off frame. Times
        are milliseconds from the start of the line the gesture is attached to.
        For a held gesture only the time to the hold matters while it goes up,
        and the time after it is the way back.</p>
      </div>

      <div class="gcol">
        <h3>This keyframe</h3>
        <div class="grow3"><span>at ms</span>
          <input type="number" step={25} min={0} value={Math.round(key.t * 1000)}
            onInput={(e: any) => edit((t) => { t[sel].keys[idx].t = Math.max(0, +e.currentTarget.value / 1000); })} />
          <span />
        </div>
        {SLIDERS.map((s) => (
          <div class="grow3" key={s.k}>
            <span>{s.label}</span>
            <input type="range" min={s.min} max={s.max} step={s.step} value={key.p[s.k] as number}
              onInput={(e: any) => edit((t) => { (t[sel].keys[idx].p as any)[s.k] = +e.currentTarget.value; })} />
            <span>{(key.p[s.k] as number).toFixed(s.dp)}</span>
          </div>
        ))}
        <div class="gbar">
          <button aria-pressed={key.p.flip === false}
            onClick={() => edit((t) => { const p = t[sel].keys[idx].p; if (p.flip === false) delete p.flip; else p.flip = false; })}>
            mirror the hand
          </button>
        </div>
        <h3>Hand</h3>
        <div class="gshapes">
          {Object.keys(SHAPES).map((sh) => (
            <button key={sh} class={"gk" + (key.p.shape === sh ? " on" : "")}
              onClick={() => edit((t) => { t[sel].keys[idx].p.shape = sh; })}>{sh}</button>
          ))}
        </div>
      </div>
    </div>
  );
}
