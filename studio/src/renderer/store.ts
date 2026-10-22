// Tiny reactive store: one app state object, subscribers re-render on set().
import { useEffect, useState } from "preact/hooks";
import type { Script } from "../shared/script";
import { textHash } from "../shared/diff";

export type Tab = "script" | "record" | "post" | "settings";
export interface AppState {
  tab: Tab;
  config: any | null;
  scriptPath: string | null;
  scriptText: string;
  script: Script;
  errors: string[];
  dirty: boolean;
  toast: { msg: string; kind: "info" | "error" | "ok"; id: number; sticky?: boolean } | null;
  /** Markers an outside edit just touched, so the slots can flash. Cleared
   *  on the next edit of our own, and by a timer in the view. */
  changed: { markers: number[]; at: number } | null;
}
let state: AppState = { tab: "script", config: null, scriptPath: null, scriptText: "", script: { entries: [], actors: [] }, errors: [], dirty: false, toast: null, changed: null };
const subs = new Set<(s: AppState) => void>();
export const getState = () => state;
let lastBridge = "";
export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
  state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
  for (const s of subs) s(state);
  // Outside tools check this before writing to a script, so it has to be
  // accurate rather than occasionally accurate: report from the one place
  // every state change goes through.
  const hash = state.scriptPath ? textHash(state.scriptText) : "";
  const sig = `${state.scriptPath ?? ""}|${state.dirty}|${hash}`;
  if (sig !== lastBridge) {
    lastBridge = sig;
    window.studio?.invoke("bridge:state", state.scriptPath ?? undefined, state.dirty, hash).catch(() => {});
  }
}
export function useStore(): AppState {
  const [, force] = useState(0);
  useEffect(() => { const f = () => force((n) => n + 1); subs.add(f); return () => { subs.delete(f); }; }, []);
  return state;
}
let toastId = 0;
/** `sticky` stays up until clicked: for things that must not be missed mid-take. */
export function toast(msg: string, kind: "info" | "error" | "ok" = "info", sticky = false) {
  const cur = getState().toast; if (cur?.sticky && !sticky) return; // don't bury a sticky warning under routine notices
  const id = ++toastId; setState({ toast: { msg, kind, id, sticky } });
  if (!sticky) setTimeout(() => { if (getState().toast?.id === id) setState({ toast: null }); }, kind === "error" ? 7000 : 3500);
}
