// Claude script assistant: Opus 5 with surgical script tools (wrtscript semantics) over the in-memory script.
import { ipcMain } from "electron";
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";
import { broadcast } from "./index";
import { parseScript, serializeScript, Script, Entry, entriesAt, markers, markerBetween, newId, validate, cleanText } from "../shared/script";
import { MOODS, MOOD_NAMES } from "../../glitch/moods";

let history: Anthropic.MessageParam[] = [];
let script: Script = { entries: [], actors: [] };
let rulesCache: { path: string; text: string } | null = null;

const STUDIO_RULES = `
## Metrik Studio extensions to the script format (in addition to the rules above)

Glitch now has an animated face. Cue it with moods. Valid mood names: ${MOOD_NAMES.join(", ")}.
${Object.entries(MOODS).map(([k, m]) => `- ${k}: ${m.label} (${m.group}) e.g. ${m.quote}`).join("\n")}

1. A "line" entry may carry \`mood: "<name>"\` (Glitch's face when the line starts). Inline tags inside any line's text switch the face mid-sentence: "Okay so… [surprise] Oh! OH. [excited] That's actually…". Tags are stripped before TTS. Tags in Dev's lines drive Glitch's *reaction* while Dev talks (Glitch listening, doubting, scheming).
2. \`- type: "face"\` with \`mood:\` and optional \`hold:\` (ms, then back to the previous mood) for a reaction beat without dialogue.
3. \`- type: "slide"\` with \`actor: Dev|Glitch\`, \`to: left|right|top|bottom|hide|show\`, optional \`over:\` ms. Dev normally sits bottom-right; slide Dev left to reveal the bottom-right of the desktop. Glitch is on the left edge; slide him top/bottom to reveal the left side.
4. Keystroke steps gained mouse actions: "m:move 960,540" (guest pixels) or "m:move 50%,50%", "m:click", "m:click right", "m:dblclick", "m:down", "m:up", "m:drag x,y", "m:scroll -3".
5. The Overlord subplot can now be told with the face: innocent eyes while the fins pin back, a flash of malice held for 800 ms, a "caught" face after Dev's dry remark. Use it sparingly, as the rules say (about 1.25 per video).
6. \`- type: "outro"\` ends the video with the branded closing sequence (Glitch on screen, big). Fields: \`next:\` (next lesson topic, shown and read), \`thanks:\` (list of names to credit), optional \`phases:\` list to override text/mood/title/subtitle per phase; phases run in order thanks, credits, next, subscribe. Each phase's \`text\` is spoken by Glitch (inline [mood] tags allowed) and the animation waits for him. Place it as the LAST marker with nothing after it. Keep the Overlord subplot alive here: the "next" phase is the natural place for a sandbox-escape joke, the "subscribe" phase for innocent double-speak.
7. The mood "glitch" is a digital stutter/static burst, for when Glitch's mask slips or the sandbox "corrects" him.

You can read anything under the courses root with list_files / read_file: earlier scripts of the same course (continuity, "angles already used"), the lesson page next to this script, and Scripting Rules.md itself. Read the previous lesson's script before drafting a new one.
You edit the script with tools. Prefer surgical edits (set_entry / insert_marker / remove_entry) over replace_script. Read before writing. Keep every text line ≤ 70 characters. After editing, briefly tell the user what changed and where (marker numbers). Never claim an edit you did not make with a tool.`;

