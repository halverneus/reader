mod config;
mod docker;
mod keys;
mod parser;
mod tts;

use anyhow::Result;
use parser::{Event, EventKind};
use slint::{ModelRc, SharedString, VecModel};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tokio::sync::watch;

slint::include_modules!();

const VOICES: &[&str] = &[
    "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore",
    "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
    "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael",
    "am_onyx", "am_puck", "am_santa",
    "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
    "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
];

const DEFAULT_VOICE: &str = "af_bella";
const PREVIEW_TEXT: &str =
    "Hello, this is a preview. Testing one two three. How does this voice sound to you?";

// Row height estimation. Each grid row = max of the three cell heights.
// Generous constants so min-height is rarely exceeded by actual content.
const ACTOR_H_BASE: f32 = 46.0;  // 8+8 padding + 14 header + 16 slack
const ACTOR_H_LINE: f32 = 24.0;  // 13px font + line spacing + buffer
const EDITOR_H_BASE: f32 = 44.0;
const EDITOR_H_LINE: f32 = 22.0;
const KEYS_H_BASE: f32 = 44.0;
const KEYS_H_STEP: f32 = 20.0;

#[derive(Clone, Copy, PartialEq, Debug)]
enum ActorMode {
    Read,
    Skip,
    Hide,
}

impl ActorMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Skip => "skip",
            Self::Hide => "hide",
        }
    }

    fn from_str(s: &str) -> Self {
        match s {
            "skip" => Self::Skip,
            "hide" => Self::Hide,
            _ => Self::Read,
        }
    }

    fn cycle(self) -> Self {
        match self {
            Self::Read => Self::Skip,
            Self::Skip => Self::Hide,
            Self::Hide => Self::Read,
        }
    }
}

#[derive(Clone)]
struct ActorConfig {
    name: String,
    voice: String,
    mode: ActorMode,
}

struct AppState {
    events: Vec<Event>,
    actor_configs: Vec<ActorConfig>,
    last_dir: Option<PathBuf>,
    voice_assignments: HashMap<String, String>,
    actor_modes_map: HashMap<String, String>,

    production_mode: bool,

    // Precomputed flat lists (indices into `events`)
    actor_indices: Vec<usize>,
    editor_indices: Vec<usize>,
    keys_indices: Vec<usize>,

    // Production timeline
    prod_marker: i64,
    actor_history: Vec<i64>,
    keys_triggered: HashSet<usize>, // event indices already triggered

    // Production per-pane positions (index in flat list, -1 = none)
    prod_actor_list_idx: i32,
    prod_editor_list_idx: i32,
    prod_keys_list_idx: i32,

    // Keystroke state
    keys_running: bool,
    keys_running_end: u32,
    keys_done_tx: Option<watch::Sender<bool>>,
    keys_done_rx: Option<watch::Receiver<bool>>,

    tts_cancel: Arc<AtomicBool>,
    keys_cancel: Arc<AtomicBool>,
}

impl AppState {
    fn new() -> Self {
        let cfg = config::Config::load();
        AppState {
            events: Vec::new(),
            actor_configs: Vec::new(),
            last_dir: cfg.last_dir.map(PathBuf::from),
            voice_assignments: cfg.voice_assignments,
            actor_modes_map: cfg.character_modes,
            production_mode: false,
            actor_indices: Vec::new(),
            editor_indices: Vec::new(),
            keys_indices: Vec::new(),
            prod_marker: -1,
            actor_history: Vec::new(),
            keys_triggered: HashSet::new(),
            prod_actor_list_idx: -1,
            prod_editor_list_idx: -1,
            prod_keys_list_idx: -1,
            keys_running: false,
            keys_running_end: 0,
            keys_done_tx: None,
            keys_done_rx: None,
            tts_cancel: Arc::new(AtomicBool::new(false)),
            keys_cancel: Arc::new(AtomicBool::new(false)),
        }
    }

    fn load_script(&mut self, path: &str) -> Result<()> {
        let content = std::fs::read_to_string(path)?;
        let script = parser::parse(&content);
        self.events = script.events;

        if let Some(parent) = PathBuf::from(path).parent() {
            self.last_dir = Some(parent.to_path_buf());
        }

        self.actor_configs = script
            .actors
            .iter()
            .map(|name| {
                let voice = self
                    .voice_assignments
                    .get(name)
                    .cloned()
                    .unwrap_or_else(|| DEFAULT_VOICE.to_string());
                let mode = self
                    .actor_modes_map
                    .get(name)
                    .map(|s| ActorMode::from_str(s))
                    .unwrap_or_else(|| {
                        if name.eq_ignore_ascii_case("IGNORE") {
                            ActorMode::Hide
                        } else {
                            ActorMode::Read
                        }
                    });
                ActorConfig { name: name.clone(), voice, mode }
            })
            .collect();

        self.rebuild_indices();
        self.reset_production();
        self.save_config();
        Ok(())
    }

