mod config;
mod docker;
mod parser;
mod tts;

use anyhow::Result;
use slint::{ModelRc, SharedString, VecModel};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

slint::include_modules!();

// ── Voice list ────────────────────────────────────────────────────────────────
const VOICES: &[&str] = &[
    // American English — female
    "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica",
    "af_kore", "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
    // American English — male
    "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam",
    "am_michael", "am_onyx", "am_puck", "am_santa",
    // British English — female
    "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
    // British English — male
    "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
    // Japanese
    "jf_alpha", "jf_gongitsune", "jf_nezumi", "jf_tebukuro", "jm_kumo",
    // Mandarin
    "zf_xiaobei", "zf_xiaoni", "zf_xiaoxiao", "zf_xiaoyi",
    "zm_yunjian", "zm_yunxi", "zm_yunxia", "zm_yunyang",
    // Spanish
    "ef_dora", "em_alex", "em_santa",
    // French
    "ff_siwis",
    // Hindi
    "hf_alpha", "hf_beta", "hm_omega", "hm_psi",
    // Italian
    "if_sara", "im_nicola",
    // Portuguese
    "pf_dora", "pm_alex", "pm_santa",
];

const DEFAULT_VOICE: &str = "af_bella";
/// Logical pixels per visible block item (100 px height + 4 px gap).
const ITEM_HEIGHT: f32 = 104.0;

const PREVIEW_TEXT: &str =
    "Hello, this is a preview. Testing one two three. How does this voice sound to you?";

// ── Character mode ────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Debug)]
enum CharacterMode {
    Read,
    Skip,
    Hide,
}

impl CharacterMode {
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

// ── App state ─────────────────────────────────────────────────────────────────

#[derive(Clone)]
struct CharacterConfig {
    name: String,
    voice: String,
    mode: CharacterMode,
}

struct AppState {
    blocks: Vec<parser::Block>,
    characters: Vec<CharacterConfig>,
    last_dir: Option<PathBuf>,
    voice_assignments: HashMap<String, String>,
    character_modes: HashMap<String, String>,
    /// Block index currently shown at the top of the view (-1 = none yet).
    current_top_index: i32,
    /// Set to true to cancel the running TTS task.
    cancel: Arc<AtomicBool>,
}

impl AppState {
    fn new() -> Self {
        let cfg = config::Config::load();
        AppState {
            blocks: Vec::new(),
            characters: Vec::new(),
            last_dir: cfg.last_dir.map(PathBuf::from),
            voice_assignments: cfg.voice_assignments,
            character_modes: cfg.character_modes,
            current_top_index: -1,
            cancel: Arc::new(AtomicBool::new(false)),
        }
    }

    fn load_script(&mut self, path: &str) -> Result<()> {
        let content = std::fs::read_to_string(path)?;
        let script = parser::parse(&content);
        self.blocks = script.blocks;

        if let Some(parent) = PathBuf::from(path).parent() {
            self.last_dir = Some(parent.to_path_buf());
        }

        self.characters = script
            .characters
            .iter()
            .map(|name| {
                let voice = self
                    .voice_assignments
                    .get(name)
                    .cloned()
                    .unwrap_or_else(|| DEFAULT_VOICE.to_string());

                let mode = self
                    .character_modes
                    .get(name)
                    .map(|s| CharacterMode::from_str(s))
                    // Auto-hide a character literally named "IGNORE".
                    .unwrap_or_else(|| {
                        if name.eq_ignore_ascii_case("IGNORE") {
                            CharacterMode::Hide
                        } else {
                            CharacterMode::Read
                        }
                    });

                CharacterConfig {
                    name: name.clone(),
                    voice,
                    mode,
                }
            })
            .collect();

        // First non-hidden block becomes the starting position.
        self.current_top_index = self.next_non_hidden(0).map(|i| i as i32).unwrap_or(-1);
        self.save_config();
        Ok(())
    }

    fn save_config(&self) {
        let cfg = config::Config {
            last_dir: self.last_dir.as_ref().map(|p| p.to_string_lossy().into_owned()),
            voice_assignments: self.voice_assignments.clone(),
            character_modes: self
                .characters
                .iter()
                .map(|c| (c.name.clone(), c.mode.as_str().to_string()))
                .collect(),
        };
        let _ = cfg.save();
    }

    fn set_character_voice(&mut self, name: &str, voice: &str) {
        if let Some(c) = self.characters.iter_mut().find(|c| c.name == name) {
            c.voice = voice.to_string();
        }
        self.voice_assignments.insert(name.to_string(), voice.to_string());
        self.save_config();
    }

    fn cycle_character_mode(&mut self, name: &str) {
        if let Some(c) = self.characters.iter_mut().find(|c| c.name == name) {
            c.mode = c.mode.cycle();
        }
        self.save_config();
    }

