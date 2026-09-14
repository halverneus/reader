// Build a .kdenlive project from a session: desktop + Dev (alpha) + Glitch (alpha) + voice, cut by takes.
// Layout mirrors the hand-made episodes: thumbnail flash, cold open with Dev full-frame, intro, lesson with watermark + music.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { loadConfig, type Config } from "../config";
import { parseScript, cleanText, entriesAt } from "../../shared/script";
import { ffprobeJson, rmsEnvelope, percentileDb } from "./exec";
import { findCam, findDesktop } from "./matte";
import { outroSpan } from "./outro-render";
import type { Log } from "./pipeline";

const FPS = 60;
const fr = (s: number) => Math.round(s * FPS);                       // seconds → frames
const tc = (frames: number) => { const s = Math.max(0, frames) / FPS; const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60; return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${sec.toFixed(3).padStart(6, "0")}`; };
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ── branding timing ──────────────────────────────────────────────────────────
// intro_merged.webm has alpha: clear until 1.0 s, opaque 2.0–10.25 s, clear again by 11.25 s. The video under it keeps
// playing through both transitions, so the cut is hidden. Seconds are relative to the intro clip's start.
const INTRO = { prevSpeechEndsAt: 0.5, prevPlaysUntil: 2.0, nextVideoBy: 10.0, nextSpeechAt: 12.0, clearAt: 11.25 };
const AFTER_INTRO = 5.0;           // watermark + music start this long after the intro has cleared
const COLD_OPEN_FIRST_WORD = 2.067; // the thumbnail finishes fading at 1.567 s; the first word follows 0.5 s later
// watermark.webm (80 s): start-up, a stretch that loops back-to-back, trail-off ending in a 0.5 s fade.
// Cut points copied from the hand-edited episodes (S09E03, S11E03, S11E04), in frames.
const WM = { startIn: 0, startLen: 325, loopIn: 325, loopLen: 4046, trailIn: 4371, trailLen: 429, fade: 30 };
const WM_LOOPS = [3, 5];            // loops per run before it trails off
const WM_REST = [15, 45];           // seconds without a watermark between runs
// the outro (alpha) starts as the last spoken line ends, over 1 s of the lesson still playing
const OUTRO = { videoRunOn: 1.0, fadeOut: 0.5, musicFade: 6.0 };
const MUSIC_DB = -16, MUSIC_FADE_IN = 5.55;

// ── take resolution ──────────────────────────────────────────────────────────
export interface Segment { marker: number; take: number; t0: number; t1: number; markers: number[] } // seconds since record start (desktop clock)
export function resolveSegments(session: any): Segment[] {
  const t0 = session.meta.startedAt;
  const rel = (t: number) => (t - t0) / 1000;
  const evs = [...session.events].sort((a: any, b: any) => a.t - b.t);
  const end = rel(session.meta.stoppedAt ?? evs.at(-1)?.t ?? t0);
  const segs: Segment[] = [];
  let cur: Segment | null = null;
  const close = (t: number) => { if (cur && t > cur.t0 + 0.05) segs.push({ ...cur, t1: t }); cur = null; };
  for (const e of evs) {
    if (e.kind === "marker") { close(rel(e.t)); cur = { marker: e.marker, take: e.take, t0: rel(e.t), t1: end, markers: [e.marker] }; }
    else if (e.kind === "rewind" || e.kind === "reset" || e.kind === "session-stop") close(rel(e.t));
  }
  close(end);
  // latest take per marker, ordered by marker
  const latest = new Map<number, Segment>();
  for (const s of segs) { const p = latest.get(s.marker); if (!p || s.t0 >= p.t0) latest.set(s.marker, s); }
  const out = [...latest.values()].sort((a, b) => a.marker - b.marker);
  // merge source-contiguous neighbours
  const merged: Segment[] = [];
  for (const s of out) { const l = merged.at(-1); if (l && Math.abs(l.t1 - s.t0) < 0.02) { l.t1 = s.t1; l.markers.push(s.marker); } else merged.push({ ...s, markers: [s.marker] }); }
  return merged;
}

// ── speech detection ─────────────────────────────────────────────────────────
type Span = [number, number];
/** Spoken spans in the mic file, shifted onto the desktop clock. A 100 ms window is speech when its RMS is well above
 *  the recording's own noise floor (breaths and chair creaks sit in between, so a fixed dB threshold misfires). */
async function micSpeech(file: string, micOffset: number): Promise<Span[]> {
  const frames = await rmsEnvelope(file);
  if (!frames.length) return [];
  const threshold = Math.min(-36, Math.max(-48, percentileDb(frames, 0.1) + 18));
  const speech: Span[] = [];
  for (const [ft, v] of frames) {
    if (v < threshold) continue;
    const last = speech.at(-1);
    if (last && ft - last[1] <= 0.3) last[1] = ft + 0.1; else speech.push([ft, ft + 0.1]);
  }
  return speech.filter(([a, b]) => b - a >= 0.15).map(([a, b]) => [a - micOffset, b - micOffset]);
}
const lastSpeechEnd = (spans: Span[], from: number, to: number) => { const e = spans.filter(([a, b]) => a < to && b > from).map(([, b]) => Math.min(b, to)); return e.length ? Math.max(...e) : undefined; };
const firstSpeechStart = (spans: Span[], from: number, to: number) => { const s = spans.filter(([a, b]) => b > from && a < to).map(([a]) => Math.max(a, from)); return s.length ? Math.min(...s) : undefined; };

// ── project model ────────────────────────────────────────────────────────────
interface Clip { id: number; kind: "av" | "video" | "audio" | "image"; file: string; name: string; frames: number; hasAudio: boolean; hasVideo: boolean }
interface Placed { clip: Clip; at: number; in: number; len: number; speed?: number; filters?: string[] } // frames
interface Track { name: string; audio: boolean; items: Placed[] }
type TrackKey = "muA" | "ovA" | "devA" | "glA" | "bgV" | "glV" | "devV" | "faceV" | "ovV";
const ORDER: TrackKey[] = ["muA", "ovA", "devA", "glA", "bgV", "glV", "devV", "faceV", "ovV"];

class Project {
  clips: Clip[] = []; nextId = 4; xml: string[] = []; producers: string[] = []; nProd = 0; nFilter = 0;
  guides: { comment: string; pos: number; type: number }[] = [];
  tracks: Record<TrackKey, Track> = {
    muA: { name: "Music", audio: true, items: [] }, ovA: { name: "Overlays", audio: true, items: [] }, devA: { name: "Dev", audio: true, items: [] }, glA: { name: "Glitch", audio: true, items: [] },
    bgV: { name: "Background", audio: false, items: [] }, glV: { name: "Glitch", audio: false, items: [] }, devV: { name: "Dev", audio: false, items: [] }, faceV: { name: "Glitch Face", audio: false, items: [] }, ovV: { name: "Overlays", audio: false, items: [] },
  };
  async addClip(file: string, kind: Clip["kind"], name = path.basename(file)): Promise<Clip> {
    const existing = this.clips.find((c) => c.file === file); if (existing) return existing;
    let frames = fr(5), hasAudio = false, hasVideo = kind !== "audio";
    if (kind !== "image") { const j = await ffprobeJson(file); frames = Math.max(1, fr(parseFloat(j.format?.duration ?? "0"))); hasAudio = j.streams?.some((s: any) => s.codec_type === "audio"); hasVideo = j.streams?.some((s: any) => s.codec_type === "video"); }
    const c: Clip = { id: this.nextId++, kind, file, name, frames, hasAudio, hasVideo }; this.clips.push(c); return c;
  }
  place(track: TrackKey, p: Placed) { if (p.len > 0) this.tracks[track].items.push(p); }
  end(): number { return Math.max(0, ...Object.values(this.tracks).flatMap((t) => t.items.map((i) => i.at + i.len))); }

  private chainXml(c: Clip, speed?: number): string {
    const id = speed ? `producer${++this.nProd}` : `chain_${c.id}`;
    const len = speed ? Math.round(c.frames / speed) : c.frames;
    const svc = c.kind === "image" ? "qimage" : speed ? "timewarp" : c.kind === "audio" ? "avformat" : "avformat-novalidate";
    const props: [string, string][] = [["length", c.kind === "image" ? tc(len) : String(len)], ["eof", "pause"], ["resource", speed ? `${speed}:${c.file}` : c.file], ["mlt_service", svc], ["kdenlive:id", String(c.id)], ["kdenlive:clipname", c.name], ["kdenlive:folderid", "-1"]];
    if (svc !== "qimage") { props.push(["seekable", "1"], ["audio_index", c.hasAudio ? (c.hasVideo ? "1" : "0") : "-1"], ["video_index", c.hasVideo ? "0" : "-1"], ["vstream", "0"], ["astream", "0"]); }
    if (c.kind === "image") props.push(["kdenlive:duration", tc(len)], ["ttl", "0"], ["aspect_ratio", "1"]);
    if (speed) props.push(["warp_speed", String(speed)], ["warp_resource", c.file], ["warp_pitch", "0"], ["set.test_audio", c.hasAudio ? "0" : "1"]);
    const tag = speed || c.kind === "image" ? "producer" : "chain";
    return `<${tag} id="${id}"${speed || c.kind === "image" ? ` in="${tc(0)}"` : ""} out="${tc(len - 1)}">\n${props.map(([k, v]) => `  <property name="${k}">${esc(v)}</property>`).join("\n")}\n</${tag}>`;
  }
  private playlistXml(id: string, t: Track, log: Log): string {
    const items = [...t.items].sort((a, b) => a.at - b.at);
    let pos = 0; const parts: string[] = [`<playlist id="${id}">`];
    if (t.audio) parts.push(`  <property name="kdenlive:audio_track">1</property>`);
    for (const it of items) {
      if (it.at > pos) parts.push(`  <blank length="${tc(it.at - pos)}"/>`);
      else if (it.at < pos) { log(`[project] warning: ${it.clip.name} overlaps the previous clip on ${t.name}${t.audio ? " (audio)" : ""} at ${tc(it.at)} — dropped\n`); continue; }
      let prod = `chain_${it.clip.id}`;
      if (it.speed) { this.producers.push(this.chainXml(it.clip, it.speed)); prod = `producer${this.nProd}`; }
      const filters = (it.filters ?? []).map((f) => f.replace(/FID/g, `filter${++this.nFilter}`));
      parts.push(`  <entry in="${tc(it.in)}" out="${tc(it.in + it.len - 1)}" producer="${prod}">\n   <property name="kdenlive:id">${it.clip.id}</property>${filters.length ? "\n" + filters.join("\n") : ""}\n  </entry>`);
      pos = it.at + it.len;
    }
    parts.push("</playlist>"); return parts.join("\n");
  }
  private tractorXml(id: string, t: Track, pl: [string, string]): string {
    const hide = t.audio ? "video" : "audio";
    return `<tractor id="${id}" in="${tc(0)}" out="${tc(this.end() - 1)}">\n${t.audio ? `  <property name="kdenlive:audio_track">1</property>\n` : ""}  <property name="kdenlive:trackheight">62</property>\n  <property name="kdenlive:timeline_active">1</property>\n  <property name="kdenlive:collapsed">0</property>\n  <property name="kdenlive:track_name">${esc(t.name)}</property>\n  <property name="kdenlive:thumbs_format"></property>\n  <property name="kdenlive:audio_rec"></property>\n  <track hide="${hide}" producer="${pl[0]}"/>\n  <track hide="${hide}" producer="${pl[1]}"/>\n</tractor>`;
  }
  toXml(log: Log): string {
    const total = this.end(); const uuid = `{${randomUUID()}}`; const docId = String(Date.now());
    const playlists: string[] = [], tractors: string[] = [];
    ORDER.forEach((k, i) => {
      const t = this.tracks[k]; const a = `playlist${i * 2}`, b = `playlist${i * 2 + 1}`;
      playlists.push(this.playlistXml(a, t, log), `<playlist id="${b}">${t.audio ? `\n  <property name="kdenlive:audio_track">1</property>\n` : ""}</playlist>`);
      tractors.push(this.tractorXml(`tractor${i}`, t, [a, b]));
    });
    const chains = this.clips.map((c) => this.chainXml(c));
    const transitions = ORDER.map((k, i) => this.tracks[k].audio
      ? `  <transition id="transition${i}">\n   <property name="a_track">0</property>\n   <property name="b_track">${i + 1}</property>\n   <property name="mlt_service">mix</property>\n   <property name="kdenlive_id">mix</property>\n   <property name="internal_added">237</property>\n   <property name="always_active">1</property>\n   <property name="accepts_blanks">1</property>\n   <property name="sum">1</property>\n  </transition>`
      : `  <transition id="transition${i}">\n   <property name="a_track">0</property>\n   <property name="b_track">${i + 1}</property>\n   <property name="compositing">0</property>\n   <property name="distort">0</property>\n   <property name="rotate_center">0</property>\n   <property name="mlt_service">qtblend</property>\n   <property name="kdenlive_id">qtblend</property>\n   <property name="internal_added">237</property>\n   <property name="always_active">1</property>\n  </transition>`);
    const guidesCategories = ["#9b59b6", "#3daee9", "#1abc9c", "#1cdc9a", "#c9ce3b", "#fdbc4b", "#f39c1f", "#f47750", "#da4453"].map((color, index) => ({ color, comment: ["Dialogue", "Keys", "Face", "Slide", "Note", "Take", "Intro", "Warning", "Camera froze"][index], index }));
    const nAudio = ORDER.filter((k) => this.tracks[k].audio).length;
    const seqId = `tractor${ORDER.length}`, projId = `tractor${ORDER.length + 1}`;
    const seq = `<tractor id="${seqId}" in="${tc(0)}" out="${tc(total - 1)}">
  <property name="kdenlive:duration">${tc(total)}</property>
  <property name="kdenlive:maxduration">${total}</property>
  <property name="kdenlive:clipname">Sequence 1</property>
  <property name="kdenlive:description"></property>
  <property name="kdenlive:uuid">${uuid}</property>
  <property name="kdenlive:producer_type">17</property>
  <property name="kdenlive:control_uuid">${uuid}</property>
  <property name="kdenlive:id">3</property>
  <property name="kdenlive:clip_type">0</property>
  <property name="kdenlive:folderid">2</property>
  <property name="kdenlive:sequenceproperties.activeTrack">${nAudio + 1}</property>
  <property name="kdenlive:sequenceproperties.audioTarget">${nAudio - 2}</property>
  <property name="kdenlive:sequenceproperties.disablepreview">0</property>
  <property name="kdenlive:sequenceproperties.documentuuid">${uuid}</property>
  <property name="kdenlive:sequenceproperties.hasAudio">1</property>
  <property name="kdenlive:sequenceproperties.hasVideo">1</property>
  <property name="kdenlive:sequenceproperties.position">0</property>
  <property name="kdenlive:sequenceproperties.scrollPos">0</property>
  <property name="kdenlive:sequenceproperties.tracks">${ORDER.length - nAudio}</property>
  <property name="kdenlive:sequenceproperties.tracksCount">${ORDER.length}</property>
  <property name="kdenlive:sequenceproperties.verticalzoom">1</property>
  <property name="kdenlive:sequenceproperties.videoTarget">${nAudio + 1}</property>
  <property name="kdenlive:sequenceproperties.zonein">0</property>
  <property name="kdenlive:sequenceproperties.zoneout">60</property>
  <property name="kdenlive:sequenceproperties.zoom">8</property>
  <property name="kdenlive:sequenceproperties.groups">[]</property>
  <property name="kdenlive:sequenceproperties.guides">${esc(JSON.stringify(this.guides.map((g) => ({ comment: g.comment, duration: 0, pos: g.pos, type: g.type })), null, 1))}</property>
  <track producer="producer0"/>
${ORDER.map((_, i) => `  <track producer="tractor${i}"/>`).join("\n")}
${transitions.join("\n")}
</tractor>`;
    const doc = (k: string, v: string) => `  <property name="kdenlive:docproperties.${k}">${esc(v)}</property>`;
    const mainBin = `<playlist id="main_bin">
  <property name="kdenlive:folder.-1.2">Sequences</property>
  <property name="kdenlive:sequenceFolder">2</property>
${doc("activetimeline", uuid)}
${doc("audioChannels", "2")}
${doc("binsort", "0")}
${doc("documentid", docId)}
${doc("enableTimelineZone", "0")}
${doc("enableproxy", "0")}
${doc("generateimageproxy", "0")}
${doc("generateproxy", "0")}
${doc("guidesCategories", JSON.stringify(guidesCategories, null, 1))}
${doc("kdenliveversion", "26.04.1")}
${doc("opensequences", uuid)}
${doc("profile", "atsc_1080p_60")}
${doc("proxyextension", "mkv")}
${doc("proxyimageminsize", "2000")}
${doc("proxyimagesize", "800")}
${doc("proxyminsize", "1000")}
${doc("proxyresize", "640")}
${doc("seekOffset", "30000")}
${doc("uuid", uuid)}
${doc("version", "1.1")}
  <property name="kdenlive:documentnotes"></property>
  <property name="xml_retain">1</property>
${this.clips.map((c) => `  <entry in="${tc(0)}" out="${tc(c.frames - 1)}" producer="chain_${c.id}"/>`).join("\n")}
  <entry in="${tc(0)}" out="${tc(total - 1)}" producer="${seqId}"/>
</playlist>`;
    return `<?xml version='1.0' encoding='utf-8'?>
<mlt LC_NUMERIC="C" producer="main_bin" version="7.41.0" root="/">
 <profile colorspace="709" description="HD 1080p 60 fps" display_aspect_den="9" display_aspect_num="16" frame_rate_den="1" frame_rate_num="60" height="1080" progressive="1" sample_aspect_den="1" sample_aspect_num="1" width="1920"/>
${chains.join("\n")}
${this.producers.join("\n")}
<producer id="producer0" in="${tc(0)}" out="${tc(total - 1)}">
  <property name="length">2147483647</property>
  <property name="eof">continue</property>
  <property name="resource">black</property>
  <property name="aspect_ratio">1</property>
  <property name="mlt_service">color</property>
  <property name="kdenlive:playlistid">black_track</property>
  <property name="mlt_image_format">rgba</property>
  <property name="set.test_audio">0</property>
</producer>
${playlists.join("\n")}
${tractors.join("\n")}
${mainBin}
${seq}
<tractor id="${projId}" in="${tc(0)}" out="${tc(total - 1)}">
  <property name="kdenlive:projectTractor">1</property>
  <track in="${tc(0)}" out="${tc(total - 1)}" producer="${seqId}"/>
</tractor>
</mlt>
`;
  }
}

// ── filters (in/out are in the clip's own time, i.e. relative to the entry's in-point source) ──
const fadeToBlack = (at: number, len: number) => `   <filter id="FID" in="${tc(at)}" out="${tc(at + len - 1)}">\n    <property name="start">1</property>\n    <property name="level">1</property>\n    <property name="mlt_service">brightness</property>\n    <property name="kdenlive_id">fade_to_black</property>\n    <property name="alpha">${tc(0)}=1;${tc(len - 1)}=0</property>\n   </filter>`;
const chromaFilter = (at: number, key: { color: string; similarity: number }) => `   <filter id="FID">\n    <property name="key">${tc(at)}=0x${key.color.replace("#", "").toLowerCase().padEnd(6, "0")}ff</property>\n    <property name="variance">${tc(at)}=${key.similarity}</property>\n    <property name="mlt_service">chroma</property>\n    <property name="kdenlive_id">chroma</property>\n    <property name="kdenlive:collapsed">1</property>\n   </filter>`;
const rectFilter = (keys: { at: number; x: number; y: number; w: number; h: number }[]) => `   <filter id="FID">\n    <property name="rotate_center">1</property>\n    <property name="mlt_service">qtblend</property>\n    <property name="kdenlive_id">qtblend</property>\n    <property name="compositing">0</property>\n    <property name="distort">0</property>\n    <property name="rect">${keys.map((k) => `${tc(k.at)}=${k.x} ${k.y} ${k.w} ${k.h} 1.000000`).join(";")}</property>\n    <property name="rotation">${tc(keys[0].at)}=0</property>\n    <property name="kdenlive:collapsed">1</property>\n   </filter>`;
const volumeFilter = (db: number) => `   <filter id="FID">\n    <property name="window">75</property>\n    <property name="max_gain">20dB</property>\n    <property name="level">${tc(0)}=${db}</property>\n    <property name="channel_mask">-1</property>\n    <property name="mlt_service">volume</property>\n    <property name="kdenlive_id">volume</property>\n   </filter>`;
const fadeIn = (len: number) => `   <filter id="FID" out="${tc(len - 1)}">\n    <property name="window">75</property>\n    <property name="max_gain">20dB</property>\n    <property name="channel_mask">-1</property>\n    <property name="mlt_service">volume</property>\n    <property name="kdenlive_id">fadein</property>\n    <property name="gain">0</property>\n    <property name="end">1</property>\n   </filter>`;
const fadeOut = (at: number, len: number) => `   <filter id="FID" in="${tc(at)}" out="${tc(at + len - 1)}">\n    <property name="window">75</property>\n    <property name="max_gain">20dB</property>\n    <property name="channel_mask">-1</property>\n    <property name="mlt_service">volume</property>\n    <property name="kdenlive_id">fadeout</property>\n    <property name="gain">1</property>\n    <property name="end">0</property>\n   </filter>`;

/** Watermark runs between `from` and `to` (frames): start-up, whole loops, trail-off with its fade, then a rest. */
function planWatermark(P: Project, clip: Clip, from: number, to: number, rnd: () => number) {
  let at = from;
  const pick = ([lo, hi]: number[]) => lo + Math.floor(rnd() * (hi - lo + 1));
  const minRun = WM.startLen + 2 * WM.loopLen + WM.trailLen; // no blink-and-gone runs after a rest
  while (to - at >= WM.startLen + WM.trailLen) {
    const room = to - at - WM.startLen - WM.trailLen;
    let loops = Math.min(Math.floor(room / WM.loopLen), pick(WM_LOOPS));
    // if another run couldn't follow after a rest, this is the last one: fill it with whole loops
    if (room - loops * WM.loopLen < fr(WM_REST[0]) + minRun) loops = Math.floor(room / WM.loopLen);
    P.place("ovV", { clip, at, in: WM.startIn, len: WM.startLen }); at += WM.startLen;
    for (let i = 0; i < loops; i++) { P.place("ovV", { clip, at, in: WM.loopIn, len: WM.loopLen }); at += WM.loopLen; }
    P.place("ovV", { clip, at, in: WM.trailIn, len: WM.trailLen, filters: [fadeToBlack(WM.trailIn + WM.trailLen - WM.fade, WM.fade)] }); at += WM.trailLen;
    const left = to - at;
    if (left < fr(WM_REST[0]) + minRun) break;
    at += Math.min(fr(WM_REST[0] + rnd() * (WM_REST[1] - WM_REST[0])), left - minRun);
  }
}
function seeded(key: string) {
  let h = 2166136261; for (const ch of key) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => { h += 0x6d2b79f5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ── thumbnail ────────────────────────────────────────────────────────────────
/** Session choice → last choice for the course → file named after the course → the first thumbnail. */
export function pickThumbnail(session: any, cfg: Config): string | undefined {
  const B = cfg.brandingDir; if (!fs.existsSync(B)) return undefined;
  const all = fs.readdirSync(B).filter((f) => /thumbnail/i.test(f) && /\.png$/i.test(f)).sort();
  const raw = (session.meta?.name ?? "").split(" / ")[0]?.trim() ?? "";
  const course = cfg.courseFolders?.[raw] || raw; // sessions recorded before a course was renamed still find their thumbnail
  const chosen = [session.meta?.thumbnail, cfg.courseThumbnails?.[course], cfg.courseThumbnails?.[raw]].find((f) => f && all.includes(f));
  if (chosen) return chosen;
  const key = courseKey(session.meta?.name ?? "").toLowerCase();
  return all.find((f) => course && f.toLowerCase().startsWith(course.toLowerCase() + " ")) ?? all.find((f) => key && f.toLowerCase().includes(key)) ?? all[0];
}

// ── build ────────────────────────────────────────────────────────────────────
interface Piece { seg: Segment; src0: number; src1: number; speed?: number; at: number } // src in desktop seconds, at in frames

export async function buildProject(dir: string, session: any, log: Log): Promise<string> {
  const cfg = loadConfig();
  const desktop = findDesktop(dir);
  if (!desktop) throw new Error("No desktop recording in session folder");
  const devAlpha = path.join(dir, "dev-alpha.webm");
  const cam = fs.existsSync(devAlpha) ? devAlpha : findCam(dir);
  const glitchFile = path.join(dir, "glitch.webm");
  const camOffset: number = session.meta.camOffset ?? 0;
  const scriptText = fs.existsSync(path.join(dir, "Script.yml")) ? fs.readFileSync(path.join(dir, "Script.yml"), "utf8") : "";
  const script = parseScript(scriptText).script;
  let segs = resolveSegments(session);
  const outro = outroSpan(session);
  const outroFile = path.join(dir, "outro.webm");
  if (outro) {
    // everything from the outro's start is replaced by the rendered outro clip
    segs = segs.map((s) => ({ ...s, t1: Math.min(s.t1, outro.t0) })).filter((s) => s.t1 > s.t0 + 0.05);
  }
  if (!segs.length && !outro) throw new Error("No takes found in session.json (did you press Next while recording?)");
  log(`[project] ${segs.length} segments after take resolution\n`);
  const P = new Project();
  const cDesk = await P.addClip(desktop, "av", "Desktop");
  const cCam = cam ? await P.addClip(cam, "av", cam === devAlpha ? "Dev (alpha)" : "Dev (cam)") : null;
  const cGlitch = fs.existsSync(glitchFile) ? await P.addClip(glitchFile, "video", "Glitch") : null;
  // GStreamer sessions record the mic on its own (mic.flac); it becomes Dev's audio instead of the cam file's
  // the cleaned mic (clean step) goes on the timeline; the raw one stays in the bin to swap back, and drives speech detection
  const micRaw: string | undefined = [session.meta.files?.mic, path.join(dir, "mic.flac")].find((f) => f && fs.existsSync(f));
  const micClean = path.join(dir, "mic-clean.flac");
  const micFile = cfg.audio?.denoise !== false && fs.existsSync(micClean) ? micClean : micRaw;
  const cMic = micFile ? await P.addClip(micFile, "audio", micFile === micClean ? "Mic (cleaned)" : "Mic") : null;
  if (cMic && micFile === micClean && micRaw) await P.addClip(micRaw, "audio", "Mic (raw)");
  const micOffset: number = session.meta.micOffset ?? 0;
  const B = cfg.brandingDir;
  const branding = async (f: string, kind: Clip["kind"], name: string) => (fs.existsSync(path.join(B, f)) ? P.addClip(path.join(B, f), kind, name) : null);
  const cIntro = await branding("intro_merged.webm", "av", "Intro");
  const cWater = await branding("watermark.webm", "video", "Watermark");
  const cMusic = await branding("music.wav", "audio", "Music");
  const thumbName = pickThumbnail(session, cfg);
  const cThumb = thumbName ? await P.addClip(path.join(B, thumbName), "image", "Thumbnail") : null;
  if (thumbName) log(`[project] thumbnail: ${thumbName}\n`);
  const cOut = outro && fs.existsSync(outroFile) ? await P.addClip(outroFile, "av", "Outro") : null;
  if (outro && !cOut) log("[project] outro.webm missing — run the Outro step; leaving the outro span out\n");

  const introMarker = script.entries.find((e) => e.type === "editor" && /roll\s*intro/i.test(e.text))?.start ?? -1;
  const evs = session.events; const t0 = session.meta.startedAt; const rel = (t: number) => (t - t0) / 1000;
  const recEnd = rel(session.meta.stoppedAt ?? evs.at(-1)?.t ?? t0);
  const voice = evs.filter((e: any) => e.kind === "line-start" && e.spoken && e.audio && fs.existsSync(e.audio));
  const freezes = evs.filter((e: any) => e.kind === "freeze");

  // who is talking when: the mic, plus Glitch's TTS lines
  const speech: Span[] = [...(micRaw ? await micSpeech(micRaw, micOffset) : []), ...voice.map((v: any): Span => [rel(v.t), rel(v.t) + (v.duration ?? 0) / 1000])];
  log(`[project] ${speech.length} speech spans\n`);

  // split segments at the intro marker so the intro can be inserted between takes
  const split: Segment[] = [];
  for (const s of segs) {
    const im = s.markers.find((m) => m >= introMarker && introMarker >= 0);
    if (im == null || im === s.markers[0]) { split.push(s); continue; }
    const at = (evs.filter((e: any) => e.kind === "marker" && e.marker === im && rel(e.t) > s.t0 && rel(e.t) < s.t1).map((e: any) => rel(e.t)).pop());
    if (at == null) { split.push(s); continue; }
    const i = s.markers.indexOf(im);
    split.push({ ...s, t1: at, markers: s.markers.slice(0, i) }, { ...s, marker: im, t0: at, markers: s.markers.slice(i) });
  }

  // speed up silent typing: keys-only markers (no dialogue) longer than 4 s
  const speedFor = (s: Segment) => {
    const lines = evs.filter((e: any) => e.kind === "line-start" && rel(e.t) >= s.t0 && rel(e.t) < s.t1);
    const keys = evs.filter((e: any) => e.kind === "keys-start" && rel(e.t) >= s.t0 && rel(e.t) < s.t1);
    const keysEnd = evs.find((e: any) => e.kind === "keys-end" && rel(e.t) > s.t0 && rel(e.t) <= s.t1 + 0.5);
    return !lines.length && keys.length && keysEnd && s.t1 - s.t0 > 4 ? Math.min(8, Math.max(1, +((s.t1 - s.t0) / 3).toFixed(3))) : undefined;
  };
  const pieces: Piece[] = split.map((s) => ({ seg: s, src0: s.t0, src1: s.t1, speed: speedFor(s), at: 0 }));
  const lenOf = (p: Piece) => Math.round(fr(p.src1 - p.src0) / (p.speed ?? 1));

  // the silent wait left for the intro is covered by the intro itself: drop it, so the lesson's first words set the timing
  const introIdx = introMarker >= 0 ? pieces.findIndex((p) => p.seg.marker >= introMarker) : -1;
  if (introIdx >= 0 && cIntro) {
    while (introIdx < pieces.length - 1 && !pieces[introIdx].speed && firstSpeechStart(speech, pieces[introIdx].seg.t0, pieces[introIdx].seg.t1) == null) {
      log(`[project] marker ${pieces[introIdx].seg.marker} (take ${pieces[introIdx].seg.take}) is silent — covered by the intro\n`);
      pieces.splice(introIdx, 1);
    }
  }

  // no dead air at the top: trim the wait before the first word so it lands just after the thumbnail fades
  const opener = pieces[0];
  if (opener && !opener.speed && !(cIntro && introMarker >= 0 && opener.seg.marker >= introMarker)) {
    const word = firstSpeechStart(speech, opener.seg.t0, opener.seg.t1);
    if (word != null) {
      opener.src0 = Math.max(0, word - (COLD_OPEN_FIRST_WORD - 1.0));
      log(`[project] first word at ${word.toFixed(2)} s src → starts the video at ${opener.src0.toFixed(2)} s\n`);
    }
  }

  // ── layout: sequential takes, with the intro and outro laid over the cuts ──
  let cursor = fr(1.0), introAt = -1;
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    if (introAt < 0 && cIntro && introMarker >= 0 && p.seg.marker >= introMarker) {
      const prev = pieces[i - 1];
      if (prev && !prev.speed) {
        // the cold open's last word lands 0.5 s into the intro, and its picture keeps running under the intro for 2 s
        const end = lastSpeechEnd(speech, prev.src0, prev.seg.t1) ?? prev.src1;
        introAt = Math.max(prev.at, prev.at + fr(end - INTRO.prevSpeechEndsAt - prev.src0));
        prev.src1 = Math.min(recEnd, end - INTRO.prevSpeechEndsAt + INTRO.prevPlaysUntil);
      } else introAt = cursor;
      // the lesson is already playing under the intro's tail, and its first word lands 12 s in
      const start = p.speed ? p.src0 : firstSpeechStart(speech, p.seg.t0, p.seg.t1) ?? p.seg.t0;
      p.src0 = Math.max(0, start - (INTRO.nextSpeechAt - INTRO.nextVideoBy));
      p.at = introAt + fr(INTRO.nextSpeechAt) - fr(start - p.src0);
      log(`[project] intro at ${tc(introAt)}: cold open ends ${(lastSpeechEnd(speech, prev?.src0 ?? 0, prev?.seg.t1 ?? 0) ?? 0).toFixed(2)} s src, lesson speech starts ${start.toFixed(2)} s src\n`);
    } else p.at = cursor;
    cursor = p.at + lenOf(p);
  }
  let outroAt = -1;
  if (cOut && outro) {
    const last = pieces.at(-1);
    if (last && !last.speed) {
      // the outro starts as the last word ends ("Do it!"), with the lesson running on under its transition
      const end = Math.min(lastSpeechEnd(speech, last.src0, outro.t0 + 0.25) ?? last.src1, last.src1 + 0.25);
      outroAt = last.at + Math.max(0, fr(end - last.src0));
      last.src1 = Math.min(recEnd, end + OUTRO.videoRunOn);
      log(`[project] outro at ${tc(outroAt)}: last word ends ${end.toFixed(2)} s src\n`);
    } else outroAt = cursor;
  }

  // ── place ──
  if (cThumb) P.place("ovV", { clip: cThumb, at: 0, in: 0, len: fr(1.567), filters: [fadeToBlack(fr(1.067), fr(0.5))] });
  if (cIntro && introAt >= 0) {
    P.place("ovV", { clip: cIntro, at: introAt, in: 0, len: cIntro.frames });
    if (cIntro.hasAudio) P.place("ovA", { clip: cIntro, at: introAt, in: 0, len: cIntro.frames });
    P.guides.push({ comment: "Intro", pos: introAt, type: 6 });
  }
  const devRect = cfg.dev.rect;
  for (const p of pieces) {
    const s = p.seg, speed = p.speed, len = lenOf(p), at = p.at;
    const inOf = (t: number) => (speed ? Math.round(fr(t) / speed) : fr(t));
    const atOf = (t: number) => at + Math.round(fr(t - p.src0) / (speed ?? 1));
    P.place("glV", { clip: cDesk, at, in: inOf(p.src0), len, speed });
    if (cCam) {
      const inC = inOf(p.src0 + camOffset);
      const fullFrame = introMarker >= 0 && s.marker < introMarker; // cold open: Dev big
      const keys: { at: number; x: number; y: number; w: number; h: number }[] = fullFrame ? [] : [{ at: 0, ...devRect }];
      for (const e of evs.filter((e: any) => e.kind === "slide" && e.actor === "Dev" && rel(e.t) >= p.src0 && rel(e.t) < p.src1)) {
        const k = atOf(rel(e.t)) - at; const over = Math.max(1, fr((e.over ?? 600) / 1000));
        const to = e.to === "left" ? { x: cfg.dev.leftX, y: devRect.y } : e.to === "hide" ? { x: devRect.x, y: 1080 } : { x: devRect.x, y: devRect.y };
        const from = keys.at(-1) ?? { x: devRect.x, y: devRect.y };
        keys.push({ at: k, x: from.x, y: from.y, w: devRect.w, h: devRect.h }, { at: k + over, x: to.x, y: to.y, w: devRect.w, h: devRect.h });
      }
      const filters: string[] = []; if (cCam.file !== devAlpha) filters.push(chromaFilter(inC, cfg.capture.key)); if (keys.length) filters.push(rectFilter(keys.map((k) => ({ ...k, at: k.at + inC }))));
      if (inC >= 0) { P.place("devV", { clip: cCam, at, in: inC, len, speed, filters }); if (cCam.hasAudio && !cMic) P.place("devA", { clip: cCam, at, in: inC, len, speed }); }
    }
    if (cMic) {
      // no sound from before the take began (pre-roll under the intro may reach into an earlier take)
      const m0 = Math.max(p.src0, s.t0), mAt = atOf(m0), inM = inOf(m0 + micOffset);
      if (inM >= 0) P.place("devA", { clip: cMic, at: mAt, in: inM, len: at + len - mAt, speed });
    }
    if (cGlitch) P.place("faceV", { clip: cGlitch, at, in: inOf(p.src0), len, speed });
    for (const v of voice) {
      const t = rel(v.t); if (t < Math.max(p.src0, s.t0) || t >= p.src1) continue;
      const c = await P.addClip(v.audio, "audio", path.basename(v.audio));
      const vAt = atOf(t); const l = Math.min(c.frames, at + len - vAt);
      if (l > 0) P.place("glA", { clip: c, at: vAt, in: 0, len: l });
    }
    const gPos = atOf(Math.max(p.src0, s.t0));
    const first = entriesAt(script, s.marker).find((e) => e.type === "line") as any;
    P.guides.push({ comment: first ? `${first.actor}: ${cleanText(first.text).replace(/\n/g, " ").slice(0, 32)}` : `marker ${s.marker}`, pos: gPos, type: 0 });
    if (s.take > 1) P.guides.push({ comment: `take ${s.take}`, pos: gPos, type: 5 });
    for (const f of freezes) { const t = rel(f.t); if (t >= p.src0 && t < p.src1) P.guides.push({ comment: "camera froze here", pos: atOf(t), type: 8 }); }
    if (speed) P.guides.push({ comment: `typing ×${speed}`, pos: gPos, type: 1 });
  }
  if (cOut && outro) {
    // outro: full-frame branded clip (alpha) with its own sound design, fading out at the very end
    const fade = fr(OUTRO.fadeOut);
    P.place("ovV", { clip: cOut, at: outroAt, in: 0, len: cOut.frames, filters: [fadeToBlack(cOut.frames - fade, fade)] });
    if (cOut.hasAudio) P.place("ovA", { clip: cOut, at: outroAt, in: 0, len: cOut.frames, filters: [fadeOut(cOut.frames - fade, fade)] });
    for (const v of voice) { const t = rel(v.t); if (t < outro.t0 || t >= outro.t1) continue; const c = await P.addClip(v.audio, "audio", path.basename(v.audio)); const vAt = outroAt + fr(t - outro.t0); const l = Math.min(c.frames, outroAt + cOut.frames - vAt); if (l > 0) P.place("glA", { clip: c, at: vAt, in: 0, len: l }); }
    P.guides.push({ comment: "Outro", pos: outroAt, type: 6 });
  }
  const total = P.end();

  // watermark + music: from 5 s after the intro clears; the watermark stops before the outro, the music runs to the end
  const lessonStart = introAt >= 0 ? introAt + fr(INTRO.clearAt + AFTER_INTRO) : fr(1);
  const waterEnd = outroAt >= 0 ? outroAt : total - fr(1);
  if (cWater && cWater.frames >= WM.trailIn + WM.trailLen) planWatermark(P, cWater, lessonStart, waterEnd, seeded(session.meta.name ?? dir));
  if (cMusic && cMusic.frames > 0) {
    const fadeLen = fr(OUTRO.musicFade);
    for (let at = lessonStart; at < total; at += cMusic.frames) {
      const len = Math.min(cMusic.frames, total - at), filters = [volumeFilter(MUSIC_DB)];
      if (at === lessonStart) filters.push(fadeIn(fr(MUSIC_FADE_IN)));
      if (at + len >= total) filters.push(fadeOut(Math.max(0, len - fadeLen), Math.min(len, fadeLen)));
      P.place("muA", { clip: cMusic, at, in: 0, len, filters });
    }
  }
  // no outro: fade the lesson to black at the very end
  const last = P.tracks.glV.items.filter((i) => i.clip === cDesk).sort((a, b) => a.at - b.at).at(-1);
  if (last && !cOut) last.filters = [...(last.filters ?? []), fadeToBlack(last.in + last.len - fr(1), fr(1))];

  const xml = P.toXml(log);
  return writeProject(dir, session, xml, cfg, log);
}

// Every project the generator writes is remembered by content hash. A file at the target path whose hash isn't known
// was edited in Kdenlive (or made by hand), so it is never overwritten — regardless of which session built it.
const sha = (s: string | Buffer) => createHash("sha1").update(s).digest("hex");
const registryFile = () => path.join(loadConfig().projectsDir, ".metrik-generated.json");
function knownHashes(): Set<string> { try { return new Set(JSON.parse(fs.readFileSync(registryFile(), "utf8"))); } catch { return new Set(); } }
function rememberHash(h: string) { const s = knownHashes(); s.add(h); try { fs.writeFileSync(registryFile(), JSON.stringify([...s].slice(-500))); } catch {} }
/** true when the project at `file` is exactly what the generator wrote (safe to replace or delete without asking twice) */
export function projectUnedited(file: string, session?: any): boolean {
  if (!fs.existsSync(file)) return true;
  const h = sha(fs.readFileSync(file));
  return h === session?.meta?.projectHash || knownHashes().has(h);
}

/** Projects live in <projectsDir>/<course>/. A project edited since it was generated is never overwritten. */
function writeProject(dir: string, session: any, xml: string, cfg: Config, log: Log): string {
  const name = safeName(session.meta.name ?? path.basename(dir));
  const course = (session.meta.name ?? "").split(" / ")[0]?.trim() || "Misc";
  let out = process.env.METRIK_PROJECT_OUT || path.join(cfg.projectsDir, course, `${name}.kdenlive`);
  if (!process.env.METRIK_PROJECT_OUT && !projectUnedited(out, session)) {
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
    out = path.join(path.dirname(out), `${name} (rebuilt ${stamp}).kdenlive`);
    log(`[project] the existing project was edited in Kdenlive — keeping it, writing a new one\n`);
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, xml);
  log(`[project] wrote ${out}\n`);
  if (!process.env.METRIK_PROJECT_OUT) {
    session.meta.project = out; session.meta.projectHash = sha(xml); rememberHash(session.meta.projectHash);
    fs.writeFileSync(path.join(dir, "session.json"), JSON.stringify(session, null, 1));
  }
  return out;
}
const safeName = (s: string) => s.replace(/[\/\\:*?"<>|]/g, "-").replace(/\s+\/\s+/g, " - ").trim();
const courseKey = (name: string) => (name ?? "").split(" / ")[0]?.replace(/^CS\d+\s*-?\s*/, "").split(" ")[0] || "";