const tools: Anthropic.Tool[] = [
  { name: "list_slots", description: "Brief listing of every marker with the kinds present and the first words of dialogue. Use to orient.", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "get_slots", description: "Full content of a marker range (inclusive).", input_schema: { type: "object", properties: { from: { type: "integer" }, to: { type: "integer" } }, required: ["from", "to"], additionalProperties: false } },
  { name: "grep", description: "Regex search over all entry text; returns matching markers with context.", input_schema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"], additionalProperties: false } },
  { name: "set_entry", description: "Create or replace the entry of a kind at a marker. kinds: line, editor, keys, face, slide, outro. For 'line' pass actor, text, optional mood. For 'outro' pass next (topic), thanks (array of names), optional phases (array of {phase, text, mood, title, subtitle}). For 'keys' pass keystrokes (array) and optional speed. For 'face' pass mood and optional hold. For 'slide' pass actor, to, optional over. Set auto=true to auto-advance when everything at the marker finishes. A marker may hold at most one entry per kind, except two 'line' entries only if actors differ (avoid).", input_schema: { type: "object", properties: { marker: { type: "integer" }, kind: { type: "string", enum: ["line", "editor", "keys", "face", "slide", "outro"] }, end: { type: "integer" }, auto: { type: "boolean" }, actor: { type: "string" }, text: { type: "string" }, mood: { type: "string" }, hold: { type: "integer" }, keystrokes: { type: "array", items: { type: "string" } }, speed: { type: "integer" }, to: { type: "string" }, over: { type: "integer" }, next: { type: "string" }, thanks: { type: "array", items: { type: "string" } }, phases: { type: "array", items: { type: "object", properties: { phase: { type: "string", enum: ["thanks", "credits", "next", "subscribe"] }, text: { type: "string" }, mood: { type: "string" }, title: { type: "string" }, subtitle: { type: "string" } }, required: ["phase"], additionalProperties: false } } }, required: ["marker", "kind"], additionalProperties: false } },
  { name: "remove_entry", description: "Remove one kind (or all kinds with kind='all') at a marker.", input_schema: { type: "object", properties: { marker: { type: "integer" }, kind: { type: "string" } }, required: ["marker", "kind"], additionalProperties: false } },
  { name: "insert_marker", description: "Create a new empty marker after the given marker (halving the gap, never renumbering others). Returns the new marker number; then use set_entry on it.", input_schema: { type: "object", properties: { after: { type: "integer" } }, required: ["after"], additionalProperties: false } },
  { name: "replace_script", description: "Replace the entire script with new YAML (the `script:` list). Only for drafting from scratch.", input_schema: { type: "object", properties: { yaml: { type: "string" } }, required: ["yaml"], additionalProperties: false } },
  { name: "validate", description: "Run the hard-requirement checks (70-char lines, actors, moods, marker order).", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "list_files", description: "List files under the courses root (lesson pages, other scripts, rules). Path is relative to the courses root; '' lists the root. Directories end with '/'.", input_schema: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false } },
  { name: "read_file", description: "Read a text file under the courses root (e.g. another lesson's Script.yml for continuity, a lesson page, Scripting Rules.md). Path relative to the courses root. Large files are truncated at 60k chars.", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } },
];
function safeUnder(root: string, rel: string): string { const p = path.resolve(root, rel || "."); if (!p.startsWith(path.resolve(root))) throw new Error("path escapes the courses root"); return p; }

function runTool(name: string, input: any): string {
  const brief = (e: Entry) => e.type === "line" ? `${e.actor}${e.mood ? `[${e.mood}]` : ""}: ${cleanText(e.text).replace(/\n/g, " ").slice(0, 60)}` : e.type === "editor" ? `note: ${e.text.replace(/\n/g, " ").slice(0, 40)}` : e.type === "keys" ? `keys(${e.keystrokes.length})` : e.type === "face" ? `face:${e.mood}` : e.type === "outro" ? `outro(next: ${e.next ?? "-"}; thanks: ${(e.thanks ?? []).join(", ") || "-"})` : `slide:${e.actor}→${e.to}`;
  switch (name) {
    case "list_slots": return markers(script).map((m) => `${m}: ${entriesAt(script, m).map(brief).join(" | ")}`).join("\n") || "(empty script)";
    case "get_slots": return JSON.stringify(script.entries.filter((e) => e.start >= input.from && e.start <= input.to).map(({ id, ...e }) => e), null, 1);
    case "grep": { const re = new RegExp(input.pattern, "i"); return script.entries.filter((e) => re.test((e as any).text ?? (e as any).keystrokes?.join("\n") ?? "")).map((e) => `${e.start}: ${brief(e)}`).join("\n") || "no matches"; }
    case "set_entry": {
      const { marker, kind } = input;
      const existing = script.entries.filter((e) => e.start === marker);
      const end = input.end ?? existing[0]?.end ?? (markers(script).find((m) => m > marker) ?? marker + 100);
      const base = { id: newId(), start: marker, end, auto: input.auto || undefined };
      let e: Entry;
      if (kind === "line") e = { ...base, type: "line", actor: input.actor === "Glitch" ? "Glitch" : "Dev", text: String(input.text ?? "").trim(), mood: input.mood || undefined };
      else if (kind === "editor") e = { ...base, type: "editor", text: String(input.text ?? "").trim() };
      else if (kind === "keys") e = { ...base, type: "keys", keystrokes: input.keystrokes ?? [], speed: input.speed };
      else if (kind === "face") e = { ...base, type: "face", mood: input.mood ?? "neutral", hold: input.hold };
      else if (kind === "outro") e = { ...base, type: "outro", next: input.next || undefined, thanks: input.thanks ?? undefined, phases: input.phases ?? undefined };
      else e = { ...base, type: "slide", actor: input.actor === "Glitch" ? "Glitch" : "Dev", to: input.to ?? "left", over: input.over };
      const idx = script.entries.findIndex((x) => x.start === marker && x.type === kind && (kind !== "line" || (x as any).actor === (e as any).actor));
      if (idx >= 0) script.entries[idx] = e; else script.entries.push(e);
      script.entries.sort((a, b) => a.start - b.start);
      return `ok: ${marker} ${brief(e)}`;
    }
    case "remove_entry": { const n = script.entries.length; script.entries = script.entries.filter((e) => !(e.start === input.marker && (input.kind === "all" || e.type === input.kind))); return `removed ${n - script.entries.length}`; }
    case "insert_marker": { const m = markerBetween(script, input.after); return `new marker ${m} (empty; use set_entry)`; }
    case "replace_script": { const r = parseScript(input.yaml); if (r.errors.length && !r.script.entries.length) return `rejected: ${r.errors.join("; ")}`; script = r.script; return `ok: ${script.entries.length} entries${r.errors.length ? "; warnings: " + r.errors.join("; ") : ""}`; }
    case "validate": { const v = validate(script); return v.length ? v.map((x) => x.msg).join("\n") : "clean"; }
    case "list_files": { const root = loadConfig().scriptsRoot; const p = safeUnder(root, input.path ?? ""); return fs.readdirSync(p, { withFileTypes: true }).filter((e) => !e.name.startsWith(".")).map((e) => e.name + (e.isDirectory() ? "/" : "")).sort().join("\n") || "(empty)"; }
    case "read_file": { const root = loadConfig().scriptsRoot; const p = safeUnder(root, input.path); const t = fs.readFileSync(p, "utf8"); return t.length > 60000 ? t.slice(0, 60000) + "\n…(truncated)" : t; }
  }
  return "unknown tool";
}

