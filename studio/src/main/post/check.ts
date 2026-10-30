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
  // A source finalised on purpose part way through -- the camera and the mic
  // when the drawn avatar took the shot over -- is SHORT BY DESIGN. It still
  // has to reach the moment it was dropped: lost footage before that point is
  // lost footage either way.
  const dropped: Record<string, number> = m.capture?.dropped ?? {};
  const endOf = (src: string) => (dropped[src] != null ? (dropped[src] - m.startedAt) / 1000 : take);
  const want: [string, string, string | undefined][] = [["screen", "desktop", m.files?.desktop], ["camera", "cam", m.files?.cam], ["mic", "mic", m.files?.mic]];
  const lengths: string[] = [];
  for (const [label, src, file] of want) {
    if (!file) continue;
    if (!fs.existsSync(file)) { problems.push(`${label} file is missing (${file})`); continue; }
    const d = await durationOf(file).catch(() => 0);
    const until = endOf(src);
    lengths.push(`${label} ${d.toFixed(1)} s${dropped[src] != null ? ` (ended at ${until.toFixed(1)} s on purpose)` : ""}`);
    if (!(d > 0)) problems.push(`${label} file was never finalised (no duration) — the recorder stopped without closing it`);
    else if (d < until - SLACK) problems.push(`${label} file is ${d.toFixed(1)} s long but ${dropped[src] != null ? `ran until ${until.toFixed(1)} s` : `the take ran ${take.toFixed(1)} s`}`);
  }
  // the screen is the one thing that must cover everything
  if (dropped.desktop != null) problems.push("the screen recording was ended early, which nothing should ever do");
  log(`[check] take ${take.toFixed(1)} s · ${lengths.join(" · ") || "no capture files listed"}\n`);
  if (problems.length) throw new Error(`This take's recording is incomplete — re-record it: ${problems.join("; ")}`);
  return `take ${take.toFixed(0)} s, files complete`;
}
