// Orchestrates the post steps for one session folder. Each step is idempotent and skips if its output exists.
import fs from "node:fs";
import path from "node:path";
import { alignCam } from "./align";
import { cleanMic } from "./clean-audio";
import { matteCam } from "./matte";
import { renderGlitch } from "./glitch-render";
import { renderOutro } from "./outro-render";
import { buildProject } from "./kdenlive";
import { renderVideo } from "./render";
import { loadConfig } from "../config";

export interface StepState { id: string; label: string; state: "idle" | "running" | "done" | "failed"; detail?: string }
export type Log = (line: string) => void;

export async function runPipeline(dir: string, what: string, onSteps: (s: StepState[]) => void, log: Log) {
  const session = JSON.parse(fs.readFileSync(path.join(dir, "session.json"), "utf8"));
  const all = what === "all";
  const steps: StepState[] = [
    { id: "align", label: "Align cam + mic to desktop", state: "idle" },
    { id: "clean", label: "Clean mic audio (low cut + RNNoise + soft gate) → mic-clean.flac", state: "idle" },
    { id: "matte", label: "Matte Dev (RVM in Docker, GPU) → dev-alpha.webm", state: "idle" },
    { id: "glitch", label: "Render Glitch from the cue log → glitch.webm", state: "idle" },
    { id: "outro", label: "Render the branded outro → outro.webm (+ sound design)", state: "idle" },
    { id: "project", label: "Build Kdenlive project (latest take wins)", state: "idle" },
    { id: "render", label: "Render the video with Kdenlive → MP4", state: "idle" },
  ];
  const push = () => onSteps(steps.map((s) => ({ ...s })));
  const run = async (id: string, fn: (progress: (detail: string) => void) => Promise<string | void>) => {
    const st = steps.find((s) => s.id === id)!;
    if (!all && what !== id) return;
    // Run everything renders only when asked to (Post tab checkbox); the 6 Render button always does
    if (id === "render" && all && !loadConfig().post?.autoRender) { st.detail = "off — tick “render video” to include it"; push(); return; }
    st.state = "running"; push();
    const progress = (detail: string) => { st.detail = detail; push(); };
    try { st.detail = (await fn(progress)) || "ok"; st.state = "done"; }
    catch (e: any) { st.state = "failed"; st.detail = e.message; push(); throw e; }
    push();
  };
  push();
  await run("align", () => alignCam(dir, session, log));
  await run("clean", () => cleanMic(dir, session, log));
  await run("matte", () => matteCam(dir, session, log));
  await run("glitch", () => renderGlitch(dir, session, log));
  await run("outro", () => renderOutro(dir, session, log));
  await run("project", () => buildProject(dir, session, log));
  await run("render", (progress) => renderVideo(dir, session, log, progress));
}