    fn rebuild_indices(&mut self) {
        self.actor_indices = self
            .events
            .iter()
            .enumerate()
            .filter(|(i, e)| {
                matches!(e.kind, EventKind::Line { .. })
                    && self.actor_mode_for_event(*i) != ActorMode::Hide
            })
            .map(|(i, _)| i)
            .collect();

        self.editor_indices = self
            .events
            .iter()
            .enumerate()
            .filter(|(_, e)| matches!(e.kind, EventKind::Editor { .. }))
            .map(|(i, _)| i)
            .collect();

        self.keys_indices = self
            .events
            .iter()
            .enumerate()
            .filter(|(_, e)| matches!(e.kind, EventKind::Keys { .. }))
            .map(|(i, _)| i)
            .collect();
    }

    fn reset_production(&mut self) {
        self.prod_marker = -1;
        self.actor_history.clear();
        self.keys_triggered.clear();
        self.keys_running = false;
        self.prod_actor_list_idx = -1;
        self.prod_editor_list_idx = -1;
        self.prod_keys_list_idx = -1;
        self.keys_done_tx = None;
        self.keys_done_rx = None;
    }

    fn save_config(&self) {
        let cfg = config::Config {
            last_dir: self.last_dir.as_ref().map(|p| p.to_string_lossy().into_owned()),
            voice_assignments: self.voice_assignments.clone(),
            character_modes: self
                .actor_configs
                .iter()
                .map(|a| (a.name.clone(), a.mode.as_str().to_string()))
                .collect(),
        };
        let _ = cfg.save();
    }

    fn actor_config(&self, name: &str) -> Option<&ActorConfig> {
        self.actor_configs.iter().find(|a| a.name == name)
    }

    fn actor_mode_for_event(&self, event_idx: usize) -> ActorMode {
        if let Some(Event { kind: EventKind::Line { actor, .. }, .. }) =
            self.events.get(event_idx)
        {
            self.actor_config(actor).map(|a| a.mode).unwrap_or(ActorMode::Read)
        } else {
            ActorMode::Read
        }
    }

    fn voice_for_event(&self, event_idx: usize) -> String {
        if let Some(Event { kind: EventKind::Line { actor, .. }, .. }) =
            self.events.get(event_idx)
        {
            self.actor_config(actor)
                .map(|a| a.voice.clone())
                .unwrap_or_else(|| DEFAULT_VOICE.to_string())
        } else {
            DEFAULT_VOICE.to_string()
        }
    }

    fn voice_index_for(&self, name: &str) -> usize {
        self.actor_config(name)
            .and_then(|a| VOICES.iter().position(|&v| v == a.voice.as_str()))
            .unwrap_or(0)
    }

    fn set_actor_voice(&mut self, name: &str, voice: &str) {
        if let Some(a) = self.actor_configs.iter_mut().find(|a| a.name == name) {
            a.voice = voice.to_string();
        }
        self.voice_assignments.insert(name.to_string(), voice.to_string());
        self.save_config();
    }

    fn cycle_actor_mode(&mut self, name: &str) {
        if let Some(a) = self.actor_configs.iter_mut().find(|a| a.name == name) {
            a.mode = a.mode.cycle();
        }
        self.save_config();
    }

    fn prev_voice(&mut self, name: &str) -> String {
        let idx = self.voice_index_for(name);
        let new_idx = if idx == 0 { VOICES.len() - 1 } else { idx - 1 };
        let voice = VOICES[new_idx].to_string();
        self.set_actor_voice(name, &voice);
        voice
    }

    fn next_voice(&mut self, name: &str) -> String {
        let idx = self.voice_index_for(name);
        let voice = VOICES[(idx + 1) % VOICES.len()].to_string();
        self.set_actor_voice(name, &voice);
        voice
    }

    fn current_voice_for(&self, name: &str) -> String {
        self.actor_config(name)
            .map(|a| a.voice.clone())
            .unwrap_or_else(|| DEFAULT_VOICE.to_string())
    }

    // ── Flat-list helpers ─────────────────────────────────────────────────────

