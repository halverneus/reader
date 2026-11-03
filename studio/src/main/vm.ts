// Keystrokes and mouse into the GNOME Boxes VM through libvirt QMP (input-send-event). Port of keys.rs + mouse.
import { ipcMain } from "electron";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "./config";
import { parseStep, KeyStep } from "../shared/script";
import { broadcast } from "./index";

interface Vm { uri: string; domain: string }
let cancelFlag = { v: false };

// GNOME Boxes (flatpak) runs its own virtqemud inside the sandbox; plain qemu:///session reaches the host daemon instead
const BOXES_SOCKET = `/run/user/${process.getuid?.() ?? 1000}/.flatpak/org.gnome.Boxes/xdg-run/libvirt/virtqemud-sock`;

export function findVm(): Vm | null {
  const cfg = loadConfig().vm;
  const boxes = fs.existsSync(BOXES_SOCKET) ? [`qemu+unix:///session?socket=${BOXES_SOCKET}`] : [];
  const uris = [...(cfg.uri ? [cfg.uri] : []), ...boxes, "qemu:///session", "qemu:///system"];
  for (const uri of [...new Set(uris)]) {
    try {
      const out = execFileSync("virsh", ["-c", uri, "list", "--name"], { encoding: "utf8", timeout: 4000 });
      const names = out.split("\n").map((s) => s.trim()).filter(Boolean);
      if (!names.length) continue;
      const domain = cfg.domain && names.includes(cfg.domain) ? cfg.domain : names[0];
      return { uri, domain };
    } catch {}
  }
  return null;
}