    // ── Voice cycling ─────────────────────────────────────────────────────

    fn voice_index_for(&self, name: &str) -> usize {
        self.characters
            .iter()
            .find(|c| c.name == name)
            .and_then(|c| VOICES.iter().position(|&v| v == c.voice.as_str()))
            .unwrap_or(0)
    }

    fn cycle_to_voice_index(&mut self, name: &str, idx: usize) -> String {
        let voice = VOICES[idx % VOICES.len()].to_string();
        self.set_character_voice(name, &voice);
        voice
    }

    fn prev_voice(&mut self, name: &str) -> String {
        let idx = self.voice_index_for(name);
        let new_idx = if idx == 0 { VOICES.len() - 1 } else { idx - 1 };
        self.cycle_to_voice_index(name, new_idx)
    }

    fn next_voice(&mut self, name: &str) -> String {
        let idx = self.voice_index_for(name);
        let new_idx = (idx + 1) % VOICES.len();
        self.cycle_to_voice_index(name, new_idx)
    }

    fn current_voice_for(&self, name: &str) -> String {
        self.characters
            .iter()
            .find(|c| c.name == name)
            .map(|c| c.voice.clone())
            .unwrap_or_else(|| DEFAULT_VOICE.to_string())
    }

    // ── Block queries ─────────────────────────────────────────────────────

    fn char_for_block(&self, index: usize) -> Option<&CharacterConfig> {
        let block = self.blocks.get(index)?;
        self.characters.iter().find(|c| c.name == block.character)
    }

    fn block_mode(&self, index: usize) -> CharacterMode {
        self.char_for_block(index)
            .map(|c| c.mode)
            .unwrap_or(CharacterMode::Read)
    }

    fn voice_for_block(&self, index: usize) -> String {
        self.char_for_block(index)
            .map(|c| c.voice.clone())
            .unwrap_or_else(|| DEFAULT_VOICE.to_string())
    }

    /// First block at `from` or later where mode != Hide.
    fn next_non_hidden(&self, from: usize) -> Option<usize> {
        (from..self.blocks.len()).find(|&i| self.block_mode(i) != CharacterMode::Hide)
    }

    /// Pixel scroll offset for `block_index`.
    ///
    /// HIDE blocks have `height: 0` in Slint's VerticalLayout, so we count only
    /// non-hidden blocks before `block_index` to get the true visual position.
    fn pixel_offset(&self, block_index: usize) -> f32 {
        (0..block_index)
            .filter(|&i| self.block_mode(i) != CharacterMode::Hide)
            .count() as f32 * ITEM_HEIGHT
    }

    // ── Slint model builders ──────────────────────────────────────────────

    /// Returns ALL blocks in the model; hidden ones get height 0 / invisible in Slint.
    fn slint_blocks(&self) -> Vec<ScriptBlock> {
        self.blocks
            .iter()
            .enumerate()
            .map(|(i, b)| ScriptBlock {
                marker: b.marker as i32,
                original_index: i as i32,
                character: SharedString::from(b.character.as_str()),
                content: SharedString::from(b.content.as_str()),
                mode: SharedString::from(self.block_mode(i).as_str()),
            })
            .collect()
    }