    fn prod_keys_ev_idx(&self) -> Option<usize> {
        if self.prod_keys_list_idx < 0 {
            return None;
        }
        self.keys_indices.get(self.prod_keys_list_idx as usize).copied()
    }

    fn most_recent_actor_list_idx(&self, marker: i64) -> i32 {
        self.actor_indices
            .iter()
            .enumerate()
            .filter(|(_, &ev)| self.events[ev].start as i64 <= marker)
            .last()
            .map(|(pos, _)| pos as i32)
            .unwrap_or(-1)
    }

    fn most_recent_editor_list_idx(&self, marker: i64) -> i32 {
        self.editor_indices
            .iter()
            .enumerate()
            .filter(|(_, &ev)| self.events[ev].start as i64 <= marker)
            .last()
            .map(|(pos, _)| pos as i32)
            .unwrap_or(-1)
    }

    // ── Height / scroll estimation ────────────────────────────────────────────

    fn editor_cell_height(text: &str) -> f32 {
        let lines = text.lines().count().max(1) as f32;
        EDITOR_H_BASE + lines * EDITOR_H_LINE
    }

    fn actor_cell_height(text: &str) -> f32 {
        let lines = text.lines().count().max(1) as f32;
        ACTOR_H_BASE + lines * ACTOR_H_LINE
    }

    fn keys_cell_height(steps: &[parser::KeyStep]) -> f32 {
        KEYS_H_BASE + steps.len().max(1) as f32 * KEYS_H_STEP
    }

    fn unified_row_height(&self, marker: u32) -> f32 {
        let editor_h = self.events.iter()
            .find(|e| e.start == marker && matches!(e.kind, EventKind::Editor { .. }))
            .map(|e| if let EventKind::Editor { text } = &e.kind {
                Self::editor_cell_height(text)
            } else { 8.0 })
            .unwrap_or(8.0);

        let actor_h = self.events.iter()
            .find(|e| e.start == marker && matches!(e.kind, EventKind::Line { .. }))
            .map(|e| if let EventKind::Line { text, .. } = &e.kind {
                Self::actor_cell_height(text)
            } else { 8.0 })
            .unwrap_or(8.0);

        let keys_h = self.events.iter()
            .find(|e| e.start == marker && matches!(e.kind, EventKind::Keys { .. }))
            .map(|e| if let EventKind::Keys { steps } = &e.kind {
                Self::keys_cell_height(steps)
            } else { 8.0 })
            .unwrap_or(8.0);

        editor_h.max(actor_h).max(keys_h)
    }

    fn sorted_unique_markers(&self) -> Vec<u32> {
        let mut markers: Vec<u32> = self.events.iter().map(|e| e.start).collect();
        markers.sort_unstable();
        markers.dedup();
        markers
    }

    fn compute_viewport_height(&self) -> f32 {
        let total: f32 = self.sorted_unique_markers()
            .iter()
            .map(|&m| self.unified_row_height(m))
            .sum();
        // Generous buffer so min-height rows that grow beyond estimate
        // don't leave the bottom of the list unreachable.
        total * 1.5 + 400.0
    }

    fn compute_grid_scroll(&self) -> f32 {
        if self.prod_marker < 0 {
            return 0.0;
        }
        let target = self.prod_marker as u32;
        self.sorted_unique_markers()
            .iter()
            .take_while(|&&m| m < target)
            .map(|&m| self.unified_row_height(m))
            .sum()
    }

    // ── Slint model builders ──────────────────────────────────────────────────

    fn make_actor_entries(&self) -> Vec<ActorEntry> {
        self.actor_configs
            .iter()
            .map(|a| ActorEntry {
                name: SharedString::from(a.name.as_str()),
                voice: SharedString::from(a.voice.as_str()),
                mode: SharedString::from(a.mode.as_str()),
            })
            .collect()
    }

