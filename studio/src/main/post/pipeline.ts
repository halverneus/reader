// Orchestrates the post steps for one session folder. Each step is idempotent and skips if its output exists.
import fs from "node:fs";
import path from "node:path";
import { alignCam } from "./align";
import { matteCam } from "./matte";
import { renderGlitch } from "./glitch-render";
import { renderOutro } from "./outro-render";
import { buildProject } from "./kdenlive";

export interface StepState { id: string; label: string; state: "idle" | "running" | "done" | "failed"; detail?: string }
export type Log = (line: string) => void;

export async function runPipeline(dir: string, what: string, onSteps: (s: StepState[]) => void, log: Log) {
  const session = JSON.parse(fs.readFileSync(path.join(dir, "session.json"), "utf8"));
  const all = what === "all";
  const steps: StepState[] = [
    { id: "align", label: "Align cam to desktop (audio cross-correlation)", state: "idle" },
    { id: "matte", label: "Matte Dev (RVM in Docker, GPU) → dev-alpha.webm", state: "idle" },
    { id: "glitch", label: "Render Glitch from the cue log → glitch.webm", state: "idle" },
    { id: "outro", label: "Render the branded outro → outro.webm (+ sound design)", state: "idle" },
    { id: "project", label: "Build Kdenlive project (latest take wins)", state: "idle" },
  ];
  const push = () => onSteps(steps.map((s) => ({ ...s })));
  const run = async (id: string, fn: () => Promise<string | void>) => {
    const st = steps.find((s) => s.id === id)!;
    if (!all && what !== id) return;
    st.state = "running"; push();
    try { st.detail = (await fn()) || "ok"; st.state = "done"; }
    catch (e: any) { st.state = "failed"; st.detail = e.message; push(); throw e; }
    push();
  };
  push();
  await run("align", () => alignCam(dir, session, log));
  await run("matte", () => matteCam(dir, session, log));
  await run("glitch", () => renderGlitch(dir, session, log));
  await run("outro", () => renderOutro(dir, session, log));
  await run("project", () => buildProject(dir, session, log));
}
