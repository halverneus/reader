// Gestures Jeromy authors in the Gestures tab, kept beside the config rather
// than in it: a gesture table is replaced wholesale, and config.json is
// deep-merged, so a deleted gesture would come straight back.
//
// The built-in table in glitch/dev-hands-data.ts stays the default. Anything
// here wins over it by name, so a built-in can be retuned without editing
// source, and `reset` is just deleting the entry.
import fs from "node:fs";
import path from "node:path";
import { userDataDir } from "./config";
import { BUILTIN_GESTURES, applyGestures, type Gesture } from "../../glitch/dev-hands-data";

export const gesturesFile = () => path.join(userDataDir(), "gestures.json");

export function loadUserGestures(): Record<string, Gesture> {
  try {
    const raw = JSON.parse(fs.readFileSync(gesturesFile(), "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}

export function saveUserGestures(table: Record<string, Gesture>): Record<string, Gesture> {
  // Only keep what actually differs from the built-ins, so a future change to
  // a shipped gesture is not silently pinned to today's numbers.
  const user: Record<string, Gesture> = {};
  for (const [name, g] of Object.entries(table ?? {})) {
    const b = BUILTIN_GESTURES[name];
    if (!b || JSON.stringify(b) !== JSON.stringify(g)) user[name] = g;
  }
  fs.mkdirSync(path.dirname(gesturesFile()), { recursive: true });
  fs.writeFileSync(gesturesFile(), JSON.stringify(user, null, 1));
  applyGestures(user);
  return user;
}

/** Load what he has saved and make it live. Every entry point calls this:
 *  the app on start, the post renderer, and the script tooling, or a `[hand
 *  …]` tag naming one of his own gestures would read as unknown. */
export function installUserGestures(): Record<string, Gesture> {
  const user = loadUserGestures();
  applyGestures(user);
  return user;
}
