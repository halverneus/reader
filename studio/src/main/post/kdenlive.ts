// Build a .kdenlive project from a session: desktop + Dev (alpha) + Glitch (alpha) + voice, cut by takes.
// Layout mirrors the hand-made episodes: thumbnail flash, cold open with Dev full-frame, intro, lesson with watermark + music.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../config";
import { parseScript, cleanText, entriesAt } from "../../shared/script";
import { ffprobeJson } from "./exec";
import { findCam, findDesktop } from "./matte";
import { outroSpan } from "./outro-render";
import type { Log } from "./pipeline";

const FPS = 60;
const fr = (s: number) => Math.round(s * FPS);                       // seconds → frames
const tc = (frames: number) => { const s = Math.max(0, frames) / FPS; const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60; return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${sec.toFixed(3).padStart(6, "0")}`; };
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

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

// ── project model ────────────────────────────────────────────────────────────
interface Clip { id: number; kind: "av" | "video" | "audio" | "image"; file: string; name: string; frames: number; hasAudio: boolean; hasVideo: boolean }
interface Placed { clip: Clip; at: number; in: number; len: number; speed?: number; filters?: string[] } // frames
interface Track { name: string; audio: boolean; items: Placed[] }

class Project {
  clips: Clip[] = []; nextId = 4; xml: string[] = []; producers: string[] = []; nProd = 0; nFilter = 0;
  guides: { comment: string; pos: number; type: number }[] = [];
  tracks: Record<"ovV" | "faceV" | "devV" | "glV" | "bgV" | "ovA" | "devA" | "glA", Track> = {
    ovA: { name: "Overlays", audio: true, items: [] }, devA: { name: "Dev", audio: true, items: [] }, glA: { name: "Glitch", audio: true, items: [] },
    bgV: { name: "Background", audio: false, items: [] }, glV: { name: "Glitch", audio: false, items: [] }, devV: { name: "Dev", audio: false, items: [] }, faceV: { name: "Glitch Face", audio: false, items: [] }, ovV: { name: "Overlays", audio: false, items: [] },
  };
  async addClip(file: string, kind: Clip["kind"], name = path.basename(file)): Promise<Clip> {
    const existing = this.clips.find((c) => c.file === file); if (existing) return existing;
    let frames = fr(5), hasAudio = false, hasVideo = kind !== "audio";
    if (kind !== "image") { const j = await ffprobeJson(file); frames = Math.max(1, fr(parseFloat(j.format?.duration ?? "0"))); hasAudio = j.streams?.some((s: any) => s.codec_type === "audio"); hasVideo = j.streams?.some((s: any) => s.codec_type === "video"); }
    const c: Clip = { id: this.nextId++, kind, file, name, frames, hasAudio, hasVideo }; this.clips.push(c); return c;
  }
  place(track: keyof Project["tracks"], p: Placed) { this.tracks[track].items.push(p); }
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
  private playlistXml(id: string, t: Track): string {
    const items = [...t.items].sort((a, b) => a.at - b.at);
    let pos = 0; const parts: string[] = [`<playlist id="${id}">`];
    if (t.audio) parts.push(`  <property name="kdenlive:audio_track">1</property>`);
    for (const it of items) {
      if (it.at > pos) parts.push(`  <blank length="${tc(it.at - pos)}"/>`);
      else if (it.at < pos) { continue; } // overlap: skip (shouldn't happen)
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
  toXml(): string {
    const total = this.end(); const uuid = `{${randomUUID()}}`; const docId = String(Date.now());
    const order: (keyof Project["tracks"])[] = ["ovA", "devA", "glA", "bgV", "glV", "devV", "faceV", "ovV"];
    const playlists: string[] = [], tractors: string[] = [];
    order.forEach((k, i) => {
      const t = this.tracks[k]; const a = `playlist${i * 2}`, b = `playlist${i * 2 + 1}`;
      playlists.push(this.playlistXml(a, t), `<playlist id="${b}">${t.audio ? `\n  <property name="kdenlive:audio_track">1</property>\n` : ""}</playlist>`);
      tractors.push(this.tractorXml(`tractor${i}`, t, [a, b]));
    });
    const chains = this.clips.map((c) => this.chainXml(c));
    const transitions = order.map((k, i) => this.tracks[k].audio
      ? `  <transition id="transition${i}">\n   <property name="a_track">0</property>\n   <property name="b_track">${i + 1}</property>\n   <property name="mlt_service">mix</property>\n   <property name="kdenlive_id">mix</property>\n   <property name="internal_added">237</property>\n   <property name="always_active">1</property>\n   <property name="accepts_blanks">1</property>\n   <property name="sum">1</property>\n  </transition>`
      : `  <transition id="transition${i}">\n   <property name="a_track">0</property>\n   <property name="b_track">${i + 1}</property>\n   <property name="compositing">0</property>\n   <property name="distort">0</property>\n   <property name="rotate_center">0</property>\n   <property name="mlt_service">qtblend</property>\n   <property name="kdenlive_id">qtblend</property>\n   <property name="internal_added">237</property>\n   <property name="always_active">1</property>\n  </transition>`);
    const guidesCategories = ["#9b59b6", "#3daee9", "#1abc9c", "#1cdc9a", "#c9ce3b", "#fdbc4b", "#f39c1f", "#f47750", "#da4453"].map((color, index) => ({ color, comment: ["Dialogue", "Keys", "Face", "Slide", "Note", "Take", "Intro", "Warning", "Camera froze"][index], index }));
    const seq = `<tractor id="tractor9" in="${tc(0)}" out="${tc(total - 1)}">
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
  <property name="kdenlive:sequenceproperties.activeTrack">5</property>
  <property name="kdenlive:sequenceproperties.audioTarget">1</property>
  <property name="kdenlive:sequenceproperties.disablepreview">0</property>
  <property name="kdenlive:sequenceproperties.documentuuid">${uuid}</property>
  <property name="kdenlive:sequenceproperties.hasAudio">1</property>
  <property name="kdenlive:sequenceproperties.hasVideo">1</property>
  <property name="kdenlive:sequenceproperties.position">0</property>
  <property name="kdenlive:sequenceproperties.scrollPos">0</property>
  <property name="kdenlive:sequenceproperties.tracks">5</property>
  <property name="kdenlive:sequenceproperties.tracksCount">8</property>
  <property name="kdenlive:sequenceproperties.verticalzoom">1</property>
  <property name="kdenlive:sequenceproperties.videoTarget">5</property>
  <property name="kdenlive:sequenceproperties.zonein">0</property>
  <property name="kdenlive:sequenceproperties.zoneout">60</property>
  <property name="kdenlive:sequenceproperties.zoom">8</property>
  <property name="kdenlive:sequenceproperties.groups">[]</property>
  <property name="kdenlive:sequenceproperties.guides">${esc(JSON.stringify(this.guides.map((g) => ({ comment: g.comment, duration: 0, pos: g.pos, type: g.type })), null, 1))}</property>
  <track producer="producer0"/>
${order.map((_, i) => `  <track producer="tractor${i}"/>`).join("\n")}
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
  <entry in="${tc(0)}" out="${tc(total - 1)}" producer="tractor9"/>
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
<tractor id="tractor10" in="${tc(0)}" out="${tc(total - 1)}">
  <property name="kdenlive:projectTractor">1</property>
  <track in="${tc(0)}" out="${tc(total - 1)}" producer="tractor9"/>
</tractor>
</mlt>
`;
  }
}

// ── filters ──────────────────────────────────────────────────────────────────
const fadeToBlack = (at: number, len: number) => `   <filter id="FID" in="${tc(at)}" out="${tc(at + len - 1)}">\n    <property name="start">1</property>\n    <property name="level">1</property>\n    <property name="mlt_service">brightness</property>\n    <property name="kdenlive_id">fade_to_black</property>\n    <property name="alpha">${tc(0)}=1;${tc(len - 1)}=0</property>\n   </filter>`;
const chromaFilter = (at: number) => `   <filter id="FID">\n    <property name="key">${tc(at)}=0x00ff01ff</property>\n    <property name="variance">${tc(at)}=0.4</property>\n    <property name="mlt_service">chroma</property>\n    <property name="kdenlive_id">chroma</property>\n    <property name="kdenlive:collapsed">1</property>\n   </filter>`;
const rectFilter = (keys: { at: number; x: number; y: number; w: number; h: number }[]) => `   <filter id="FID">\n    <property name="rotate_center">1</property>\n    <property name="mlt_service">qtblend</property>\n    <property name="kdenlive_id">qtblend</property>\n    <property name="compositing">0</property>\n    <property name="distort">0</property>\n    <property name="rect">${keys.map((k) => `${tc(k.at)}=${k.x} ${k.y} ${k.w} ${k.h} 1.000000`).join(";")}</property>\n    <property name="rotation">${tc(keys[0].at)}=0</property>\n    <property name="kdenlive:collapsed">1</property>\n   </filter>`;
const volumeFilter = (db: number) => `   <filter id="FID">\n    <property name="window">75</property>\n    <property name="max_gain">20dB</property>\n    <property name="level">${tc(0)}=${db}</property>\n    <property name="channel_mask">-1</property>\n    <property name="mlt_service">volume</property>\n    <property name="kdenlive_id">volume</property>\n   </filter>`;
const fadeIn = (len: number) => `   <filter id="FID" out="${tc(len - 1)}">\n    <property name="window">75</property>\n    <property name="max_gain">20dB</property>\n    <property name="channel_mask">-1</property>\n    <property name="mlt_service">volume</property>\n    <property name="kdenlive_id">fadein</property>\n    <property name="gain">0</property>\n    <property name="end">1</property>\n   </filter>`;

// ── build ────────────────────────────────────────────────────────────────────
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
  const B = cfg.brandingDir;
  const branding = async (f: string, kind: Clip["kind"], name: string) => (fs.existsSync(path.join(B, f)) ? P.addClip(path.join(B, f), kind, name) : null);
  const cIntro = await branding("intro_merged.webm", "av", "Intro");
  const cWater = await branding("watermark.webm", "video", "Watermark");
  const cMusic = await branding("music.wav", "audio", "Music");
  const thumbName = fs.existsSync(B) ? fs.readdirSync(B).find((f) => /thumbnail/i.test(f) && /\.png$/i.test(f) && new RegExp(courseKey(session.meta.name), "i").test(f)) ?? fs.readdirSync(B).find((f) => /thumbnail/i.test(f) && /\.png$/i.test(f)) : undefined;
  const cThumb = thumbName ? await P.addClip(path.join(B, thumbName), "image", "Thumbnail") : null;

  // where does the intro go? the marker whose editor note says "roll intro"
  const introMarker = script.entries.find((e) => e.type === "editor" && /roll\s*intro/i.test(e.text))?.start ?? -1;
  const evs = session.events; const t0 = session.meta.startedAt; const rel = (t: number) => (t - t0) / 1000;
  const voice = evs.filter((e: any) => e.kind === "line-start" && e.spoken && e.audio && fs.existsSync(e.audio));
  const freezes = evs.filter((e: any) => e.kind === "freeze");

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
  let cursor = 0; // timeline frames
  if (cThumb) { P.place("ovV", { clip: cThumb, at: 0, in: 0, len: fr(1.567), filters: [fadeToBlack(fr(1.067), fr(0.5))] }); }
  cursor = fr(1.0);
  let introDone = introMarker < 0;
  const devRect = cfg.dev.rect;
  for (const s of split) {
    if (!introDone && s.marker >= introMarker) {
      if (cIntro) { P.place("ovV", { clip: cIntro, at: cursor, in: 0, len: cIntro.frames }); P.place("ovA", { clip: cIntro, at: cursor, in: 0, len: cIntro.frames }); P.guides.push({ comment: "Intro", pos: cursor, type: 6 }); cursor += cIntro.frames; }
      introDone = true;
    }
    const segFrames = fr(s.t1 - s.t0);
    // speed up silent typing: keys-only markers (no dialogue at this marker) longer than 4 s
    const lines = evs.filter((e: any) => e.kind === "line-start" && rel(e.t) >= s.t0 && rel(e.t) < s.t1);
    const keys = evs.filter((e: any) => e.kind === "keys-start" && rel(e.t) >= s.t0 && rel(e.t) < s.t1);
    const keysEnd = evs.find((e: any) => e.kind === "keys-end" && rel(e.t) > s.t0 && rel(e.t) <= s.t1 + 0.5);
    let speed: number | undefined;
    if (!lines.length && keys.length && keysEnd && s.t1 - s.t0 > 4) speed = Math.min(8, Math.max(1, +((s.t1 - s.t0) / 3).toFixed(3)));
    const len = speed ? Math.round(segFrames / speed) : segFrames;
    const inDesk = speed ? Math.round(fr(s.t0) / speed) : fr(s.t0);
    P.place("glV", { clip: cDesk, at: cursor, in: inDesk, len, speed });
    if (cCam) {
      const inCam = fr(s.t0 + camOffset);
      const inC = speed ? Math.round(inCam / speed) : inCam;
      const fullFrame = !introDone || s.marker < introMarker; // cold open: Dev big
      const keys: { at: number; x: number; y: number; w: number; h: number }[] = fullFrame ? [] : [{ at: 0, ...devRect }];
      // Dev slides inside this segment
      for (const e of evs.filter((e: any) => e.kind === "slide" && e.actor === "Dev" && rel(e.t) >= s.t0 && rel(e.t) < s.t1)) {
        const at = Math.round(fr(rel(e.t) - s.t0) / (speed ?? 1)); const over = Math.max(1, fr((e.over ?? 600) / 1000));
        const to = e.to === "left" ? { x: cfg.dev.leftX, y: devRect.y } : e.to === "hide" ? { x: devRect.x, y: 1080 } : { x: devRect.x, y: devRect.y };
        const from = keys.at(-1) ?? { x: devRect.x, y: devRect.y };
        keys.push({ at, x: from.x, y: from.y, w: devRect.w, h: devRect.h }, { at: at + over, x: to.x, y: to.y, w: devRect.w, h: devRect.h });
      }
      const filters: string[] = []; if (cCam.file !== devAlpha) filters.push(chromaFilter(inC)); if (keys.length) filters.push(rectFilter(keys.map((k) => ({ ...k, at: k.at + inC }))));
      if (inC >= 0) { P.place("devV", { clip: cCam, at: cursor, in: inC, len, speed, filters }); if (cCam.hasAudio) P.place("devA", { clip: cCam, at: cursor, in: inC, len, speed }); }
    }
    if (cGlitch) P.place("faceV", { clip: cGlitch, at: cursor, in: speed ? Math.round(fr(s.t0) / speed) : fr(s.t0), len, speed });
    // voice lines that start inside this segment
    for (const v of voice) {
      const t = rel(v.t); if (t < s.t0 || t >= s.t1) continue;
      const c = await P.addClip(v.audio, "audio", path.basename(v.audio));
      const at = cursor + Math.round(fr(t - s.t0) / (speed ?? 1)); const l = Math.min(c.frames, cursor + len - at);
      if (l > 0) P.place("glA", { clip: c, at, in: 0, len: l });
    }
    // guides
    const first = entriesAt(script, s.marker).find((e) => e.type === "line") as any;
    const comment = first ? `${first.actor}: ${cleanText(first.text).replace(/\n/g, " ").slice(0, 32)}` : `marker ${s.marker}`;
    P.guides.push({ comment, pos: cursor, type: 0 });
    if (s.take > 1) P.guides.push({ comment: `take ${s.take}`, pos: cursor, type: 5 });
    for (const f of freezes) { const t = rel(f.t); if (t >= s.t0 && t < s.t1) P.guides.push({ comment: "camera froze here", pos: cursor + Math.round(fr(t - s.t0) / (speed ?? 1)), type: 8 }); }
    if (speed) P.guides.push({ comment: `typing ×${speed}`, pos: cursor, type: 1 });
    cursor += len;
  }
  // outro: full-frame branded clip with its own sound design; Glitch's outro lines on the Glitch audio track
  if (outro && fs.existsSync(outroFile)) {
    const cOut = await P.addClip(outroFile, "av", "Outro");
    P.place("ovV", { clip: cOut, at: cursor, in: 0, len: cOut.frames }); if (cOut.hasAudio) P.place("ovA", { clip: cOut, at: cursor, in: 0, len: cOut.frames });
    for (const v of voice) { const t = rel(v.t); if (t < outro.t0 || t >= outro.t1) continue; const c = await P.addClip(v.audio, "audio", path.basename(v.audio)); const at = cursor + fr(t - outro.t0); const l = Math.min(c.frames, cursor + cOut.frames - at); if (l > 0) P.place("glA", { clip: c, at, in: 0, len: l }); }
    P.guides.push({ comment: "Outro", pos: cursor, type: 6 });
    cursor += cOut.frames;
  } else if (outro) log("[project] outro.webm missing — run the Outro step; leaving the outro span out\n");
  // watermark + music from the intro to the end
  const lessonStart = P.guides.find((g) => g.type === 6)?.pos ?? fr(1);
  const total = cursor;
  const waterEnd = outro && fs.existsSync(outroFile) ? total - (P.clips.find((c) => c.file === outroFile)?.frames ?? 0) : total;
  if (cWater && cWater.frames > 0) { for (let at = lessonStart + (cIntro?.frames ?? 0); at < waterEnd; at += cWater.frames) P.place("ovV", { clip: cWater, at, in: 0, len: Math.min(cWater.frames, waterEnd - at) }); }
  if (cMusic && cMusic.frames > 0) { let first = true; for (let at = lessonStart + (cIntro?.frames ?? 0); at < total; at += cMusic.frames) { P.place("ovA", { clip: cMusic, at, in: 0, len: Math.min(cMusic.frames, total - at), filters: [volumeFilter(-16), ...(first ? [fadeIn(fr(5.55))] : [])] }); first = false; } }
  // fade out at the very end on the desktop track
  const last = P.tracks.glV.items.filter((i) => i.clip === cDesk).sort((a, b) => a.at - b.at).at(-1);
  if (last && !(outro && fs.existsSync(outroFile))) { last.filters = [...(last.filters ?? []), fadeToBlack(last.in + last.len - fr(1), fr(1))]; }

  const xml = P.toXml();
  const name = safeName(session.meta.name ?? path.basename(dir));
  const outSession = path.join(dir, `${name}.kdenlive`);
  fs.writeFileSync(outSession, xml);
  const course = (session.meta.name ?? "").split(" / ")[0]?.trim() || "Misc";
  const outProj = path.join(cfg.projectsDir, course, `${name}.kdenlive`);
  fs.mkdirSync(path.dirname(outProj), { recursive: true }); fs.copyFileSync(outSession, outProj);
  log(`[project] wrote ${outProj}\n`);
  return outProj;
}
const safeName = (s: string) => s.replace(/[\/\\:*?"<>|]/g, "-").replace(/\s+\/\s+/g, " - ").trim();
const courseKey = (name: string) => (name ?? "").split(" / ")[0]?.replace(/^CS\d+\s*-?\s*/, "").split(" ")[0] || "Thumbnail";
