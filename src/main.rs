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

const VOICES: &[&str] = &[
    "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore",
    "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
    "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael",
    "am_onyx", "am_puck", "am_santa",
    "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
    "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
];

const DEFAULT_VOICE: &str = "af_bella";
const BLOCK_OVERHEAD: f32 = 40.0;
const LINE_HEIGHT: f32 = 18.0;
const CHARS_PER_LINE: usize = 90;
const PREVIEW_TEXT: &str =
    "Hello, this is a preview. Testing one two three. How does this voice sound to you?";

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

#[derive(Clone)]
struct CharacterConfig {
    name: String,
    voice: String,
    mode: CharacterMode,
}

struct ProdData {
    top: Vec<ScriptBlock>,
    current_block: ScriptBlock,
    has_current: bool,
    bottom: Vec<ScriptBlock>,
    status: String,
}

struct AppState {
    blocks: Vec<parser::Block>,
    characters: Vec<CharacterConfig>,
    last_dir: Option<PathBuf>,
    voice_assignments: HashMap<String, String>,
    character_modes: HashMap<String, String>,
    current_top_index: i32,
    cancel: Arc<AtomicBool>,
    production_mode: bool,
    prod_position: i32,
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
            production_mode: false,
            prod_position: -1,
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
                    .unwrap_or_else(|| {
                        if name.eq_ignore_ascii_case("IGNORE") {
                            CharacterMode::Hide
                        } else {
                            CharacterMode::Read
                        }
                    });

                CharacterConfig { name: name.clone(), voice, mode }
            })
            .collect();

        self.current_top_index = self.next_non_hidden(0).map(|i| i as i32).unwrap_or(-1);
        self.prod_position = -1;
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
        self.cycle_to_voice_index(name, (idx + 1) % VOICES.len())
    }

    fn current_voice_for(&self, name: &str) -> String {
        self.characters
            .iter()
            .find(|c| c.name == name)
            .map(|c| c.voice.clone())
            .unwrap_or_else(|| DEFAULT_VOICE.to_string())
    }

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

    fn next_non_hidden(&self, from: usize) -> Option<usize> {
        (from..self.blocks.len()).find(|&i| self.block_mode(i) != CharacterMode::Hide)
    }

    fn estimated_height(&self, block_index: usize) -> f32 {
        let Some(block) = self.blocks.get(block_index) else {
            return LINE_HEIGHT + BLOCK_OVERHEAD;
        };
        let display_lines: usize = block
            .content
            .lines()
            .map(|l| if l.is_empty() { 1 } else { (l.len() + CHARS_PER_LINE - 1) / CHARS_PER_LINE })
            .sum::<usize>()
            .max(1);
        BLOCK_OVERHEAD + display_lines as f32 * LINE_HEIGHT
    }

    fn max_block_height(&self) -> f32 {
        self.blocks
            .iter()
            .enumerate()
            .filter(|(i, _)| self.block_mode(*i) != CharacterMode::Hide)
            .map(|(i, _)| self.estimated_height(i))
            .fold(80.0f32, f32::max)
            + 20.0
    }

    fn visible_blocks(&self) -> Vec<usize> {
        (0..self.blocks.len())
            .filter(|&i| self.block_mode(i) != CharacterMode::Hide)
            .collect()
    }

    fn make_slint_block(&self, block_idx: usize) -> ScriptBlock {
        let b = &self.blocks[block_idx];
        ScriptBlock {
            marker: SharedString::from(b.marker.as_str()),
            original_index: block_idx as i32,
            character: SharedString::from(b.character.as_str()),
            content: SharedString::from(b.content.as_str()),
            mode: SharedString::from(self.block_mode(block_idx).as_str()),
        }
    }

    fn slint_blocks(&self) -> Vec<ScriptBlock> {
        self.blocks
            .iter()
            .enumerate()
            .filter(|(i, _)| self.block_mode(*i) != CharacterMode::Hide)
            .map(|(i, _)| self.make_slint_block(i))
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

    fn prod_data(&self) -> ProdData {
        let visible = self.visible_blocks();
        let total = visible.len();

        let cur_pos = if self.prod_position < 0 {
            None
        } else {
            visible.iter().position(|&i| i == self.prod_position as usize)
        };

        match cur_pos {
            None => ProdData {
                top: vec![],
                current_block: ScriptBlock::default(),
                has_current: false,
                bottom: visible.iter().map(|&i| self.make_slint_block(i)).collect(),
                status: format!("0 / {total}"),
            },
            Some(cur) => {
                let top = visible[..cur].iter().map(|&i| self.make_slint_block(i)).collect();
                let current_block = self.make_slint_block(visible[cur]);
                let bottom = visible[cur + 1..].iter().map(|&i| self.make_slint_block(i)).collect();
                ProdData {
                    top,
                    current_block,
                    has_current: true,
                    bottom,
                    status: format!("{} / {total}", cur + 1),
                }
            }
        }
    }
}

// ── TTS helpers ───────────────────────────────────────────────────────────────