    fn slint_characters(&self) -> Vec<CharacterEntry> {
        self.characters
            .iter()
            .map(|c| CharacterEntry {
                name: SharedString::from(c.name.as_str()),
                voice: SharedString::from(c.voice.as_str()),
                mode: SharedString::from(c.mode.as_str()),
            })
            .collect()
    }
}

// ── TTS task spawn ────────────────────────────────────────────────────────────

fn spawn_tts(
    block_index: usize,
    state: Arc<Mutex<AppState>>,
    ui_weak: slint::Weak<AppWindow>,
    handle: tokio::runtime::Handle,
) {
    let (content, voice, cancel, scroll_offset) = {
        let mut s = state.lock().unwrap();
        s.cancel.store(true, Ordering::SeqCst);
        let cancel = Arc::new(AtomicBool::new(false));
        s.cancel = cancel.clone();
        s.current_top_index = block_index as i32;
        let content = s.blocks[block_index].content.clone();
        let voice = s.voice_for_block(block_index);
        let scroll_offset = s.pixel_offset(block_index);
        (content, voice, cancel, scroll_offset)
    };

    if let Some(ui) = ui_weak.upgrade() {
        ui.set_playing_index(block_index as i32);
        ui.invoke_scroll_to(scroll_offset);
    }

    handle.spawn(async move {
        if let Err(e) = tts::speak(content, voice, cancel).await {
            eprintln!("TTS error: {e}");
        }

        let (_next, next_offset) = {
            let mut s = state.lock().unwrap();
            let next = s.next_non_hidden(block_index + 1);
            // If the auto-scrolled-to block is a SKIP block it will already be
            // visible at the top when the user reaches for ↓.  Pre-advance
            // current_top_index past it so one keypress plays the next READ
            // block rather than silently "re-showing" the SKIP block.
            s.current_top_index = match next {
                None => -1,
                Some(n) if s.block_mode(n) == CharacterMode::Skip => {
                    s.next_non_hidden(n + 1).unwrap_or(n) as i32
                }
                Some(n) => n as i32,
            };
            let next_offset = next.map(|i| s.pixel_offset(i));
            (next, next_offset)
        };

        let _ = slint::invoke_from_event_loop(move || {
            if let Some(ui) = ui_weak.upgrade() {
                if ui.get_playing_index() == block_index as i32 {
                    ui.set_playing_index(-1);
                    if let Some(offset) = next_offset {
                        ui.invoke_scroll_to(offset);
                    }
                }
            }
        });
    });
}

// ── Voice preview spawn ───────────────────────────────────────────────────────

fn spawn_preview(
    voice: String,
    state: Arc<Mutex<AppState>>,
    handle: tokio::runtime::Handle,
) {
    let cancel = {
        let mut s = state.lock().unwrap();
        s.cancel.store(true, Ordering::SeqCst);
        let cancel = Arc::new(AtomicBool::new(false));
        s.cancel = cancel.clone();
        cancel
    };
    handle.spawn(async move {
        if let Err(e) = tts::speak(PREVIEW_TEXT.to_string(), voice, cancel).await {
            eprintln!("Preview TTS error: {e}");
        }
    });
}

// ── Kokoro readiness poller ───────────────────────────────────────────────────
//
// Polls GET /health every 2 s until the model is up, then sets model-ready on
// the UI.  The health endpoint returns 200 only after the model is loaded.

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

    // Start polling for Kokoro readiness in the background.
    handle.spawn(wait_for_kokoro(ui.as_weak()));

    // Populate the voice list (static for the session).
    ui.set_voices(ModelRc::new(VecModel::from(
        VOICES.iter().map(|&v| SharedString::from(v)).collect::<Vec<_>>(),
    )));