function qmp(vm: Vm, json: object): Promise<void> {
  return new Promise((resolve) => execFile("virsh", ["-c", vm.uri, "qemu-monitor-command", vm.domain, JSON.stringify(json)], { timeout: 5000 }, () => resolve()));
}
const keyEv = (qcode: string, down: boolean) => ({ type: "key", data: { down, key: { type: "qcode", data: qcode } } });
const sendEvents = (vm: Vm, events: object[]) => qmp(vm, { execute: "input-send-event", arguments: { events } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const KEYMAP: Record<string, string> = {
  enter: "ret", return: "ret", tab: "tab", escape: "esc", esc: "esc", backspace: "backspace", delete: "delete", space: "spc", home: "home", end: "end",
  pageup: "pgup", pagedown: "pgdn", up: "up", down: "down", left: "left", right: "right", insert: "insert", capslock: "caps_lock",
  ctrl: "ctrl", control: "ctrl", shift: "shift", alt: "alt", meta: "meta_l", super: "meta_l", win: "meta_l",
  f1: "f1", f2: "f2", f3: "f3", f4: "f4", f5: "f5", f6: "f6", f7: "f7", f8: "f8", f9: "f9", f10: "f10", f11: "f11", f12: "f12",
  minus: "minus", equal: "equal", comma: "comma", period: "dot", slash: "slash", backslash: "backslash", semicolon: "semicolon", apostrophe: "apostrophe", grave: "grave_accent", bracketleft: "bracket_left", bracketright: "bracket_right",
};
const SHIFTED: Record<string, string> = { "~": "grave_accent", "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0", "_": "minus", "+": "equal", "{": "bracket_left", "}": "bracket_right", "|": "backslash", ":": "semicolon", '"': "apostrophe", "<": "comma", ">": "dot", "?": "slash" };
const PLAIN: Record<string, string> = { "`": "grave_accent", "-": "minus", "=": "equal", "[": "bracket_left", "]": "bracket_right", "\\": "backslash", ";": "semicolon", "'": "apostrophe", ",": "comma", ".": "dot", "/": "slash", " ": "spc", "\n": "ret", "\t": "tab" };

function keyToQcode(k: string): string { const l = k.toLowerCase(); return KEYMAP[l] ?? (l.length === 1 ? charToQcode(l)?.[1] ?? l : l); }
function charToQcode(c: string): [boolean, string] | null {
  if (/[a-z]/.test(c)) return [false, c]; if (/[A-Z]/.test(c)) return [true, c.toLowerCase()]; if (/[0-9]/.test(c)) return [false, c];
  if (SHIFTED[c]) return [true, SHIFTED[c]]; if (PLAIN[c]) return [false, PLAIN[c]]; return null;
}
function delays(speed: number): { char: number; cmd: number } {
  const t: Record<number, [number, number]> = { 1: [100, 500], 2: [80, 400], 3: [60, 300], 4: [40, 200], 5: [20, 100], 6: [10, 60], 7: [5, 40], 8: [2, 20], 9: [1, 10], 10: [0, 0] };
  const [char, cmd] = t[speed] ?? [1, 10]; return { char, cmd };
}

async function typeText(vm: Vm, text: string, speed: number) {
  const { char } = delays(speed);
  // burst mode: batch events per line to minimise virsh round-trips
  if (char === 0) {
    const batch: object[] = [];
    for (const c of text) {
      const q = charToQcode(c); if (!q) continue;
      if (q[0]) batch.push(keyEv("shift", true));
      batch.push(keyEv(q[1], true), keyEv(q[1], false));
      if (q[0]) batch.push(keyEv("shift", false));
      if (batch.length >= 40) { await sendEvents(vm, batch.splice(0)); if (cancelFlag.v) return; }
    }
    if (batch.length) await sendEvents(vm, batch);
    return;
  }
  for (const c of text) {
    if (cancelFlag.v) return;
    const q = charToQcode(c); if (!q) continue;
    const ev = q[0] ? [keyEv("shift", true), keyEv(q[1], true), keyEv(q[1], false), keyEv("shift", false)] : [keyEv(q[1], true), keyEv(q[1], false)];
    await sendEvents(vm, ev); await sleep(char);
  }
}

function absXY(x: number, y: number, pct: boolean) {
  const { width, height } = loadConfig().vm;
  const fx = pct ? x / 100 : x / width, fy = pct ? y / 100 : y / height;
  return { ax: Math.round(Math.max(0, Math.min(1, fx)) * 32767), ay: Math.round(Math.max(0, Math.min(1, fy)) * 32767) };
}
// Where we last put the pointer, as fractions of the screen. Before the first move we don't know, so the first glide
// starts from the centre (the pointer jumps there, then travels).
let lastMouse = { fx: 0.5, fy: 0.5 };
const toFrac = (s: { x?: number; y?: number; pct?: boolean }) => { const { width, height } = loadConfig().vm; return { fx: (s.x ?? 0) / (s.pct ? 100 : width), fy: (s.y ?? 0) / (s.pct ? 100 : height) }; };
const absEv = (fx: number, fy: number) => { lastMouse = { fx, fy }; const { ax, ay } = absXY(fx * 100, fy * 100, true); return [{ type: "abs", data: { axis: "x", value: ax } }, { type: "abs", data: { axis: "y", value: ay } }]; };
/** How long a glide takes: quick for a nudge, never slow across the screen (students follow it without waiting on it). */
export const glideMs = (dist: number) => Math.round(Math.min(750, 220 + 450 * dist)); // dist: fraction of the screen diagonal
/** Glide the pointer with an ease-in-out so the eye can follow it. Positions come from elapsed time, not a step
 *  count: each update is a virsh round-trip of a few tens of ms, and the glide should take the same time regardless. */
async function glide(vm: Vm, to: { fx: number; fy: number }) {
  const from = { ...lastMouse };
  const dist = Math.hypot(to.fx - from.fx, (to.fy - from.fy) * 9 / 16) / Math.hypot(1, 9 / 16);
  if (dist < 0.002) { await sendEvents(vm, absEv(to.fx, to.fy)); return; }
  const dur = glideMs(dist), t0 = Date.now();
  await sendEvents(vm, absEv(from.fx, from.fy)); // put it where the glide starts (matters for the very first move)
  for (;;) {
    if (cancelFlag.v) return;
    const t = Math.min(1, (Date.now() - t0) / dur), k = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    await sendEvents(vm, absEv(from.fx + (to.fx - from.fx) * k, from.fy + (to.fy - from.fy) * k));
    if (t >= 1) return;
    await sleep(8);
  }
}
async function mouse(vm: Vm, s: Extract<KeyStep, { kind: "mouse" }>) {
  const btn = (b?: string) => ({ type: "btn", data: { down: true, button: b ?? "left" } });
  const rel = (b?: string) => ({ type: "btn", data: { down: false, button: b ?? "left" } });
  switch (s.action) {
    case "move": { const to = toFrac(s); if (s.instant) await sendEvents(vm, absEv(to.fx, to.fy)); else await glide(vm, to); break; }
    case "click": await sendEvents(vm, [btn(s.button)]); await sleep(40); await sendEvents(vm, [rel(s.button)]); break;
    case "dblclick": for (let i = 0; i < 2; i++) { await sendEvents(vm, [btn(s.button)]); await sleep(30); await sendEvents(vm, [rel(s.button)]); await sleep(60); } break;
    case "down": await sendEvents(vm, [btn(s.button)]); break;
    case "up": await sendEvents(vm, [rel(s.button)]); break;
    case "drag": { await sendEvents(vm, [btn("left")]); await sleep(60); await glide(vm, toFrac(s)); await sleep(40); await sendEvents(vm, [rel("left")]); break; }
    case "scroll": { const n = Math.abs(s.amount ?? 1), b = (s.amount ?? 1) > 0 ? "wheel-down" : "wheel-up"; for (let i = 0; i < n; i++) { await sendEvents(vm, [btn(b)]); await sendEvents(vm, [rel(b)]); await sleep(40); } break; }
  }
}

export async function runSteps(entryId: string, raw: string[], speed: number, dryRun = false) {
  cancelFlag = { v: false }; const my = cancelFlag;
  const { cmd, char } = delays(Math.max(1, Math.min(10, speed)));
  if (dryRun) {
    // Rehearsal without a VM: keep the same rhythm (typing time, waits) but send nothing.
    for (let i = 0; i < raw.length; i++) {
      if (my.v) return;
      broadcast("keys:progress", { entryId, step: i });
      const s = parseStep(raw[i]);
      const ms = s.kind === "type" ? s.text.length * Math.max(char, 4) : s.kind === "wait" ? s.ms : s.kind === "mouse" ? ((s.action === "move" && !s.instant) || s.action === "drag" ? glideMs(0.35) : 120) : 60;
      await sleep(ms + cmd);
    }
    broadcast("keys:progress", { entryId, step: raw.length });
    return;
  }
  const vm = findVm();
  if (!vm) throw new Error("No running VM found via libvirt (switch to simulated keys to rehearse)");
  for (let i = 0; i < raw.length; i++) {
    if (my.v) return;
    broadcast("keys:progress", { entryId, step: i });
    const s = parseStep(raw[i]);
    switch (s.kind) {
      case "combo": { const q = s.keys.map(keyToQcode); await sendEvents(vm, [...q.map((k) => keyEv(k, true)), ...[...q].reverse().map((k) => keyEv(k, false))]); break; }
      case "key": await sendEvents(vm, [keyEv(keyToQcode(s.key), true), keyEv(keyToQcode(s.key), false)]); break;
      case "type": await typeText(vm, s.text, speed); break;
      case "paste": await setHostClipboard(s.text); break;
      case "wait": await sleep(s.ms); break;
      case "mouse": await mouse(vm, s); break;
    }
    if (cmd > 0) await sleep(cmd);
  }
  broadcast("keys:progress", { entryId, step: raw.length });
}

function setHostClipboard(text: string): Promise<void> {
  return new Promise((resolve) => {
    const p = execFile("wl-copy", [], () => resolve());
    p.stdin?.end(text);
    p.on("error", () => resolve());
  });
}

// ── lifecycle ────────────────────────────────────────────────────────────────
// Enough to let the unattended runner reboot between lessons. Windows shows an
// "Activate Windows" watermark after a few hours up, and a reboot clears it.
//
// CAUTION: the VM normally lives inside the GNOME Boxes flatpak, whose libvirt
// daemon only exists while Boxes is running. Everything here therefore works
// through whichever URI findVm() reached. If the same disk is ever defined on
// two daemons, never start both: two qemu processes on one qcow2 destroys it.

const virsh = (uri: string, args: string[], timeout = 15000): Promise<{ ok: boolean; out: string }> =>
  new Promise((resolve) => execFile("virsh", ["-c", uri, ...args], { timeout, encoding: "utf8" },
    (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || stderr || "").trim() })));