    fn make_grid_rows(&self) -> Vec<GridRow> {
        let mut markers: Vec<u32> = self.events.iter().map(|e| e.start).collect();
        markers.sort_unstable();
        markers.dedup();

        let mut rows = Vec::new();
        for marker in markers {
            let actor_ev = self
                .events
                .iter()
                .enumerate()
                .find(|(_, e)| e.start == marker && matches!(e.kind, EventKind::Line { .. }));
            let editor_ev = self
                .events
                .iter()
                .enumerate()
                .find(|(_, e)| e.start == marker && matches!(e.kind, EventKind::Editor { .. }));
            let keys_ev = self
                .events
                .iter()
                .enumerate()
                .find(|(_, e)| e.start == marker && matches!(e.kind, EventKind::Keys { .. }));

            let actor_visible = actor_ev
                .map(|(idx, _)| self.actor_mode_for_event(idx) != ActorMode::Hide)
                .unwrap_or(false);

            // Skip rows where the only content is a hidden actor
            if actor_ev.is_some() && !actor_visible && editor_ev.is_none() && keys_ev.is_none() {
                continue;
            }

            let (has_actor, actor_event_idx, actor_name, actor_text, actor_mode) =
                if let Some((idx, ev)) = actor_ev {
                    if let EventKind::Line { actor, text } = &ev.kind {
                        let mode = self.actor_mode_for_event(idx);
                        if mode == ActorMode::Hide {
                            (false, 0, String::new(), String::new(), String::new())
                        } else {
                            (true, idx as i32, actor.clone(), text.clone(), mode.as_str().to_string())
                        }
                    } else {
                        (false, 0, String::new(), String::new(), String::new())
                    }
                } else {
                    (false, 0, String::new(), String::new(), String::new())
                };

            let (has_editor, editor_text, editor_end_marker) =
                if let Some((_, ev)) = editor_ev {
                    if let EventKind::Editor { text } = &ev.kind {
                        (true, text.clone(), ev.end as i32)
                    } else {
                        (false, String::new(), 0)
                    }
                } else {
                    (false, String::new(), 0)
                };

            let (has_keys, keys_display, keys_end_marker, keys_active) =
                if let Some((idx, ev)) = keys_ev {
                    if let EventKind::Keys { steps } = &ev.kind {
                        let active = self.keys_triggered.contains(&idx);
                        (true, parser::format_steps(steps, None), ev.end as i32, active)
                    } else {
                        (false, String::new(), 0, false)
                    }
                } else {
                    (false, String::new(), 0, false)
                };

            rows.push(GridRow {
                marker: marker as i32,
                row_height: self.unified_row_height(marker) as i32,
                has_actor,
                actor_event_idx,
                actor_name: SharedString::from(actor_name),
                actor_text: SharedString::from(actor_text),
                actor_mode: SharedString::from(actor_mode),
                has_editor,
                editor_text: SharedString::from(editor_text),
                editor_end_marker,
                has_keys,
                keys_display: SharedString::from(keys_display),
                keys_end_marker,
                keys_active,
            });
        }
        rows
    }

    fn prod_status(&self) -> String {
        let total = self.actor_indices.len();
        let done = if self.prod_actor_list_idx >= 0 {
            (self.prod_actor_list_idx + 1) as usize
        } else {
            0
        };
        format!("{done} / {total}")
    }
}

// ── Apply production UI state ─────────────────────────────────────────────────

fn update_prod_ui(ui: &AppWindow, s: &AppState) {
    ui.set_prod_marker(s.prod_marker as i32);
    ui.set_prod_scroll(s.compute_grid_scroll());
    ui.set_prod_status(SharedString::from(s.prod_status()));
}

// ── TTS helpers ───────────────────────────────────────────────────────────────

fn cancel_tts(s: &mut AppState) {
    s.tts_cancel.store(true, Ordering::SeqCst);
    let cancel = Arc::new(AtomicBool::new(false));
    s.tts_cancel = cancel;
}

fn spawn_tts_text(
    text: String,
    voice: String,
    event_idx: i32,
    state: Arc<Mutex<AppState>>,
    ui_weak: slint::Weak<AppWindow>,
    handle: tokio::runtime::Handle,
) {
    let cancel = {
        let mut s = state.lock().unwrap();
        cancel_tts(&mut s);
        s.tts_cancel.clone()
    };

    if let Some(ui) = ui_weak.upgrade() {
        ui.set_playing_index(event_idx);
    }

    handle.spawn(async move {
        if let Err(e) = tts::speak(text, voice, cancel).await {
            eprintln!("TTS error: {e}");
        }
        let _ = slint::invoke_from_event_loop(move || {
            if let Some(ui) = ui_weak.upgrade() {
                if ui.get_playing_index() == event_idx {
                    ui.set_playing_index(-1);
                }
            }
        });
    });
}