fn spawn_tts(
    block_index: usize,
    state: Arc<Mutex<AppState>>,
    ui_weak: slint::Weak<AppWindow>,
    handle: tokio::runtime::Handle,
) {
    let (content, voice, cancel) = {
        let mut s = state.lock().unwrap();
        s.cancel.store(true, Ordering::SeqCst);
        let cancel = Arc::new(AtomicBool::new(false));
        s.cancel = cancel.clone();
        if !s.production_mode {
            s.current_top_index = block_index as i32;
        }
        let content = s.blocks[block_index].content.clone();
        let voice = s.voice_for_block(block_index);
        (content, voice, cancel)
    };

    if let Some(ui) = ui_weak.upgrade() {
        ui.set_playing_index(block_index as i32);
    }

    handle.spawn(async move {
        if let Err(e) = tts::speak(content, voice, cancel).await {
            eprintln!("TTS error: {e}");
        }
        let _ = slint::invoke_from_event_loop(move || {
            if let Some(ui) = ui_weak.upgrade() {
                if ui.get_playing_index() == block_index as i32 {
                    ui.set_playing_index(-1);
                }
            }
        });
    });
}

fn spawn_preview(voice: String, state: Arc<Mutex<AppState>>, handle: tokio::runtime::Handle) {
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

// ── Production mode advance ───────────────────────────────────────────────────

fn advance_production(
    state: Arc<Mutex<AppState>>,
    ui_weak: slint::Weak<AppWindow>,
    handle: tokio::runtime::Handle,
) {
    let (block_index, mode, data) = {
        let mut s = state.lock().unwrap();
        s.cancel.store(true, Ordering::SeqCst);

        let visible = s.visible_blocks();
        if visible.is_empty() {
            return;
        }

        let next_idx = if s.prod_position < 0 {
            visible[0]
        } else {
            match visible.iter().position(|&i| i == s.prod_position as usize) {
                Some(p) if p + 1 < visible.len() => visible[p + 1],
                _ => return,
            }
        };

        s.prod_position = next_idx as i32;
        let mode = s.block_mode(next_idx);
        let data = s.prod_data();
        (next_idx, mode, data)
    };

    if let Some(ui) = ui_weak.upgrade() {
        ui.set_playing_index(-1);
        ui.set_prod_top_blocks(ModelRc::new(VecModel::from(data.top)));
        ui.set_prod_current_block(data.current_block);
        ui.set_prod_has_current(data.has_current);
        ui.set_prod_bottom_blocks(ModelRc::new(VecModel::from(data.bottom)));
        ui.set_prod_status(SharedString::from(data.status));
        ui.invoke_scroll_past_to_bottom();
    }

    if mode == CharacterMode::Read {
        spawn_tts(block_index, state, ui_weak, handle);
    }
}

// ── Browse mode advance ───────────────────────────────────────────────────────

fn advance_browse(
    state: Arc<Mutex<AppState>>,
    ui_weak: slint::Weak<AppWindow>,
    handle: tokio::runtime::Handle,
) {
    let playing = ui_weak
        .upgrade()
        .map(|ui| ui.get_playing_index())
        .unwrap_or(-1);

    let target: usize = if playing >= 0 {
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
            spawn_tts(target, state, ui_weak, handle);
        }
        CharacterMode::Skip => {
            let mut s = state.lock().unwrap();
            let next = s.next_non_hidden(target + 1);
            s.current_top_index = next.map(|i| i as i32).unwrap_or(target as i32);
        }
        CharacterMode::Hide => {
            let mut s = state.lock().unwrap();
            let next = s.next_non_hidden(target + 1);
            s.current_top_index = next.map(|i| i as i32).unwrap_or(-1);
        }
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
                        let slint_blocks = s.slint_blocks();
                        let slint_chars = s.slint_characters();
                        let max_h = s.max_block_height();
                        let prod = s.prod_data();
                        Ok((slint_blocks, slint_chars, max_h, prod))
                    }
                    Err(e) => Err(format!("Failed to load '{path}': {e}")),
                }
            };

            match result {
                Ok((slint_blocks, slint_chars, max_h, prod)) => {
                    if let Some(ui) = ui_weak.upgrade() {
                        ui.set_blocks(ModelRc::new(VecModel::from(slint_blocks)));
                        ui.set_characters(ModelRc::new(VecModel::from(slint_chars)));
                        ui.set_playing_index(-1);
                        ui.set_max_block_height(max_h);
                        ui.set_prod_top_blocks(ModelRc::new(VecModel::from(prod.top)));
                        ui.set_prod_current_block(prod.current_block);
                        ui.set_prod_has_current(prod.has_current);
                        ui.set_prod_bottom_blocks(ModelRc::new(VecModel::from(prod.bottom)));
                        ui.set_prod_status(SharedString::from(prod.status));
                    }
                }
                Err(e) => eprintln!("{e}"),
            }
        }
    });

    // ── block-clicked (browse mode only) ──────────────────────────────────
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
                    state.lock().unwrap().current_top_index = idx as i32;
                }
                CharacterMode::Hide => {}
            }
        }
    });

    // ── advance-block ─────────────────────────────────────────────────────
    ui.on_advance_block({
        let ui_weak = ui.as_weak();
        let state = state.clone();
        let handle = handle.clone();
        move || {
            let production = state.lock().unwrap().production_mode;
            if production {
                advance_production(state.clone(), ui_weak.clone(), handle.clone());
            } else {
                advance_browse(state.clone(), ui_weak.clone(), handle.clone());
            }
        }
    });

    // ── toggle-mode ───────────────────────────────────────────────────────
    ui.on_toggle_mode({
        let ui_weak = ui.as_weak();
        let state = state.clone();
        move || {
            let (prod_mode, data) = {
                let mut s = state.lock().unwrap();
                s.cancel.store(true, Ordering::SeqCst);
                s.production_mode = !s.production_mode;
                if s.production_mode {
                    s.prod_position = -1;
                }
                (s.production_mode, s.prod_data())
            };
            if let Some(ui) = ui_weak.upgrade() {
                ui.set_playing_index(-1);
                ui.set_production_mode(prod_mode);
                ui.set_prod_top_blocks(ModelRc::new(VecModel::from(data.top)));
                ui.set_prod_current_block(data.current_block);
                ui.set_prod_has_current(data.has_current);
                ui.set_prod_bottom_blocks(ModelRc::new(VecModel::from(data.bottom)));
                ui.set_prod_status(SharedString::from(data.status));
            }
        }
    });

    // ── reset-production ──────────────────────────────────────────────────
    ui.on_reset_production({
        let ui_weak = ui.as_weak();
        let state = state.clone();
        move || {
            let data = {
                let mut s = state.lock().unwrap();
                s.cancel.store(true, Ordering::SeqCst);
                s.prod_position = -1;
                s.prod_data()
            };
            if let Some(ui) = ui_weak.upgrade() {
                ui.set_playing_index(-1);
                ui.set_prod_top_blocks(ModelRc::new(VecModel::from(data.top)));
                ui.set_prod_current_block(data.current_block);
                ui.set_prod_has_current(data.has_current);
                ui.set_prod_bottom_blocks(ModelRc::new(VecModel::from(data.bottom)));
                ui.set_prod_status(SharedString::from(data.status));
            }
        }
    });

    // ── jump-to-index ─────────────────────────────────────────────────────
    ui.on_jump_to_index({
        let ui_weak = ui.as_weak();
        let state = state.clone();
        let handle = handle.clone();
        move |text| {
            let n: usize = match text.trim().parse::<usize>() {
                Ok(v) if v >= 1 => v - 1,
                _ => return,
            };

            let (block_index, mode, data) = {
                let mut s = state.lock().unwrap();
                s.cancel.store(true, Ordering::SeqCst);
                let visible = s.visible_blocks();
                let Some(&block_idx) = visible.get(n) else { return };
                s.prod_position = block_idx as i32;
                let mode = s.block_mode(block_idx);
                let data = s.prod_data();
                (block_idx, mode, data)
            };

            if let Some(ui) = ui_weak.upgrade() {
                ui.set_playing_index(-1);
                ui.set_prod_top_blocks(ModelRc::new(VecModel::from(data.top)));
                ui.set_prod_current_block(data.current_block);
                ui.set_prod_has_current(data.has_current);
                ui.set_prod_bottom_blocks(ModelRc::new(VecModel::from(data.bottom)));
                ui.set_prod_status(SharedString::from(data.status));
                ui.invoke_scroll_past_to_bottom();
            }

            if mode == CharacterMode::Read {
                spawn_tts(block_index, state.clone(), ui_weak.clone(), handle.clone());
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
            let (slint_blocks, slint_chars, max_h, prod) = {
                let mut s = state.lock().unwrap();
                s.cycle_character_mode(name.as_str());
                // Clamp prod_position if it now refers to a hidden block.
                if s.prod_position >= 0 {
                    let idx = s.prod_position as usize;
                    if s.block_mode(idx) == CharacterMode::Hide {
                        s.prod_position = -1;
                    }
                }
                (s.slint_blocks(), s.slint_characters(), s.max_block_height(), s.prod_data())
            };
            if let Some(ui) = ui_weak.upgrade() {
                ui.set_blocks(ModelRc::new(VecModel::from(slint_blocks)));
                ui.set_characters(ModelRc::new(VecModel::from(slint_chars)));
                ui.set_max_block_height(max_h);
                ui.set_prod_top_blocks(ModelRc::new(VecModel::from(prod.top)));
                ui.set_prod_current_block(prod.current_block);
                ui.set_prod_has_current(prod.has_current);
                ui.set_prod_bottom_blocks(ModelRc::new(VecModel::from(prod.bottom)));
                ui.set_prod_status(SharedString::from(prod.status));
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

    ui.run()?;
    docker::stop();
    Ok(())
}