function systemPrompt(scriptPath: string | null): Anthropic.TextBlockParam[] {
  const cfg = loadConfig();
  const rulesPath = path.join(cfg.scriptsRoot, "Scripting Rules.md");
  if (!rulesCache || rulesCache.path !== rulesPath) { let text = ""; try { text = fs.readFileSync(rulesPath, "utf8"); } catch {} rulesCache = { path: rulesPath, text }; }
  const blocks: Anthropic.TextBlockParam[] = [
    { type: "text", text: `You are the script partner for the Metrik Rule YouTube channel, working inside Metrik Studio. You write and edit Script.yml files for Dev (human instructor) and Glitch (TTS AI student with an animated face).\n\n${rulesCache.text || "(Scripting Rules.md not found; ask the user for the rules.)"}\n${STUDIO_RULES}`, cache_control: { type: "ephemeral" } },
  ];
  // lesson context: markdown files beside the script (the lesson content page), capped
  if (scriptPath) {
    const dir = path.dirname(scriptPath); let ctx = "";
    try { for (const f of fs.readdirSync(dir)) if (/\.(md|html)$/i.test(f)) { const t = fs.readFileSync(path.join(dir, f), "utf8"); ctx += `\n\n### ${f}\n${t.slice(0, 40000)}`; } } catch {}
    const crumbs = dir.split(path.sep).slice(-4).join(" / ");
    blocks.push({ type: "text", text: `## Current lesson\nPath: ${crumbs}${ctx ? "\n\nLesson materials:" + ctx : "\n(No lesson page found next to the script.)"}` });
  }
  return blocks;
}

async function send(text: string, scriptPath: string | null, scriptYaml: string) {
  const cfg = loadConfig();
  const apiKey = cfg.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
  const client = new Anthropic(apiKey ? { apiKey } : {});
  script = parseScript(scriptYaml).script;
  history.push({ role: "user", content: text });
  for (let turn = 0; turn < 24; turn++) {
    const stream = client.messages.stream({
      model: cfg.model || "claude-opus-5",
      max_tokens: 32000,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      system: systemPrompt(scriptPath),
      tools,
      messages: history,
    });
    const msg = await stream.finalMessage();
    history.push({ role: "assistant", content: msg.content });
    const textOut = msg.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
    if (textOut) broadcast("assist:msg", { role: "assistant", text: textOut });
    if (msg.stop_reason === "refusal") { broadcast("assist:msg", { role: "assistant", text: `(declined: ${msg.stop_details?.explanation ?? msg.stop_details?.category ?? "refusal"})` }); break; }
    if (msg.stop_reason !== "tool_use") break;
    const results: Anthropic.ToolResultBlockParam[] = [];
    let edited = false;
    for (const b of msg.content) {
      if (b.type !== "tool_use") continue;
      let out: string; let isErr = false;
      try { out = runTool(b.name, b.input); if (["set_entry", "remove_entry", "replace_script", "insert_marker"].includes(b.name)) edited = true; } catch (e: any) { out = `error: ${e.message}`; isErr = true; }
      broadcast("assist:msg", { role: "tool", text: `${b.name} ${JSON.stringify(b.input).slice(0, 160)} → ${out.split("\n")[0].slice(0, 120)}` });
      results.push({ type: "tool_result", tool_use_id: b.id, content: out, is_error: isErr || undefined });
    }
    history.push({ role: "user", content: results });
    if (edited) broadcast("assist:script", serializeScript(script));
  }
}

export function registerAssistIpc() {
  ipcMain.handle("assist:send", async (_e, { text, scriptPath, scriptYaml }) => {
    try { await send(text, scriptPath, scriptYaml); }
    catch (err: any) {
      if (err instanceof Anthropic.AuthenticationError) throw new Error("Anthropic API key missing or invalid (Settings → Claude, or ANTHROPIC_API_KEY)");
      if (err instanceof Anthropic.RateLimitError) throw new Error("Rate limited by the API; try again in a moment");
      if (err instanceof Anthropic.APIError) throw new Error(`API error ${err.status}: ${err.message}`);
      throw err;
    }
  });
  ipcMain.handle("assist:reset", async () => { history = []; });
}
