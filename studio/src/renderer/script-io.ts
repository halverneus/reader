import { parseScript, serializeScript, Script } from "../shared/script";
import { getState, setState, toast } from "./store";

export async function loadScriptFile(p: string) {
  try {
    const text = await window.studio.invoke("scripts:read", p);
    const { script, errors } = parseScript(text);
    setState({ scriptPath: p, scriptText: text, script, errors, dirty: false });
    if (errors.length) toast(`Loaded with ${errors.length} issue(s)`, "error");
  } catch (e: any) { toast(`Could not open script: ${e.message}`, "error"); }
}

/** Replace the in-memory script (structured edit) and regenerate YAML text. */
export function updateScript(mut: (s: Script) => Script | void) {
  const cur = getState().script;
  const clone = structuredClone(cur);
  const next = mut(clone) ?? clone;
  const entries = [...next.entries].sort((a, b) => a.start - b.start);
  const script = { ...next, entries };
  setState({ script, scriptText: serializeScript(script), errors: [], dirty: true });
}

/** Raw YAML edit: reparse. */
export function setScriptText(text: string) {
  const { script, errors } = parseScript(text);
  setState({ scriptText: text, script: errors.length && !script.entries.length ? getState().script : script, errors, dirty: true });
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
