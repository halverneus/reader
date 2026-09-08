// Production engine: drives the prompter, TTS, keystrokes, Glitch moods/slides, and the take/event log.
// Semantics ported from the Rust reader (advance/rewind/auto/keys blocking) and extended.
import { useEffect, useState } from "preact/hooks";
import { Entry, entriesAt, nextMarker, splitMoodTags, cleanText, outroPhases } from "../shared/script";
import { getState, toast } from "./store";
import { glitch } from "./components/glitch-stage";

export interface ProdState {
  marker: number; take: number; recording: boolean; keysRunning: boolean; keysEntryId: string | null; keysStep: number;
  devPos: "home" | "left" | "hidden"; speakingId: string | null; outroPhase: number;
  sendKeys: boolean; improvise: boolean;
}
export interface LogEvent { t: number; kind: string; [k: string]: any }

class Production {
  st: ProdState = { marker: -1, take: 1, recording: false, keysRunning: false, keysEntryId: null, keysStep: 0, devPos: "home", speakingId: null, outroPhase: -1, sendKeys: true, improvise: false };
  private history: number[] = [];
  private keysTriggered = new Set<string>();
  private keysRunningEnd = 0;
  private keysDone: Promise<void> = Promise.resolve();
  private audio: HTMLAudioElement | null = null;
  private cueTimers: number[] = [];
  private subs = new Set<() => void>();
  private recStart = 0;
  private sessionDir: string | null = null;
  private lineCounter = 0;
  private keepAlive: AudioContext | null = null;

  subscribe(f: () => void) { this.subs.add(f); return () => { this.subs.delete(f); }; }
  private emit() { for (const f of this.subs) f(); }
  private set(p: Partial<ProdState>) { this.st = { ...this.st, ...p }; this.emit(); }

  constructor() {
    window.studio.on("keys:progress", ({ entryId, step }: any) => { if (this.st.keysEntryId === entryId) this.set({ keysStep: step }); });
  }

