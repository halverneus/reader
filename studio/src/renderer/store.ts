// Tiny reactive store: one app state object, subscribers re-render on set().
import { useEffect, useState } from "preact/hooks";
import type { Script } from "../shared/script";

export type Tab = "script" | "record" | "post" | "settings";
export interface AppState {
  tab: Tab;
  config: any | null;
  scriptPath: string | null;
  scriptText: string;
  script: Script;
  errors: string[];
  dirty: boolean;
  toast: { msg: string; kind: "info" | "error" | "ok"; id: number } | null;
}
let state: AppState = { tab: "script", config: null, scriptPath: null, scriptText: "", script: { entries: [], actors: [] }, errors: [], dirty: false, toast: null };
const subs = new Set<(s: AppState) => void>();
export const getState = () => state;
export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
  state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
  for (const s of subs) s(state);
}
export function useStore(): AppState {
  const [, force] = useState(0);
  useEffect(() => { const f = () => force((n) => n + 1); subs.add(f); return () => { subs.delete(f); }; }, []);
  return state;
}
let toastId = 0;
export function toast(msg: string, kind: "info" | "error" | "ok" = "info") {
  const id = ++toastId; setState({ toast: { msg, kind, id } });
  setTimeout(() => { if (getState().toast?.id === id) setState({ toast: null }); }, kind === "error" ? 7000 : 3500);
}