export function boxesRunning() { return fs.existsSync(BOXES_SOCKET); }

export async function vmState(): Promise<{ vm: Vm | null; state: string; boxes: boolean; agent: boolean }> {
  const vm = findVm();
  const boxes = boxesRunning();
  if (!vm) return { vm: null, state: "no vm", boxes, agent: false };
  const st = await virsh(vm.uri, ["domstate", vm.domain], 6000);
  const ping = await virsh(vm.uri, ["qemu-agent-command", vm.domain, '{"execute":"guest-ping"}'], 4000);
  return { vm, state: st.ok ? st.out : "unknown", boxes, agent: ping.ok };
}

/** Wait until the domain is running and, if the guest agent is installed, until
 *  it answers. Without an agent there is no readiness signal at all, so we fall
 *  back to a flat settle time — the caller's `settleMs`. That is the honest
 *  behaviour: it is a guess, not a check. */
export async function vmWaitReady(timeoutMs = 240000, settleMs = 90000): Promise<{ ready: boolean; how: string }> {
  const vm = findVm();
  if (!vm) return { ready: false, how: "no vm" };
  const deadline = Date.now() + timeoutMs;
  let sawRunning = false;
  while (Date.now() < deadline) {
    const st = await virsh(vm.uri, ["domstate", vm.domain], 6000);
    if (st.ok && st.out.startsWith("running")) {
      if (!sawRunning) { sawRunning = true; broadcast("vm:status", { state: "running, waiting for the desktop" }); }
      const ping = await virsh(vm.uri, ["qemu-agent-command", vm.domain, '{"execute":"guest-ping"}'], 4000);
      if (ping.ok) return { ready: true, how: "guest agent answered" };
    }
    await sleep(3000);
  }
  if (sawRunning) { await sleep(settleMs); return { ready: true, how: `no guest agent: waited ${Math.round(settleMs / 1000)}s and hoped` }; }
  return { ready: false, how: "domain never reached running" };
}