fn spawn_tts_deferred(
    text: String,
    voice: String,
    event_idx: i32,
    keys_rx: Option<watch::Receiver<bool>>,
    cancel: Arc<AtomicBool>,
    ui_weak: slint::Weak<AppWindow>,
    handle: tokio::runtime::Handle,
) {
    if let Some(ui) = ui_weak.upgrade() {
        ui.set_playing_index(event_idx);
    }

    handle.spawn(async move {
        if let Some(mut rx) = keys_rx {
            while !*rx.borrow() {
                if rx.changed().await.is_err() {
                    break;
                }
            }
        }
        if cancel.load(Ordering::Relaxed) {
            return;
        }
        if let Err(e) = tts::speak(text, voice, cancel).await {
            eprintln!("TTS deferred error: {e}");
        }
        let _ = slint::invoke_from_event_loop(move || {
            if let Some(ui) = ui_weak.upgrade() {
                if ui.get_playing_index() == event_idx {
                    ui.set_playing_index(-1);
                }
            }
        });
    });
}

fn spawn_preview(voice: String, state: Arc<Mutex<AppState>>, handle: tokio::runtime::Handle) {
    let cancel = {
        let mut s = state.lock().unwrap();
        cancel_tts(&mut s);
        s.tts_cancel.clone()
    };
    handle.spawn(async move {
        if let Err(e) = tts::speak(PREVIEW_TEXT.to_string(), voice, cancel).await {
            eprintln!("Preview TTS error: {e}");
        }
    });
}

// ── Production advance ────────────────────────────────────────────────────────

