import { parseScript, serializeScript, Script } from "../shared/script";
import { markerDiff } from "../shared/diff";
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
}
