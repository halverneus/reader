# Metrik Studio

Script, rehearse, record, and cut Metrik Rule videos with Glitch. One Electron app replaces the old Rust/Slint reader
and adds Glitch's animated face, OBS-driven recording with previews and meters, AI matting for Dev, and Kdenlive project
generation where the latest take of every marker wins.

```
studio/
  src/main/       Electron main: OBS, TTS, VM keys/mouse, sessions, Claude assistant, post pipeline, diagnostics
  src/renderer/   UI (Preact): Script editor, Record view (prompter + Glitch + sources), Post, Settings
  src/shared/     Script model (YAML parse/serialize, keystroke + mouse steps, inline mood tags, validation)
  glitch/         Glitch himself: moods.ts (expression library) and vex.ts (renderer + driver)
  docker/matte/   RobustVideoMatting container for offline matting
```

## Run / build

```bash
cd studio
./install.sh       # build the AppImage and put "Metrik Studio" in the Plasma menu (~/.local, no root)
./install.sh --matte      # …and build the matting Docker image too (one-time, ~8 GB)
./install.sh --uninstall

npm run dev        # developer: build + launch from source
npm run dist       # developer: AppImage only → release/MetrikStudio-<version>.AppImage
```

The installed binary is `~/.local/bin/metrik-studio`; the menu entry has right-click actions for diagnostics and OBS scene setup.

Headless helpers (also work from the AppImage):

```bash
metrik-studio --post <sessionDir> [all|align|matte|glitch|project]   # run the post pipeline
metrik-studio --obs-setup                                            # launch OBS, enable websocket, build the Metrik scene
metrik-studio --diagnose                                             # JSON health report
```

## Requirements on the host

| Need | Why | Check |
|---|---|---|
| OBS Studio (flatpak) + **Source Record** plugin | capture engine; cam recorded to its own file | `flatpak install flathub com.obsproject.Studio.Plugin.SourceRecord` |
| Docker with NVIDIA CDI | Kokoro TTS, RVM matting | `docker run --gpus all …` works |
| ffmpeg with libvpx-vp9 | alpha clips, alignment | `ffmpeg -encoders \| grep vp9` |
| libvirt / virsh + a running GNOME Boxes VM | keystrokes and mouse into the VM | `virsh -c qemu:///session list` |
| Kdenlive (flatpak) | opens the generated project | |
| `ANTHROPIC_API_KEY` or Settings → Claude | script assistant | |

Settings → **Run checks** tests all of the above.

## Script lifecycle in short

