// Pre-flight for post: refuse to build from a take whose capture files don't cover it. The 2026-09-23 "Create and
// Drop Schema" take ran 641 s in the prompter while the recorder had been torn down 4.8 s in; every later step
// "succeeded" and the video came out with Glitch alone — no screen, no Dev.
import fs from "node:fs";
import { durationOf } from "./exec";
import type { Log } from "./pipeline";

const SLACK = 3; // s: files start up to ~0.3 s late and the stop takes a moment; anything past this is lost footage

export async function checkCapture(dir: string, session: any, log: Log): Promise<string> {
  const m = session.meta ?? {};
  const take = ((m.stoppedAt ?? session.events?.at(-1)?.t ?? m.startedAt) - m.startedAt) / 1000;
  const problems: string[] = [];
  if (m.capture?.lostAt) problems.push(`recording stopped ${((m.capture.lostAt - m.startedAt) / 1000).toFixed(1)} s into the take (${m.capture.lostWhy ?? "no reason logged"})`);
  const want: [string, string | undefined][] = [["screen", m.files?.desktop], ["camera", m.files?.cam], ["mic", m.files?.mic]];
  const lengths: string[] = [];
  for (const [label, file] of want) {
    if (!file) continue;
    if (!fs.existsSync(file)) { problems.push(`${label} file is missing (${file})`); continue; }
    const d = await durationOf(file).catch(() => 0);
    lengths.push(`${label} ${d.toFixed(1)} s`);
    if (!(d > 0)) problems.push(`${label} file was never finalised (no duration) — the recorder stopped without closing it`);
    else if (d < take - SLACK) problems.push(`${label} file is ${d.toFixed(1)} s long but the take ran ${take.toFixed(1)} s`);
  }
  log(`[check] take ${take.toFixed(1)} s · ${lengths.join(" · ") || "no capture files listed"}\n`);
  if (problems.length) throw new Error(`This take's recording is incomplete — re-record it: ${problems.join("; ")}`);
  return `take ${take.toFixed(0)} s, files complete`;
}
