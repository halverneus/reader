// Talks to a running Metrik Studio, if there is one.
//
// Everything here is optional by design. The MCP server does all of its file
// work without Studio, because most of the time Claude is editing scripts the
// app is closed. When the app IS up these calls answer the question that
// matters most -- "is this file open, and does it have unsaved changes?" --
// which is the difference between editing a script and clobbering one.
//
// Nothing in here can touch a device. The bridge exposes status, a reload
// nudge, a notification and the take log. There is deliberately no way to
// start a recording or a render from this side.
import fs from "node:fs";
import path from "node:path";
import { userDataDir } from "../shared/config";

export interface BridgeInfo { port: number; token: string; pid: number; startedAt: number }

export const bridgeFile = () => process.env.STUDIO_BRIDGE_FILE || path.join(userDataDir(), "bridge.json");

export function readBridge(): BridgeInfo | null {
  try {
    const b = JSON.parse(fs.readFileSync(bridgeFile(), "utf8")) as BridgeInfo;
    // a stale file outlives a crash; a dead pid means no bridge
    try { process.kill(b.pid, 0); } catch { return null; }
    return b;
  } catch { return null; }
}

/** One request/response over the bridge. Resolves null when Studio is not up. */
export async function ask<T = any>(op: string, params: any = {}, timeoutMs = 1500): Promise<T | null> {
  const b = readBridge();
  if (!b) return null;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(`http://127.0.0.1:${b.port}/${op}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-studio-token": b.token },
      body: JSON.stringify(params),
      signal: ctl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch { return null; }
}