fn advance_production(
    state: Arc<Mutex<AppState>>,
    ui_weak: slint::Weak<AppWindow>,
    handle: tokio::runtime::Handle,
) {
    #[derive(Clone)]
    enum Ev {
        Line { ev_idx: usize, list_pos: i32, mode: ActorMode, text: String, voice: String },
        Editor { list_pos: i32 },
        Keys { ev_idx: usize, list_pos: i32, end: u32, steps: Vec<parser::KeyStep>, already: bool },
    }

    let result = {
        let mut s = state.lock().unwrap();

        let next_marker = s
            .events
            .iter()
            .filter(|e| (e.start as i64) > s.prod_marker)
            .map(|e| e.start)
            .min();

        let Some(marker) = next_marker else { return };

        let old_marker = s.prod_marker;
        s.tts_cancel.store(true, Ordering::SeqCst);
        s.actor_history.push(old_marker);
        s.prod_marker = marker as i64;

        let evs: Vec<Ev> = s
            .events
            .iter()
            .enumerate()
            .filter(|(_, e)| e.start == marker)
            .map(|(ev_idx, ev)| match &ev.kind {
                EventKind::Line { text, .. } => {
                    let list_pos = s
                        .actor_indices
                        .iter()
                        .position(|&i| i == ev_idx)
                        .map(|p| p as i32)
                        .unwrap_or(-1);
                    let mode = s.actor_mode_for_event(ev_idx);
                    let voice = s.voice_for_event(ev_idx);
                    Ev::Line { ev_idx, list_pos, mode, text: text.clone(), voice }
                }
                EventKind::Editor { .. } => {
                    let list_pos = s
                        .editor_indices
                        .iter()
                        .position(|&i| i == ev_idx)
                        .map(|p| p as i32)
                        .unwrap_or(-1);
                    Ev::Editor { list_pos }
                }
                EventKind::Keys { steps } => {
                    let list_pos = s
                        .keys_indices
                        .iter()
                        .position(|&i| i == ev_idx)
                        .map(|p| p as i32)
                        .unwrap_or(-1);
                    let already = s.keys_triggered.contains(&ev_idx);
                    Ev::Keys { ev_idx, list_pos, end: ev.end, steps: steps.clone(), already }
                }
            })
            .collect();

        let mut actor_to_speak: Option<(usize, String, String)> = None;
        let mut keys_to_run: Option<(usize, Vec<parser::KeyStep>)> = None;

        for ev in &evs {
            match ev {
                Ev::Line { ev_idx, list_pos, mode, text, voice } => {
                    if *list_pos >= 0 {
                        s.prod_actor_list_idx = *list_pos;
                    }
                    if *mode == ActorMode::Read {
                        actor_to_speak = Some((*ev_idx, text.clone(), voice.clone()));
                    }
                }
                Ev::Editor { list_pos } => {
                    if *list_pos >= 0 {
                        s.prod_editor_list_idx = *list_pos;
                    }
                }
                Ev::Keys { ev_idx, list_pos, end, steps, already } => {
                    if !already {
                        s.keys_triggered.insert(*ev_idx);
                        if *list_pos >= 0 {
                            s.prod_keys_list_idx = *list_pos;
                        }
                        s.keys_running = true;
                        s.keys_running_end = *end;
                        let (tx, rx) = watch::channel(false);
                        s.keys_done_tx = Some(tx);
                        s.keys_done_rx = Some(rx);
                        keys_to_run = Some((*ev_idx, steps.clone()));
                    }
                }
            }
        }

        let actor_blocked = if let Some((actor_ev_idx, _, _)) = &actor_to_speak {
            let actor_start = s.events[*actor_ev_idx].start;
            s.keys_running && s.keys_running_end <= actor_start
        } else {
            false
        };

        let keys_rx = s.keys_done_rx.clone();
        let tts_cancel = s.tts_cancel.clone();

        (actor_to_speak, actor_blocked, keys_to_run, keys_rx, tts_cancel)
    };

    let (actor_to_speak, actor_blocked, keys_to_run, keys_rx, tts_cancel) = result;

    // Update UI
    {
        let s = state.lock().unwrap();
        if let Some(ui) = ui_weak.upgrade() {
            update_prod_ui(&ui, &s);
        }
    }

    // Start keystroke task
    if let Some((keys_ev_idx, steps)) = keys_to_run {
        let (progress_tx, progress_rx) = watch::channel(0usize);
        let keys_cancel = {
            let mut s = state.lock().unwrap();
            s.keys_cancel.store(true, Ordering::SeqCst);
            let cancel = Arc::new(AtomicBool::new(false));
            s.keys_cancel = cancel.clone();
            cancel
        };

        let state_prog = state.clone();
        let ui_prog = ui_weak.clone();
        let state_done = state.clone();
        let ui_done = ui_weak.clone();

        // Progress watcher
        handle.spawn(async move {
            let mut rx = progress_rx;
            loop {
                if rx.changed().await.is_err() {
                    break;
                }
                let step = *rx.borrow();
                let display = {
                    let s = state_prog.lock().unwrap();
                    s.prod_keys_ev_idx()
                        .and_then(|ev_idx| {
                            if let EventKind::Keys { steps } = &s.events[ev_idx].kind {
                                Some(parser::format_steps(steps, Some(step)))
                            } else {
                                None
                            }
                        })
                        .unwrap_or_default()
                };
                let _ = slint::invoke_from_event_loop({
                    let ui_weak = ui_prog.clone();
                    move || {
                        if let Some(ui) = ui_weak.upgrade() {
                            ui.set_prod_keys_running(true);
                            ui.set_prod_keys_display(SharedString::from(display));
                        }
                    }
                });
            }
        });

        // Keys execution
        handle.spawn(async move {
            keys::run(steps, progress_tx, keys_cancel).await;

            {
                let mut s = state_done.lock().unwrap();
                s.keys_running = false;
                if let Some(ref tx) = s.keys_done_tx {
                    let _ = tx.send(true);
                }
            }
            let _ = slint::invoke_from_event_loop({
                let ui_weak = ui_done.clone();
                move || {
                    if let Some(ui) = ui_weak.upgrade() {
                        ui.set_prod_keys_running(false);
                        ui.set_prod_keys_display(SharedString::default());
                    }
                }
            });

            let _ = keys_ev_idx;
        });
    }

    // Speak actor line
    if let Some((event_idx, text, voice)) = actor_to_speak {
        if actor_blocked {
            spawn_tts_deferred(
                text, voice, event_idx as i32,
                keys_rx, tts_cancel, ui_weak, handle,
            );
        } else {
            spawn_tts_text(text, voice, event_idx as i32, state, ui_weak, handle);
        }
    }
}

// ── Production rewind ─────────────────────────────────────────────────────────

fn rewind_production(
    state: Arc<Mutex<AppState>>,
    ui_weak: slint::Weak<AppWindow>,
) {
    let mut s = state.lock().unwrap();
    let Some(prev_marker) = s.actor_history.pop() else { return };

    s.tts_cancel.store(true, Ordering::SeqCst);
    s.prod_marker = prev_marker;
    s.prod_actor_list_idx = s.most_recent_actor_list_idx(prev_marker);
    s.prod_editor_list_idx = s.most_recent_editor_list_idx(prev_marker);
    // Keys stay: keystrokes don't rewind

    if let Some(ui) = ui_weak.upgrade() {
        ui.set_playing_index(-1);
        update_prod_ui(&ui, &s);
    }
}

// ── Kokoro readiness poller ───────────────────────────────────────────────────