    // ── open-file-dialog ──────────────────────────────────────────────────
    ui.on_open_file_dialog({
        let ui_weak = ui.as_weak();
        let state = state.clone();
        move || {
            let ui_weak = ui_weak.clone();
            let last_dir = state.lock().unwrap().last_dir.clone();
            tokio::task::spawn_blocking(move || {
                let mut dialog = rfd::FileDialog::new()
                    .set_title("Open Script")
                    .add_filter("Script files", &["md", "txt"])
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

    // ── load-file ─────────────────────────────────────────────────────────
    ui.on_load_file({
        let ui_weak = ui.as_weak();
        let state = state.clone();
        move |path| {
            state.lock().unwrap().cancel.store(true, Ordering::SeqCst);

            let result = {
                let mut s = state.lock().unwrap();
                match s.load_script(path.as_str()) {
                    Ok(()) => {
                        let top = s.current_top_index.max(0) as usize;
                        let first_offset = s.pixel_offset(top);
                        Ok((s.slint_blocks(), s.slint_characters(), first_offset))
                    }
                    Err(e) => Err(format!("Failed to load '{path}': {e}")),
                }
            };

            match result {
                Ok((slint_blocks, slint_chars, first_offset)) => {
                    if let Some(ui) = ui_weak.upgrade() {
                        ui.set_blocks(ModelRc::new(VecModel::from(slint_blocks)));
                        ui.set_characters(ModelRc::new(VecModel::from(slint_chars)));
                        ui.set_playing_index(-1);
                        ui.invoke_scroll_to(first_offset);
                    }
                }
                Err(e) => eprintln!("{e}"),
            }
        }
    });

    // ── block-clicked ─────────────────────────────────────────────────────
    ui.on_block_clicked({
        let ui_weak = ui.as_weak();
        let state = state.clone();
        let handle = handle.clone();
        move |original_index| {
            let idx = original_index as usize;
            let mode = state.lock().unwrap().block_mode(idx);

            match mode {
                CharacterMode::Read => {
                    spawn_tts(idx, state.clone(), ui_weak.clone(), handle.clone());
                }
                CharacterMode::Skip => {
                    let offset = {
                        let mut s = state.lock().unwrap();
                        s.current_top_index = idx as i32;
                        s.pixel_offset(idx)
                    };
                    if let Some(ui) = ui_weak.upgrade() {
                        ui.invoke_scroll_to(offset);
                    }
                }
                CharacterMode::Hide => {}
            }
        }
    });

    // ── advance-block (↓ key) ─────────────────────────────────────────────
    ui.on_advance_block({
        let ui_weak = ui.as_weak();
        let state = state.clone();
        let handle = handle.clone();
        move || {
            let playing = ui_weak
                .upgrade()
                .map(|ui| ui.get_playing_index())
                .unwrap_or(-1);

            // Which block do we act on next?
            let target: usize = if playing >= 0 {
                // TTS is running — cancel it and move to the next non-hidden block.
                state.lock().unwrap().cancel.store(true, Ordering::SeqCst);
                if let Some(ui) = ui_weak.upgrade() {
                    ui.set_playing_index(-1);
                }
                let next = state.lock().unwrap().next_non_hidden(playing as usize + 1);
                let Some(t) = next else { return };
                t
            } else {
                let cur = state.lock().unwrap().current_top_index;
                if cur < 0 {
                    let first = state.lock().unwrap().next_non_hidden(0);
                    let Some(t) = first else { return };
                    t
                } else {
                    cur as usize
                }
            };

            let mode = state.lock().unwrap().block_mode(target);

            match mode {
                CharacterMode::Read => {
                    spawn_tts(target, state.clone(), ui_weak.clone(), handle.clone());
                }
                CharacterMode::Skip => {
                    // Scroll the SKIP block to the top so the user can read their
                    // own line.  Advance current_top_index to the next non-hidden
                    // block so the next ↓ press continues from there.
                    let target_offset = {
                        let mut s = state.lock().unwrap();
                        let next = s.next_non_hidden(target + 1);
                        s.current_top_index = next.map(|i| i as i32).unwrap_or(target as i32);
                        s.pixel_offset(target)
                    };
                    if let Some(ui) = ui_weak.upgrade() {
                        ui.invoke_scroll_to(target_offset);
                    }
                }
                CharacterMode::Hide => {
                    let mut s = state.lock().unwrap();
                    let next = s.next_non_hidden(target + 1);
                    s.current_top_index = next.map(|i| i as i32).unwrap_or(-1);
                }
            }
        }
    });

    // ── character-voice-changed ───────────────────────────────────────────
    ui.on_character_voice_changed({
        let ui_weak = ui.as_weak();
        let state = state.clone();
        move |name, voice| {
            let slint_chars = {
                let mut s = state.lock().unwrap();
                s.set_character_voice(name.as_str(), voice.as_str());
                s.slint_characters()
            };
            if let Some(ui) = ui_weak.upgrade() {
                ui.set_characters(ModelRc::new(VecModel::from(slint_chars)));
            }
        }
    });

    // ── character-mode-cycled ─────────────────────────────────────────────
    ui.on_character_mode_cycled({
        let ui_weak = ui.as_weak();
        let state = state.clone();
        move |name| {
            let (slint_blocks, slint_chars) = {
                let mut s = state.lock().unwrap();
                s.cycle_character_mode(name.as_str());
                (s.slint_blocks(), s.slint_characters())
            };
            if let Some(ui) = ui_weak.upgrade() {
                ui.set_blocks(ModelRc::new(VecModel::from(slint_blocks)));
                ui.set_characters(ModelRc::new(VecModel::from(slint_chars)));
            }
        }
    });

    // ── character-prev-voice ──────────────────────────────────────────────
    ui.on_character_prev_voice({
        let ui_weak = ui.as_weak();
        let state = state.clone();
        let handle = handle.clone();
        move |name| {
            let (slint_chars, voice) = {
                let mut s = state.lock().unwrap();
                let voice = s.prev_voice(name.as_str());
                (s.slint_characters(), voice)
            };
            if let Some(ui) = ui_weak.upgrade() {
                ui.set_characters(ModelRc::new(VecModel::from(slint_chars)));
            }
            spawn_preview(voice, state.clone(), handle.clone());
        }
    });

    // ── character-next-voice ──────────────────────────────────────────────
    ui.on_character_next_voice({
        let ui_weak = ui.as_weak();
        let state = state.clone();
        let handle = handle.clone();
        move |name| {
            let (slint_chars, voice) = {
                let mut s = state.lock().unwrap();
                let voice = s.next_voice(name.as_str());
                (s.slint_characters(), voice)
            };
            if let Some(ui) = ui_weak.upgrade() {
                ui.set_characters(ModelRc::new(VecModel::from(slint_chars)));
            }
            spawn_preview(voice, state.clone(), handle.clone());
        }
    });

    // ── preview-voice ─────────────────────────────────────────────────────
    ui.on_preview_voice({
        let state = state.clone();
        let handle = handle.clone();
        move |name| {
            let voice = state.lock().unwrap().current_voice_for(name.as_str());
            spawn_preview(voice, state.clone(), handle.clone());
        }
    });

    // ── Run ──────────────────────────────────────────────────────────────
    ui.run()?;
    docker::stop();
    Ok(())
}