  clockText() {
    if (!this.st.recording) return "00:00.0";
    const ms = Date.now() - this.recStart, s = Math.floor(ms / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}.${Math.floor((ms % 1000) / 100)}`;
  }

  log(kind: string, data: Record<string, any> = {}) {
    const ev: LogEvent = { t: Date.now(), kind, marker: this.st.marker, take: this.st.take, ...data };
    if (this.st.recording) window.studio.invoke("session:event", ev);
  }

  // ── transport ──────────────────────────────────────────────────────────────
  reset() {
    this.stopAll();
    this.history = []; this.keysTriggered.clear();
    this.set({ marker: -1, take: this.st.recording ? this.st.take + 1 : 1, devPos: "home" });
    glitch.setMood("neutral"); glitch.slide(getState().config?.glitch?.homeY ?? 300, 300); glitch.slide("show", 300);
    this.log("reset");
  }

  rewind() {
    const prev = this.history.pop();
    if (prev == null) return;
    this.stopAll();
    this.set({ marker: prev, take: this.st.recording ? this.st.take + 1 : this.st.take });
    this.log("rewind", { to: prev });
  }

  stopAll() {
    this.outroToken++; if (this.st.outroPhase >= 0) this.set({ outroPhase: -1 });
    this.cancelSpeech();
    window.studio.invoke("keys:cancel");
  }

  private cancelSpeech() {
    for (const t of this.cueTimers) clearTimeout(t); this.cueTimers = [];
    if (this.audio) { this.audio.pause(); this.audio.src = ""; this.audio = null; }
    glitch.setTalking(false);
    this.set({ speakingId: null });
  }

  async advance() {
    const script = getState().script;
    const marker = nextMarker(script, this.st.marker);
    if (marker == null) { toast("End of script", "info"); return; }
    const old = this.st.marker;
    this.cancelSpeech();
    this.history.push(old);
    this.set({ marker });
    this.log("marker", { marker });
    const evs = entriesAt(script, marker);
    const waits: Promise<void>[] = [];
    const anyAuto = evs.some((e) => e.auto);
    let lineToSpeak: Entry | null = null;

    for (const e of evs) {
      if (e.type === "face") {
        const fire = () => { glitch.setMood(e.mood, e.hold); this.log("mood", { mood: e.mood, hold: e.hold ?? 0 }); };
        if (e.delay && e.delay > 0) {
          // Late reaction: hold the current face until `delay` has passed — e.g. Glitch keeps a straight
          // face while Dev reads the line that catches him out. The log records when it actually fired,
          // so the post render follows the same beat.
          waits.push(new Promise<void>((resolve) => this.cueTimers.push(window.setTimeout(() => { fire(); resolve(); }, e.delay))));
        } else fire();
      }
      else if (e.type === "slide") {
        if (e.actor === "Glitch") glitch.slide(e.to as any, e.over ?? 600);
        else this.set({ devPos: e.to === "hide" ? "hidden" : e.to === "left" ? "left" : "home" });
        this.log("slide", { actor: e.actor, to: e.to, over: e.over ?? 600 });
      }
      else if (e.type === "keys") {
        if (!this.keysTriggered.has(e.id)) {
          this.keysTriggered.add(e.id);
          this.keysRunningEnd = e.end;
          this.set({ keysRunning: true, keysEntryId: e.id, keysStep: 0 });
          this.log("keys-start", { entryId: e.id, steps: e.keystrokes.length });
          const p = window.studio.invoke("keys:run", { entryId: e.id, steps: e.keystrokes, speed: e.speed ?? 10, dryRun: !this.st.sendKeys })
            .catch((err: any) => toast(`Keys: ${err.message}`, "error"))
            .then(() => { this.set({ keysRunning: false }); this.log("keys-end", { entryId: e.id }); });
          this.keysDone = p; waits.push(p);
        }
      }
      else if (e.type === "line") lineToSpeak = e;
      else if (e.type === "outro") waits.push(this.runOutro(e));
    }

    if (lineToSpeak && lineToSpeak.type === "line") {
      const e = lineToSpeak;
      const cfg = getState().config;
      const mode = cfg?.actorModes?.[e.actor] ?? (e.actor === "Glitch" ? "read" : "skip");
      if (e.mood) { glitch.setMood(e.mood); this.log("mood", { mood: e.mood }); }
      if (mode === "read") {
        // block until running keys finish if the keys event ends at/before this marker (ported rule)
        const blocked = this.st.keysRunning && this.keysRunningEnd <= e.start;
        const p = (blocked ? this.keysDone : Promise.resolve()).then(() => this.speak(e));
        waits.push(p);
      } else {
        this.log("line-start", { entryId: e.id, actor: e.actor, text: cleanText(e.text), spoken: false });
        // Dev reads on camera: fire inline mood cues spread over an estimated reading time (~14 chars/sec)
        this.scheduleCues(e.text, Math.max(1500, cleanText(e.text).length / 14 * 1000));
      }
    }

    if (anyAuto) {
      const mine = marker;
      Promise.all(waits).then(() => { if (this.st.marker === mine) this.advance(); });
    }
  }

  /** Branded outro: Glitch reads each phase; the animation (rendered in post) follows the logged phase timings. */
  private async runOutro(e: Entry & { type: "outro" }) {
    const phases = outroPhases(e);
    const token = ++this.outroToken;
    this.set({ devPos: "hidden" });
    this.log("outro-start", { entryId: e.id, phases: phases.map((p) => ({ phase: p.phase, title: p.title, subtitle: p.subtitle, names: p.names })) });
    await new Promise((r) => setTimeout(r, 1000)); // panels slam in
    for (let i = 0; i < phases.length; i++) {
      if (this.outroToken !== token) return;
      const p = phases[i]; const t0 = Date.now();
      this.log("outro-phase", { phase: p.phase, index: i, title: p.title, subtitle: p.subtitle, names: p.names, minMs: p.minMs });
      glitch.setMood(p.mood); this.log("mood", { mood: p.mood });
      this.set({ outroPhase: i });
      if (p.text) await this.speak({ id: `${e.id}:${p.phase}`, type: "line", actor: "Glitch", text: p.text, start: e.start, end: e.end });
      const left = p.minMs - (Date.now() - t0);
      if (left > 0) await new Promise((r) => setTimeout(r, left));
      if (this.outroToken !== token) return;
    }
    await new Promise((r) => setTimeout(r, 1300)); // ripple out
    this.log("outro-end", { entryId: e.id });
    this.set({ outroPhase: -1 });
  }
  private outroToken = 0;

  private scheduleCues(text: string, durationMs: number) {
    const { clean, cues } = splitMoodTags(text);
    for (const c of cues) {
      const at = clean.length ? (c.charIndex / clean.length) * durationMs : 0;
      this.cueTimers.push(window.setTimeout(() => { glitch.setMood(c.mood); this.log("mood", { mood: c.mood }); }, at));
    }
  }

  private async speak(e: Entry & { type: "line" }): Promise<void> {
    const cfg = getState().config;
    const voice = cfg?.voices?.[e.actor] ?? "am_puck";
    const text = cleanText(e.text);
    const name = `${String(++this.lineCounter).padStart(4, "0")}-${e.actor}-${e.start}`;
    this.wakeAudio(); // before the synth round-trip, so the sink is up by the time we play
    this.set({ speakingId: e.id });
    let res: { audio: string; path?: string; duration?: number };
    try { res = await window.studio.invoke("tts:speak", { text, voice, name, save: this.st.recording }); }
    catch (err: any) { toast(`TTS: ${err.message}`, "error"); this.set({ speakingId: null }); return; }
    if (this.st.speakingId !== e.id) return; // cancelled meanwhile
    await new Promise<void>((resolve) => {
      const a = new Audio("data:audio/wav;base64," + res.audio);
      this.audio = a;
      // Log when sound actually starts, not when metadata decodes: post places this wav at the logged
      // timestamp, so it has to match the moment the room heard it.
      let started = false;
      const onStart = () => {
        if (started) return; started = true;
        const dur = isFinite(a.duration) ? a.duration * 1000 : (res.duration ?? 3000);
        this.log("line-start", { entryId: e.id, actor: e.actor, text, spoken: true, audio: res.path, duration: dur });
        if (e.actor === "Glitch") glitch.setTalking(true);
        this.scheduleCues(e.text, dur);
      };
      a.onplaying = onStart;
      a.onended = () => { onStart(); glitch.setTalking(false); this.log("line-end", { entryId: e.id }); if (this.audio === a) { this.audio = null; this.set({ speakingId: null }); } resolve(); };
      a.onerror = () => { glitch.setTalking(false); resolve(); };
      a.onpause = () => { if (a.ended) return; resolve(); };
      a.play().then(onStart).catch(() => resolve());
    });
  }

  /** Hold the audio sink open. WirePlumber suspends an idle node after 5s, and resuming an ALSA sink
   *  swallows the first couple hundred ms of the stream — while Kokoro's wavs open with only ~45ms of
   *  silence, so Glitch's first word gets clipped in the room after any pause. An inaudible tone keeps
   *  the node running. (The saved wav is intact and the cut is built from it, so this is monitoring only.) */
  private wakeAudio() {
    try {
      if (this.keepAlive) { if (this.keepAlive.state === "suspended") this.keepAlive.resume(); return; }
      const ctx = new AudioContext();
      const osc = ctx.createOscillator(), g = ctx.createGain();
      osc.frequency.value = 30; g.gain.value = 0.0001; // -80 dB: below the noise floor, but a real signal
      osc.connect(g).connect(ctx.destination); osc.start();
      this.keepAlive = ctx;
    } catch { /* no audio device: playback will fail loudly enough on its own */ }
  }

  setSendKeys(v: boolean) { this.set({ sendKeys: v }); }
  setImprovise(v: boolean) { this.set({ improvise: v }); }
  /** Manual mood from the palette: applied live and logged so the post render matches. */
  improviseMood(mood: string) { glitch.setMood(mood); this.log("mood", { mood, improvised: true }); }

  // ── recording ──────────────────────────────────────────────────────────────
  async startRecording() {
    const { scriptPath } = getState();
    if (!scriptPath) { toast("Open a script first", "error"); return; }
    try {
      const r = await window.studio.invoke("session:start", { scriptPath });
      this.sessionDir = r.dir; this.recStart = r.startedAt;
      this.wakeAudio();
      this.lineCounter = 0;
      this.set({ recording: true, take: 1 });
      this.log("session-start", { scriptPath, marker: this.st.marker });
      toast(`Recording → ${r.dir.split("/").slice(-2).join("/")}`, "ok");
    } catch (e: any) { toast(`Record: ${e.message}`, "error"); }
  }
  async stopRecording() {
    try { await window.studio.invoke("session:stop"); } catch (e: any) { toast(`Stop: ${e.message}`, "error"); }
    this.log("session-stop");
    this.set({ recording: false });
    this.sessionDir = null;
  }
}

export const production = new Production();
export function useProduction(): ProdState {
  const [, force] = useState(0);
  useEffect(() => production.subscribe(() => force((n) => n + 1)), []);
  return production.st;
}