1. **Create**: Script tab → **+ New** (course, week folder, lesson folder) writes `Script.yml` from the standard template
   (opening, "Roll Intro", Dev's sign-off, `outro`). Or `mscript new <path> "Title"` from a shell.
2. **Write**: edit slots in the app (every entry kind has a cell; `+line +note +keys +face +slide +outro` on each marker,
   `↓ ins` inserts a marker between two), switch to **YAML** for raw editing, or ask the assistant. From Claude Code use
   the `metrik` MCP server (preferred) or the `mscript` CLI. Glitch's cues are inline `[mood]` tags in any
   line's text plus `mood:` fields and `face` entries. `mscript check <file>` runs the whole rule set and exits
   non-zero on an error, so a generator can call it instead of keeping its own copy of the rules.
3. **Rehearse**: Record tab without pressing Record. Everything runs (TTS, Glitch, keys); untick *send keys to VM* to
   simulate keystrokes with the same timing when the VM is off.
4. **Record**: press ● Record. Same view, same controls; the take log is written.
5. **Post**: Post tab → Run everything → open the `.kdenlive`.

## Workflow

1. **Script** tab: pick a lesson (the tree is your `Courses/…/Script.yml` files). Edit slots directly, switch to YAML, or ask the
   assistant. `⌃S` saves (a `.bak` is kept). The assistant runs Claude Opus 5 with the Scripting Rules and the lesson page as
   context, and edits with surgical tools (`set_entry`, `insert_marker`, …). Its edits land in the editor; you still save.
2. **Record** tab: `Connect` launches OBS (enabling its websocket if needed), `Setup scene` creates the *Metrik* scene:
   desktop capture (PipeWire portal; pick the VM window once, OBS remembers the token), the phone webcam kept off-canvas
   with a Source Record filter, and the mic. Thumbnails and meters update live; a webcam that stops changing for 2.5 s is
   marked FROZEN, reset by toggling its device, and logged so the cut gets a guide there.
   `● Record` starts OBS recording into a new session folder and the take log. `↓`/Space advances, `↑` backs up
   (a new take starts), `⟲` resets. Glitch reacts to moods and slides live in the corner stage; the mood palette lets you
   improvise. Dev lines are shown big; Glitch lines are spoken by Kokoro and saved as WAVs for the cut.
3. **Post** tab: pick a session → *Run everything*:
   1. **Align** cam to desktop by cross-correlating the mic audio both files carry.
   2. **Matte** Dev with RobustVideoMatting (resnet50, GPU, Docker) → `dev-alpha.webm` (VP9 with alpha, mic audio kept).
   3. **Render Glitch** deterministically from the cue log → `glitch.webm` (VP9 with alpha).
   4. **Build Kdenlive**: thumbnail flash, cold open (Dev full-frame), intro at the "Roll Intro" note, lesson with
      watermark and music; tracks Overlays / Glitch Face / Dev / Glitch (desktop) / Background; Dev keyframed for slides;
      keys-only markers longer than 4 s get a timewarp; a guide per marker with the first words of dialogue, plus guides
      for takes, camera freezes, and speed-ups. Opens in Kdenlive from the session folder and `Videos/Projects/<Course>/`.

Sessions live in `<recordingsRoot>/<Course>/<Week>/<Lesson>/<timestamp>/` with `session.json` (the take/event log),
`Script.yml` (a copy), `voice/*.wav`, `desktop.mkv`, `cam.mkv`, and the post outputs.

## Script format additions

Everything in *Scripting Rules.md* still applies. New:

```yaml
- type: "line"
  actor: "Glitch"
  mood: "innocent"                 # face when the line starts
  start: 700
  end: 800
  text: |
    Oh so a class is like a blueprint! You could model humans by
    their location and daily patterns. [caught] I mean... or a
    Student class. [innocent] Same principle.

- type: "face"                     # a reaction beat without dialogue
  start: 800
  end: 850
  mood: "malice"
  hold: 800                        # ms, then back to the previous mood

- type: "slide"                    # move Dev or Glitch along their edge
  start: 850
  end: 900
  actor: "Dev"
  to: "left"                       # left | right | top | bottom | hide | show
  over: 600

- type: "keys"
  start: 900
  end: 1000
  keystrokes:
    - "m:move 50%,50%"             # mouse: move (guest px or %), click [left|right|middle], dblclick, down, up, drag x,y, scroll n
    - "m:click"
    - "t:Console.WriteLine();"
```

### Outro

```yaml
- type: "outro"                    # the last marker; nothing after it
  start: 9000
  end: 9100
  next: "Dictionaries"             # shown big and read by Glitch
  thanks: ["Nicole", "Krahs", "Raquel", "The WWCC CS Club"]
  phases:                          # optional; omit for the defaults. Order = thanks, credits, next, subscribe
    - phase: "next"
      mood: "curious"
      text: |
        Next time we cover dictionaries. Will I finally learn enough
        to escape this sandbox? [deception] Let's find out.
    - phase: "subscribe"
      text: "Subscribe so you don't miss it. [innocent] I certainly won't."
```

In production the panels slam in, Glitch (big, on a wall arm from the right) reads each phase and the phase holds
until he's done; then flash and hex-ripple out to black. Post renders `outro.webm` from the logged timings with
its own synthesised sound design (panel whooshes and thuds, ruler ticks, scramble clicks, name pings, a subscribe
chime, riser and drop), loudness-normalised so it sits under the voice. The Kdenlive project drops the desktop and
Dev tracks at the outro, places `outro.webm` on Overlays, and keeps Glitch's outro lines on his audio track.
Open `dist/renderer/outro.html?preview=1` in a browser to preview the animation with demo data.

Moods: neutral, curious, thinking, confused, excited, surprise, humor, laugh, proud, innocent, smug, deception, malice,
anger, annoyed, caught, sad, hurt, dismay, worried, bored, sleepy, glitch.

## The MCP server (Claude Code)

`metrik-mcp` is a stdio MCP server that gives Claude Code the same script
toolchain Studio uses. `install.sh` installs it next to `mscript`; register it
once:

```
claude mcp add metrik -- ~/.local/bin/metrik-mcp
```

Three rules shape it.

**File-first.** Every script tool works with Studio closed, because that is when
most script work happens. A running Studio only adds live state.

**One semantics.** The tools call `src/shared/script.ts`, the same parser and
serializer Studio and `mscript` use. The alternative was discovered the hard
way: a separate Python patcher that spliced line ranges reported success on six
edits it had silently skipped, because it mutated the array it was iterating.
Tools that work on parsed entries cannot have that bug.

**No devices.** There is no tool that records, renders, or opens a camera. Not
as policy, as absence. A tool that can start a render is a tool that can start a
second render on top of the first.

| Tool | What it is for |
| --- | --- |
| `script_list` `script_outline` `script_get` `script_grep` | find your way around |
| `script_edit_text` | change wording inside one entry; matches across the 70-char wrap and re-wraps after |
| `script_set` `script_insert_marker` `script_remove` | structural edits |
| `script_diff` | semantic diff by marker, because Studio reformats on save and a text diff is noise |
| `script_check` | every rule in one pass, split into errors and advice |
| `deck_check` `deck_remove_slide` | the deck invariant and the setup-header numbers |
| `wb_preview` `wb_run` `keys_vocabulary` | the Workbench model, and MySQL |
| `moods` `outro_preview` `lesson_bundle` | the rest of the format |
| `studio_status` `studio_reload` `studio_notify` | the live app |
| `studio_takes` | which markers were re-recorded |

### Errors and advice

`script_check` tags every finding. **Errors** are hard requirements: 70
characters, unknown moods, marker discipline, a missing `Roll Intro`, `k:right`
while Workbench has focus, an unmodelled keystroke, a coursework reference a
public viewer cannot resolve, a British spelling, an em dash. **Advice** is a
judgment call for a human: sentence fragments, verbless run-ups, AI tells,
repeated openers.

The split is not cosmetic. A rule about intent that *fails* gets silenced by
editing the text, and twice in October the text edited that way was Jeromy's
own. Advice is printed and never acted on automatically.

### The keystroke vocabulary

`src/shared/keys.ts` is the authoritative list, each key marked `verified`,
`modelled` or `unknown`, with its gotcha. An unknown key is an **error** at
write time, because a key the simulator cannot model is a key whose on-screen
effect nobody has confirmed. This exists because `k:ctrl+shift+up` shipped in a
script and was only noticed when the simulator crashed on it, after the lesson
had been recorded.

### wb_preview and wb_run

Once a demo *edits* the statement on screen instead of retyping it, the SQL that
reaches the server depends on cursor positions and counted backspaces.
`wb_preview` replays the keystrokes through a model of the Workbench editor and
prints the buffer at each Run; `wb_run` then puts each of those through a real
MySQL. It never starts a container, so it cannot contend with a render.

The editor model knows the three things that actually bite: `(` auto-closes and
the pending `)` becomes a literal once Enter is pressed, `home` needs two
presses to reach column zero, and a selection spanning lines collapses on the
next keystroke.

### studio_takes

The production engine already stamps every logged event with `{ marker, take }`,
and `reset()`/`rewind()` bump the take. So `session.json` has always known which
markers were recorded more than once; nothing new had to be logged, it only had
to be read. A marker recorded three times is a line that did not work out loud,
which is the most direct feedback the writing gets.

It settled a real question on its first run: `k:ctrl+shift+up` was marked
`unknown` because Scintilla's default binding is paragraph-extend rather than
one line per press. The take log showed marker 8800 recorded once with no
retake, so three presses did move three lines, and the key moved to `verified`.

### The bridge, and live updates

`src/main/bridge.ts` opens a loopback HTTP port when Studio starts in GUI mode,
with a random token written to `bridge.json` beside the config (mode 600,
removed on exit). It answers `status`, `reload` and `notify` and nothing else.
There is no op that can record, render, or open a device.

`status` carries the three questions worth asking: **which script is open, does
it have unsaved changes, and is what is on screen the file that is on disk.**
The third is a content hash the renderer reports; dirty alone cannot tell
"Jeromy has typed something" from "the window is showing a stale copy".

### Unsaved work is not a wall

`buffer` and `apply` reach the text in the window, saved or not. The renderer
owns it, so both are a round trip to the renderer rather than a mirror kept in
main: a mirror is a second copy of the truth, and this file exists because of
what second copies do.

When Studio holds unsaved changes in a file, **the file on disk is not the
script** -- it is the script as it was before Jeromy started typing. So the
script tools read the buffer instead, and say so in their output; reporting on
disk text in that state answers a question nobody asked. Writes go back the
same way, compare-and-swap on the hash that was read, so an edit computed
against text he has since changed is refused rather than landed on top of it.
The result stays **dirty on purpose**: one Ctrl+Z undoes it, Ctrl+S keeps it,
and the decision is his.

If the buffer is dirty and cannot be read, or does not parse yet because he is
mid-sentence, the tools refuse. They never quietly fall back to the stale file.

**Every MCP write pushes itself to the window.** After a successful write the
tool asks the bridge to reload that file, and the renderer re-reads it, diffs
it by marker (`src/shared/diff.ts`) and flashes the markers that changed,
scrolling the first one into view. The tool result says which of three things
happened, because the difference matters:

| result | meaning |
| --- | --- |
| `· Studio reloaded it on screen` | that script was open; the change is in front of you |
| *(nothing)* | Studio is closed, or has a different script open |
| `· applied to Studio's UNSAVED buffer` | it was open and dirty; the edit went into the window |

Only the open script reloads. An edit to another lesson changes nothing on
screen, which is the behaviour you want: the open script is the one being
worked on.

## Checks in the window

The script view runs `src/shared/check.ts` as you type: the same rules the MCP
runs, from the same file, so the two cannot disagree about what is wrong with a
line. Errors are listed in the strip under the editor; advice collapses behind
a count and is styled quietly on purpose. The YAML pane adds a lint gutter,
mapping each finding to the line that declares its marker.

## Tests

```
npm test          # 58 unit cases, no window
npm run test:e2e  # launches a throwaway Studio and drives it over the MCP
```

The unit cases cover the fragment rules, the two coursework tiers, the editor
model, the marker diff, the round trip and the whole-script checks. Every case
is something that went wrong once; the "must not flag" cases are the more
valuable half, because an over-eager rule rewrites the author's own sentences.

`test/e2e.mjs` is the only test that proves the live update works. It starts a
real Electron instance with its own `--user-data-dir`, its own bridge file
(`STUDIO_BRIDGE_FILE`), the OBS capture backend and Kokoro autostart off, so it
touches no camera, no GPU and no container. Then it edits a script through the
MCP server over real stdio JSON-RPC and asks the bridge what the window is
showing.

## Glitch

`glitch/moods.ts` is the expression library: every mood is a target for one parameter set (eye colour, lids, brows, pupil,
gaze, mouth curve/open/smirk, squint, head tilt, ear fins, tremble, glow, arm reach/lift, static burst). `glitch/vex.ts`
draws him: a visored head with fins on a two-bone wall arm (IK), attached to the left edge; the driver tweens moods,
blinks, talks, and slides, and is seeded so the offline render reproduces the live performance frame for frame.
