# Script Reader

A Rust/Slint teleprompter for recording educational coding videos. Reads YAML scripts with actor dialogue, editor notes, and VM keystroke sequences.

## Script Format

```yaml
script:
  - type: "line"
    actor: "Dev"
    start: 100
    end: 200
    text: "What you want the TTS voice to say."

  - type: "editor"
    start: 100
    end: 200
    text: |
      Notes for the video editor. Can include code blocks:
      ```csharp
      Console.WriteLine("Hello!");
      ```

  - type: "keys"
    start: 200
    end: 400
    keystrokes:
      - "k:ctrl+a"         # select all
      - "t:some code here" # type text
      - "k:enter"          # press Enter
      - "w:2000"           # wait 2 seconds
```

**Inline comments** (`// …`) are stripped before parsing — YAML doesn't natively support them.

**Start/end markers** are arbitrary integers. Use multiples of 100 to leave room for insertions. Events at the same start marker fire in parallel.

## Keystroke Syntax

| Prefix | Meaning | Examples |
|--------|---------|---------|
| `k:key` | Press a single key | `k:enter`, `k:tab`, `k:escape` |
| `k:mod+key` | Key combo (use `+` to combine) | `k:ctrl+a`, `k:ctrl+shift+p`, `k:alt+f4` |
| `t:text` | Type a string character by character | `t:Hello, world!` |
| `w:ms` | Wait in milliseconds | `w:1000` (1 second), `w:500` |

Multi-line text blocks work with YAML block scalars:
```yaml
- |
  t:line one
  line two
  line three
```

### Available Key Names

**Navigation**
| Name | Key |
|------|-----|
| `enter` | Enter / Return |
| `tab` | Tab |
| `escape` | Escape |
| `backspace` | Backspace |
| `delete` | Delete |
| `space` | Space |
| `home` | Home |
| `end` | End |
| `pgup` | Page Up |
| `pgdn` | Page Down |

**Arrow Keys**
| Name | Key |
|------|-----|
| `up` | ↑ |
| `down` | ↓ |
| `left` | ← |
| `right` | → |

**Function Keys**
`f1` through `f12`

**Modifier Keys** (for combos only)
| Name | Key |
|------|-----|
| `ctrl` | Control |
| `shift` | Shift |
| `alt` | Alt |
| `super` | Super / Windows key |

**Common Combos**

| Keystroke | Action |
|-----------|--------|
| `k:ctrl+a` | Select all |
| `k:ctrl+c` | Copy |
| `k:ctrl+v` | Paste |
| `k:ctrl+x` | Cut |
| `k:ctrl+z` | Undo |
| `k:ctrl+s` | Save |
| `k:ctrl+shift+p` | Command palette (VS Code) |
| `k:f5` | Run / Debug |
| `k:shift+f5` | Stop debugging |

## Modes

**Edit mode** — Scrollable three-column view aligned by start marker. Click an actor line to speak it via TTS.

**Production mode** — Three independent scroll panes (Editor Notes | Actors | Code/Keystrokes):
- `↓` advances to the next marker, speaks actor lines, fires keystrokes
- `↑` rewinds the actor pane only (keystrokes never re-run)
- Past items are dimmed; current item is highlighted

## Actor Modes

Each character can be set to:
- **READ** — TTS speaks the line
- **SKIP** — Your line (highlighted, not spoken by TTS)
- **HIDE** — Line is hidden entirely (for off-screen characters)

Cycle modes by clicking the READ/SKIP/HIDE badge in the sidebar.