/** Keep the guest's display awake during the parts of a run where nothing is
 *  being typed — post-production, a reboot wait, the gap between lessons.
 *
 *  A lone shift, down and up, in ONE input-send-event: nothing in a browser or
 *  in Workbench reacts to it, and a single QMP command cannot interleave with
 *  the keystrokes a script is sending, so it is safe to fire mid-take too.
 *  A mouse move would be safer still for the guest, except that it un-hides
 *  the pointer in the middle of a slide, which the camera sees. */
export async function vmNudge(): Promise<boolean> {
  const vm = findVm();
  if (!vm) return false;
  await sendEvents(vm, [keyEv("shift", true), keyEv("shift", false)]);
  return true;
}

/** Make the GNOME Boxes window fullscreen on the HOST.
 *
 *  Why Studio has to care: the capture records the Boxes *window*, so if Boxes
 *  is merely maximised, its header bar is in the shot and the guest's 1080
 *  lines are squeezed into the 1058 that are left — every slide slightly
 *  soft, every take different from the last. Verified 2026-11-03 by comparing
 *  a test capture against the shipped Week 07 lesson 01 take.
 *
 *  It cannot be done with the keys we send the guest: QMP input goes to the
 *  VM, and fullscreen belongs to the host's window manager. KWin's scripting
 *  interface can do it in one call, and no-ops harmlessly anywhere else. */
export function fullscreenVmWindow(): { ok: boolean; detail: string } {
  const js = `try {
  const list = (typeof workspace.windowList === "function") ? workspace.windowList() : workspace.clientList();
  for (let i = 0; i < list.length; i++) {
    const w = list[i];
    let cls = ""; try { cls = String(w.resourceClass || "").toLowerCase(); } catch (e) {}
    if (cls.indexOf("boxes") >= 0) {
      try { workspace.activeWindow = w; } catch (e) {}
      try { w.fullScreen = true; } catch (e) { workspace.slotWindowFullScreen(); }
    }
  }
} catch (e) {}`;
  const file = path.join(os.tmpdir(), "metrik-boxes-fullscreen.js");
  const bus = (args: string[]) => execFileSync("busctl", ["--user", ...args], { encoding: "utf8", timeout: 5000 });
  try {
    fs.writeFileSync(file, js);
    try { bus(["call", "org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting", "unloadScript", "s", "metrik-boxes-fs"]); } catch {}
    const out = bus(["call", "org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting", "loadScript", "ss", file, "metrik-boxes-fs"]);
    const id = (out.trim().split(/\s+/)[1] ?? "").trim();
    bus(["call", "org.kde.KWin", `/Scripting/Script${id}`, "org.kde.kwin.Script", "run"]);
    return { ok: true, detail: `KWin script ${id}` };
  } catch (e: any) {
    return { ok: false, detail: e?.message ?? String(e) };
  }
}

export async function vmPower(action: "start" | "reboot" | "shutdown"): Promise<{ ok: boolean; out: string }> {
  const vm = findVm();
  if (!vm) return { ok: false, out: "no running VM found via libvirt" };
  const cmd = action === "start" ? ["start", vm.domain]
    : action === "reboot" ? ["reboot", vm.domain]          // ACPI; Windows honours it
    : ["shutdown", vm.domain];
  return virsh(vm.uri, cmd, 20000);
}

export function registerVmIpc() {
  ipcMain.handle("keys:run", (_e, { entryId, steps, speed, dryRun }) => runSteps(entryId, steps, speed, !!dryRun));
  ipcMain.handle("keys:cancel", () => { cancelFlag.v = true; });
  ipcMain.handle("vm:find", () => findVm());
  ipcMain.handle("vm:state", () => vmState());
  ipcMain.handle("vm:power", (_e, action: "start" | "reboot" | "shutdown") => vmPower(action));
  ipcMain.handle("vm:nudge", () => vmNudge());
  ipcMain.handle("vm:fullscreen", () => fullscreenVmWindow());
  ipcMain.handle("vm:waitReady", (_e, { timeoutMs, settleMs }: any = {}) => vmWaitReady(timeoutMs, settleMs));
}