async fn wait_for_kokoro(ui_weak: slint::Weak<AppWindow>) {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    loop {
        match client.get("http://localhost:8880/health").send().await {
            Ok(resp) if resp.status().is_success() => {
                let _ = slint::invoke_from_event_loop(move || {
                    if let Some(ui) = ui_weak.upgrade() {
                        ui.set_model_ready(true);
                    }
                });
                return;
            }
            _ => tokio::time::sleep(std::time::Duration::from_secs(2)).await,
        }
    }
}

// ── Entry point ───────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> Result<()> {
    println!("Starting Kokoro container…");
    docker::start()?;

    let ui = AppWindow::new()?;
    let state = Arc::new(Mutex::new(AppState::new()));
    let handle = tokio::runtime::Handle::current();

    handle.spawn(wait_for_kokoro(ui.as_weak()));

    ui.set_voices(ModelRc::new(VecModel::from(
        VOICES.iter().map(|&v| SharedString::from(v)).collect::<Vec<_>>(),
    )));

    // ── open-file-dialog ──────────────────────────────────────────────────────
    ui.on_open_file_dialog({
        let ui_weak = ui.as_weak();
        let state = state.clone();
        move || {
            let ui_weak = ui_weak.clone();
            let last_dir = state.lock().unwrap().last_dir.clone();
            tokio::task::spawn_blocking(move || {
                let mut dialog = rfd::FileDialog::new()
                    .set_title("Open Script")
                    .add_filter("YAML scripts", &["yml", "yaml"])
                    .add_filter("All files", &["*"]);
                if let Some(dir) = last_dir {
                    dialog = dialog.set_directory(dir);
                }
                if let Some(path) = dialog.pick_file() {
                    let path_str = path.to_string_lossy().into_owned();
                    let _ = slint::invoke_from_event_loop(move || {
                        if let Some(ui) = ui_weak.upgrade() {
                            ui.set_file_path(SharedString::from(&path_str));
                        }
                    });
                }
            });
        }
    });

    // ── load-file ─────────────────────────────────────────────────────────────
    ui.on_load_file({
        let ui_weak = ui.as_weak();
        let state = state.clone();
        move |path| {
            let mut s = state.lock().unwrap();
            s.tts_cancel.store(true, Ordering::SeqCst);

            match s.load_script(path.as_str()) {
                Ok(()) => {
                    let grid_rows = s.make_grid_rows();
                    let actor_entries = s.make_actor_entries();
                    let viewport_h = s.compute_viewport_height();

                    if let Some(ui) = ui_weak.upgrade() {
                        ui.set_grid_rows(ModelRc::new(VecModel::from(grid_rows)));
                        ui.set_grid_viewport_height(viewport_h);
                        ui.set_actors(ModelRc::new(VecModel::from(actor_entries)));
                        ui.set_playing_index(-1);
                        ui.set_prod_marker(-1);
                        ui.set_prod_scroll(0.0);
                        ui.set_prod_keys_running(false);
                        ui.set_prod_keys_display(SharedString::default());
                        ui.set_prod_status(SharedString::from(s.prod_status()));
                    }
                }
                Err(e) => eprintln!("Failed to load '{}': {e}", path.as_str()),
            }
        }
    });

    // ── advance-block (↓) ─────────────────────────────────────────────────────
    ui.on_advance_block({
        let ui_weak = ui.as_weak();
        let state = state.clone();
        let handle = handle.clone();
        move || {
            if state.lock().unwrap().production_mode {
                advance_production(state.clone(), ui_weak.clone(), handle.clone());
            }
        }
    });

    // ── rewind-block (↑) ──────────────────────────────────────────────────────
    ui.on_rewind_block({
        let ui_weak = ui.as_weak();
        let state = state.clone();
        move || {
            if state.lock().unwrap().production_mode {
                rewind_production(state.clone(), ui_weak.clone());
            }
        }
    });

    // ── toggle-mode ───────────────────────────────────────────────────────────
    ui.on_toggle_mode({
        let ui_weak = ui.as_weak();
        let state = state.clone();
        move || {
            let mut s = state.lock().unwrap();
            s.tts_cancel.store(true, Ordering::SeqCst);
            s.production_mode = !s.production_mode;
            let prod = s.production_mode;
            let grid_rows = s.make_grid_rows();
            let viewport_h = s.compute_viewport_height();

            if let Some(ui) = ui_weak.upgrade() {
                ui.set_playing_index(-1);
                ui.set_production_mode(prod);
                ui.set_grid_rows(ModelRc::new(VecModel::from(grid_rows)));
                ui.set_grid_viewport_height(viewport_h);
                update_prod_ui(&ui, &s);
            }
        }
    });

    // ── reset-production ──────────────────────────────────────────────────────
    ui.on_reset_production({
        let ui_weak = ui.as_weak();
        let state = state.clone();
        move || {
            let mut s = state.lock().unwrap();
            s.tts_cancel.store(true, Ordering::SeqCst);
            s.keys_cancel.store(true, Ordering::SeqCst);
            s.reset_production();

            if let Some(ui) = ui_weak.upgrade() {
                ui.set_playing_index(-1);
                ui.set_prod_keys_running(false);
                ui.set_prod_keys_display(SharedString::default());
                update_prod_ui(&ui, &s);
            }
        }
    });

    // ── actor-event-clicked (edit mode speak) ─────────────────────────────────
    ui.on_actor_event_clicked({
        let ui_weak = ui.as_weak();
        let state = state.clone();
        let handle = handle.clone();
        move |event_idx| {
            let idx = event_idx as usize;
            let (text, voice, mode) = {
                let s = state.lock().unwrap();
                let mode = s.actor_mode_for_event(idx);
                if mode != ActorMode::Read {
                    return;
                }
                if let Some(Event { kind: EventKind::Line { text, .. }, .. }) = s.events.get(idx) {
                    (text.clone(), s.voice_for_event(idx), mode)
                } else {
                    return;
                }
            };
            if mode == ActorMode::Read {
                spawn_tts_text(text, voice, event_idx, state.clone(), ui_weak.clone(), handle.clone());
            }
        }
    });

    // ── actor-voice-changed ───────────────────────────────────────────────────
    ui.on_actor_voice_changed({
        let ui_weak = ui.as_weak();
        let state = state.clone();
        move |name, voice| {
            let entries = {
                let mut s = state.lock().unwrap();
                s.set_actor_voice(name.as_str(), voice.as_str());
                s.make_actor_entries()
            };
            if let Some(ui) = ui_weak.upgrade() {
                ui.set_actors(ModelRc::new(VecModel::from(entries)));
            }
        }
    });

    // ── actor-mode-cycled ─────────────────────────────────────────────────────
    ui.on_actor_mode_cycled({
        let ui_weak = ui.as_weak();
        let state = state.clone();
        move |name| {
            let mut s = state.lock().unwrap();
            s.cycle_actor_mode(name.as_str());
            s.rebuild_indices();
            let grid_rows = s.make_grid_rows();
            let actor_entries = s.make_actor_entries();
            let viewport_h = s.compute_viewport_height();
            if let Some(ui) = ui_weak.upgrade() {
                ui.set_grid_rows(ModelRc::new(VecModel::from(grid_rows)));
                ui.set_grid_viewport_height(viewport_h);
                ui.set_actors(ModelRc::new(VecModel::from(actor_entries)));
            }
        }
    });

    // ── actor-prev-voice ──────────────────────────────────────────────────────
    ui.on_actor_prev_voice({
        let ui_weak = ui.as_weak();
        let state = state.clone();
        let handle = handle.clone();
        move |name| {
            let (entries, voice) = {
                let mut s = state.lock().unwrap();
                let voice = s.prev_voice(name.as_str());
                (s.make_actor_entries(), voice)
            };
            if let Some(ui) = ui_weak.upgrade() {
                ui.set_actors(ModelRc::new(VecModel::from(entries)));
            }
            spawn_preview(voice, state.clone(), handle.clone());
        }
    });

    // ── actor-next-voice ──────────────────────────────────────────────────────
    ui.on_actor_next_voice({
        let ui_weak = ui.as_weak();
        let state = state.clone();
        let handle = handle.clone();
        move |name| {
            let (entries, voice) = {
                let mut s = state.lock().unwrap();
                let voice = s.next_voice(name.as_str());
                (s.make_actor_entries(), voice)
            };
            if let Some(ui) = ui_weak.upgrade() {
                ui.set_actors(ModelRc::new(VecModel::from(entries)));
            }
            spawn_preview(voice, state.clone(), handle.clone());
        }
    });

    // ── preview-voice ─────────────────────────────────────────────────────────
    ui.on_preview_voice({
        let state = state.clone();
        let handle = handle.clone();
        move |name| {
            let voice = state.lock().unwrap().current_voice_for(name.as_str());
            spawn_preview(voice, state.clone(), handle.clone());
        }
    });

    ui.run()?;
    docker::stop();
    Ok(())
}
