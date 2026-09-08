// Keystrokes and mouse into the GNOME Boxes VM through libvirt QMP (input-send-event). Port of keys.rs + mouse.
import { ipcMain } from "electron";
import { execFile, execFileSync } from "node:child_process";
import { loadConfig } from "./config";
import { parseStep, KeyStep } from "../shared/script";
import { broadcast } from "./index";

interface Vm { uri: string; domain: string }
let cancelFlag = { v: false };

export function findVm(): Vm | null {
  const cfg = loadConfig().vm;
  const uris = cfg.uri ? [cfg.uri, "qemu:///session", "qemu:///system"] : ["qemu:///session", "qemu:///system"];
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
let lastMouse = { x: 0, y: 0, pct: true };
async function mouse(vm: Vm, s: Extract<KeyStep, { kind: "mouse" }>) {
  const btn = (b?: string) => ({ type: "btn", data: { down: true, button: b ?? "left" } });
  const rel = (b?: string) => ({ type: "btn", data: { down: false, button: b ?? "left" } });
  const move = (x: number, y: number, pct: boolean) => { const { ax, ay } = absXY(x, y, pct); lastMouse = { x, y, pct }; return [{ type: "abs", data: { axis: "x", value: ax } }, { type: "abs", data: { axis: "y", value: ay } }]; };
  switch (s.action) {
    case "move": await sendEvents(vm, move(s.x ?? 0, s.y ?? 0, !!s.pct)); break;
    case "click": await sendEvents(vm, [btn(s.button)]); await sleep(40); await sendEvents(vm, [rel(s.button)]); break;
    case "dblclick": for (let i = 0; i < 2; i++) { await sendEvents(vm, [btn(s.button)]); await sleep(30); await sendEvents(vm, [rel(s.button)]); await sleep(60); } break;
    case "down": await sendEvents(vm, [btn(s.button)]); break;
    case "up": await sendEvents(vm, [rel(s.button)]); break;
    case "drag": {
      await sendEvents(vm, [btn("left")]); await sleep(60);
      const steps = 12; const from = lastMouse;
      for (let i = 1; i <= steps; i++) { const t = i / steps; await sendEvents(vm, move(from.x + ((s.x ?? 0) - from.x) * t, from.y + ((s.y ?? 0) - from.y) * t, !!s.pct)); await sleep(16); }
      await sendEvents(vm, [rel("left")]); break;
    }
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
      const ms = s.kind === "type" ? s.text.length * Math.max(char, 4) : s.kind === "wait" ? s.ms : s.kind === "mouse" ? 120 : 60;
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

export function registerVmIpc() {
  ipcMain.handle("keys:run", (_e, { entryId, steps, speed, dryRun }) => runSteps(entryId, steps, speed, !!dryRun));
  ipcMain.handle("keys:cancel", () => { cancelFlag.v = true; });
  ipcMain.handle("vm:find", () => findVm());
}
