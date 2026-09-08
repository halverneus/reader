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
   the `mscript` CLI and the `metrik-script` skill in the courses repo. Glitch's cues are inline `[mood]` tags in any
   line's text plus `mood:` fields and `face` entries.
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

## Glitch

`glitch/moods.ts` is the expression library: every mood is a target for one parameter set (eye colour, lids, brows, pupil,
gaze, mouth curve/open/smirk, squint, head tilt, ear fins, tremble, glow, arm reach/lift, static burst). `glitch/vex.ts`
draws him: a visored head with fins on a two-bone wall arm (IK), attached to the left edge; the driver tweens moods,
blinks, talks, and slides, and is seeded so the offline render reproduces the live performance frame for frame.
