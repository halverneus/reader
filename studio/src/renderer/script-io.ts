import { parseScript, serializeScript, Script, speechChunks } from "../shared/script";
import { markerDiff, textHash } from "../shared/diff";
import { getState, setState, toast } from "./store";

export async function loadScriptFile(p: string, opts: { diff?: boolean } = {}) {
  try {
    const before = getState().script;
    const wasSame = getState().scriptPath === p;
    const text = await window.studio.invoke("scripts:read", p);
    const { script, errors } = parseScript(text);
    const d = opts.diff && wasSame ? markerDiff(before, script) : null;
    setState({
      scriptPath: p, scriptText: text, script, errors, dirty: false,
      changed: d && d.touched.length ? { markers: d.touched, at: Date.now() } : null,
    });
    if (errors.length) toast(`Loaded with ${errors.length} issue(s)`, "error");
    warmClonedVoice(script);
    return d;
  } catch (e: any) { toast(`Could not open script: ${e.message}`, "error"); return null; }
}

/** Replace the in-memory script (structured edit) and regenerate YAML text. */
export function updateScript(mut: (s: Script) => Script | void) {
  const cur = getState().script;
  const clone = structuredClone(cur);
  const next = mut(clone) ?? clone;
  const entries = [...next.entries].sort((a, b) => a.start - b.start);
  const script = { ...next, entries };
  setState({ script, scriptText: serializeScript(script), errors: [], dirty: true, changed: null });
}

/** Raw YAML edit: reparse. */
export function setScriptText(text: string) {
  const { script, errors } = parseScript(text);
  setState({ scriptText: text, script: errors.length && !script.entries.length ? getState().script : script, errors, dirty: true, changed: null });
}

/** Create a new Script.yml from the template and open it. */
export async function createScript(course: string, week: string, lesson: string): Promise<boolean> {
  try {
    const p = await window.studio.invoke("scripts:create", { course, week, lesson });
    await loadScriptFile(p); toast(`Created ${p.split("/").slice(-3).join("/")}`, "ok"); return true;
  } catch (e: any) { toast(e.message, "error"); return false; }
}

export async function saveScript(): Promise<boolean> {
  const { scriptPath, scriptText } = getState();
  if (!scriptPath) { toast("No script file selected", "error"); return false; }
  await window.studio.invoke("scripts:write", scriptPath, scriptText);
  setState({ dirty: false }); toast("Saved", "ok");
  return true;
}

/** Reload and notice requests from an outside tool (see src/main/bridge.ts).
 *
 *  Only the script that is actually open reloads. An edit to some other
 *  lesson changes nothing on screen, which is what you want: the open script
 *  is the one being worked on, and the rest can wait until it is opened. */
export function installBridgeListeners() {
  window.studio.on("bridge:reload", async (file: string) => {
    const { scriptPath, dirty } = getState();
    if (!scriptPath || scriptPath !== file) return;
    if (dirty) { toast("Claude edited this script on disk, but you have unsaved changes here. Save or discard, then reopen it.", "error", true); return; }
    const d = await loadScriptFile(file, { diff: true });
    const n = d?.touched.length ?? 0;
    toast(n ? `Claude updated ${n} marker${n === 1 ? "" : "s"}: ${d!.touched.slice(0, 6).join(", ")}${n > 6 ? "…" : ""}` : "Reloaded from disk", "ok");
  });
  window.studio.on("bridge:notify", (text: string) => toast(text, "info"));

  // Questions main cannot answer from its own cached state, because the
  // buffer lives here. Reading it is what lets an outside tool work with
  // UNSAVED text instead of telling Jeromy to go and save first.
  window.studio.on("bridge:request", ({ id, op, params }: { id: number; op: string; params: any }) => {
    const answer = (payload: any) => window.studio.invoke("bridge:reply", id, payload).catch(() => {});
    const { scriptPath, scriptText, dirty } = getState();

    if (op === "buffer") {
      return answer({ path: scriptPath, text: scriptText, hash: textHash(scriptText), dirty });
    }

    if (op === "apply") {
      // compare-and-swap: if the text moved since it was read, the caller's
      // edit was computed against something that no longer exists
      if (params?.expectHash && textHash(scriptText) !== params.expectHash)
        return answer({ applied: false, reason: "the buffer changed after it was read" });
      setScriptText(String(params?.text ?? ""));
      toast("Claude edited this script. It is unsaved: Ctrl+Z undoes it, Ctrl+S keeps it.", "info", true);
      return answer({ applied: true });
    }

    answer({ error: `unknown request "${op}"` });
  });
}

/** Exactly the texts playback will ask the voice service for.
 *
 *  This has to match `synthLine`, which splits a line into speech chunks
 *  around its [pause] and [mood] tags and synthesises each chunk separately.
 *  Warming the whole cleaned line instead cached entries under keys nothing
 *  ever requested: every preview still generated from scratch, and the cache
 *  looked like it was being wiped on restart when in fact it was never being
 *  read. */
/** A short, stable label for the lesson a clip belongs to, from its path:
 *  ".../Week 07/01 - VIEWs/Script.yml" -> "Week 07 / 01 - VIEWs". */
export function lessonLabel(p?: string | null): string | undefined {
  if (!p) return undefined;
  const parts = p.split("/").filter(Boolean);
  return parts.length >= 3 ? parts.slice(-3, -1).join(" / ") : undefined;
}

export function clonedTexts(script: Script): string[] {
  const cfg = getState().config;
  const cloned = Object.entries(cfg?.voices ?? {})
    .filter(([, v]) => v === "dev-clone").map(([a]) => a);
  if (!cloned.length) return [];
  const out: string[] = [];
  for (const e of script.entries) {
    if (e.type !== "line" || !cloned.includes(e.actor)) continue;
    for (const c of speechChunks(e.text)) if (c.text.trim()) out.push(c.text);
  }
  return out;
}

/** Render Dev's lines ahead of time.
 *
 *  His cloned voice runs at about real time, so a line asked for on demand
 *  arrives a beat after it is wanted. Handing the whole script over when it
 *  opens means the cache is warm long before anyone presses record, and a
 *  cache hit is a file read. Lines already rendered are skipped by the
 *  service, so re-opening a script costs nothing. */
export function warmClonedVoice(script: Script) {
  const texts = clonedTexts(script);
  if (!texts.length) return;
  window.studio.invoke("devvoice:warm", {
    lesson: lessonLabel(getState().scriptPath), actor: "Dev",
    items: texts.map((text) => ({ text })),
  }).catch(() => {});
}
