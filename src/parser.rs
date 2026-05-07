use serde::Deserialize;

#[derive(Debug, Clone)]
pub enum KeyStep {
    Combo(String),
    Type(String),
    Key(String),
    Wait(u64),
}

#[derive(Debug, Clone)]
pub enum EventKind {
    Line { actor: String, text: String },
    Editor { text: String },
    Keys { steps: Vec<KeyStep> },
}

#[derive(Debug, Clone)]
pub struct Event {
    pub kind: EventKind,
    pub start: u32,
    pub end: u32,
}

pub struct Script {
    pub events: Vec<Event>,
    pub actors: Vec<String>,
}

// ── YAML intermediates ────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct YamlRoot {
    script: Vec<RawEntry>,
}

#[derive(Deserialize)]
struct RawEntry {
    #[serde(rename = "type")]
    entry_type: String,
    start: u32,
    end: u32,
    actor: Option<String>,
    text: Option<String>,
    keystrokes: Option<Vec<String>>,
}

pub fn parse(input: &str) -> Script {
    let cleaned = strip_line_comments(input);

    let raw_entries: Vec<RawEntry> = {
        // Try {script: [...]} wrapper first, then bare [...]
        if let Ok(root) = serde_yaml::from_str::<YamlRoot>(&cleaned) {
            root.script
        } else if let Ok(bare) = serde_yaml::from_str::<Vec<RawEntry>>(&cleaned) {
            bare
        } else {
            match serde_yaml::from_str::<serde_yaml::Value>(&cleaned) {
                Err(e) => {
                    eprintln!("YAML parse error: {e}");
                    return Script { events: vec![], actors: vec![] };
                }
                Ok(v) => {
                    eprintln!("YAML parsed but could not deserialize: {:?}", v);
                    return Script { events: vec![], actors: vec![] };
                }
            }
        }
    };

    let mut events = Vec::new();
    let mut actors: Vec<String> = Vec::new();

    for entry in raw_entries {
        match entry.entry_type.as_str() {
            "line" => {
                let actor = entry.actor.unwrap_or_default();
                let text = entry.text.unwrap_or_default().trim().to_string();
                if !actor.is_empty() && !actors.contains(&actor) {
                    actors.push(actor.clone());
                }
                events.push(Event {
                    kind: EventKind::Line { actor, text },
                    start: entry.start,
                    end: entry.end,
                });
            }
            "editor" => {
                let text = entry.text.unwrap_or_default().trim().to_string();
                events.push(Event {
                    kind: EventKind::Editor { text },
                    start: entry.start,
                    end: entry.end,
                });
            }
            "keys" => {
                let steps = entry
                    .keystrokes
                    .unwrap_or_default()
                    .iter()
                    .map(|s| parse_step(s.trim()))
                    .collect();
                events.push(Event {
                    kind: EventKind::Keys { steps },
                    start: entry.start,
                    end: entry.end,
                });
            }
            other => eprintln!("Unknown event type: {other}"),
        }
    }

    // Stable sort by start marker
    events.sort_by_key(|e| e.start);

    Script { events, actors }
}

// ── Step display ──────────────────────────────────────────────────────────────

pub fn format_steps(steps: &[KeyStep], active: Option<usize>) -> String {
    steps
        .iter()
        .enumerate()
        .map(|(i, step)| {
            let cursor = if active == Some(i) { "▶ " } else { "  " };
            let desc = match step {
                KeyStep::Combo(k) => format!("[{}]", k),
                KeyStep::Type(t) => {
                    let lines: Vec<&str> = t.lines().collect();
                    if lines.len() > 1 {
                        let first = lines[0].trim();
                        let clipped = if first.len() > 45 { &first[..45] } else { first };
                        format!("type: {}… (+{} lines)", clipped, lines.len() - 1)
                    } else {
                        let s = t.trim();
                        let clipped = if s.len() > 50 { &s[..50] } else { s };
                        format!("type: {}{}", clipped, if s.len() > 50 { "…" } else { "" })
                    }
                }
                KeyStep::Key(k) => format!("[{}]", k),
                KeyStep::Wait(ms) => format!("wait {}ms", ms),
            };
            format!("{}{}", cursor, desc)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn strip_line_comments(input: &str) -> String {
    input
        .lines()
        .map(|line| match find_comment_pos(line) {
            Some(pos) => line[..pos].trim_end().to_string(),
            None => line.to_string(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn find_comment_pos(line: &str) -> Option<usize> {
    let mut in_single = false;
    let mut in_double = false;
    let b = line.as_bytes();
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'\'' if !in_double => in_single = !in_single,
            b'"' if !in_single => in_double = !in_double,
            b'/' if !in_single && !in_double && i + 1 < b.len() && b[i + 1] == b'/' => {
                return Some(i);
            }
            _ => {}
        }
        i += 1;
    }
    None
}

fn parse_step(s: &str) -> KeyStep {
    // k: is the unified keystroke prefix; c: is a legacy alias
    let key_rest = s.strip_prefix("k:").or_else(|| s.strip_prefix("c:"));
    if let Some(rest) = key_rest {
        // k:ctrl+a → Combo, k:enter → Key
        if rest.contains('+') {
            KeyStep::Combo(rest.to_string())
        } else {
            KeyStep::Key(rest.to_string())
        }
    } else if let Some(rest) = s.strip_prefix("t:") {
        KeyStep::Type(rest.to_string())
    } else if let Some(rest) = s.strip_prefix("w:") {
        KeyStep::Wait(rest.trim().parse().unwrap_or(0))
    } else {
        KeyStep::Type(s.to_string())
    }
}
