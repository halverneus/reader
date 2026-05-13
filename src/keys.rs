use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio::sync::watch;

use crate::parser::KeyStep;

/// Send keystrokes to the VM.  No-op on non-Linux.
pub async fn run(
    steps: Vec<KeyStep>,
    progress_tx: watch::Sender<usize>,
    cancel: Arc<AtomicBool>,
) {
    #[cfg(target_os = "linux")]
    inner::run(steps, progress_tx, cancel).await;

    #[cfg(not(target_os = "linux"))]
    {
        let _ = (steps, progress_tx, cancel);
        eprintln!("[keys] Keystroke execution is Linux-only");
    }
}

// ── Linux implementation ──────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
mod inner {
    use super::*;

    const KEY_DELAY_MS: u64 = 1;
    const CMD_DELAY_MS: u64 = 60;

    #[derive(Clone)]
    struct Vm {
        uri: String,
        domain: String,
    }

    pub async fn run(
        steps: Vec<KeyStep>,
        progress_tx: watch::Sender<usize>,
        cancel: Arc<AtomicBool>,
    ) {
        let vm = match find_vm() {
            Some(v) => v,
            None => {
                eprintln!("[keys] No running VM found via libvirt");
                return;
            }
        };

        for (i, step) in steps.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            let _ = progress_tx.send(i);

            match step {
                KeyStep::Combo(keys_str) => {
                    let vm2 = vm.clone();
                    let parts: Vec<String> =
                        keys_str.split('+').map(|s| s.trim().to_string()).collect();
                    tokio::task::spawn_blocking(move || send_combo(&vm2, &parts))
                        .await
                        .ok();
                    tokio::time::sleep(std::time::Duration::from_millis(CMD_DELAY_MS)).await;
                }
                KeyStep::Type(text) => {
                    let vm2 = vm.clone();
                    let text2 = text.clone();
                    let cancel2 = cancel.clone();
                    tokio::task::spawn_blocking(move || type_text(&vm2, &text2, &cancel2))
                        .await
                        .ok();
                    tokio::time::sleep(std::time::Duration::from_millis(CMD_DELAY_MS)).await;
                }
                KeyStep::Key(key) => {
                    let vm2 = vm.clone();
                    let qc = key_to_qcode(key);
                    tokio::task::spawn_blocking(move || send_key(&vm2, &qc, false))
                        .await
                        .ok();
                    tokio::time::sleep(std::time::Duration::from_millis(CMD_DELAY_MS)).await;
                }
                KeyStep::Wait(ms) => {
                    tokio::time::sleep(std::time::Duration::from_millis(*ms)).await;
                }
            }
        }
    }

    // ── VM discovery ──────────────────────────────────────────────────────────

    fn find_vm() -> Option<Vm> {
        let uid = read_uid();
        let candidates = [
            format!(
                "/run/user/{uid}/.flatpak/org.gnome.Boxes/xdg-run/libvirt/virtqemud-sock"
            ),
            format!("/run/user/{uid}/libvirt/virtqemud-sock"),
        ];
        for sock in &candidates {
            if !std::path::Path::new(sock).exists() {
                continue;
            }
            let uri = format!("qemu+unix:///session?socket={sock}");
            if let Some(domain) = first_running_domain(&uri) {
                return Some(Vm { uri, domain });
            }
        }
        None
    }

    fn first_running_domain(uri: &str) -> Option<String> {
        let out = std::process::Command::new("virsh")
            .args(["-c", uri, "list", "--state-running", "--name"])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .map(str::to_owned)
    }

    fn read_uid() -> u32 {
        std::fs::read_to_string("/proc/self/status")
            .unwrap_or_default()
            .lines()
            .find(|l| l.starts_with("Uid:"))
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|s| s.parse().ok())
            .unwrap_or(1000)
    }

    // ── QMP helpers ───────────────────────────────────────────────────────────

    fn virsh_qmp(vm: &Vm, json: &str) {
        let _ = std::process::Command::new("virsh")
            .args(["-c", &vm.uri, "qemu-monitor-command", &vm.domain, json])
            .output();
    }

    fn send_key(vm: &Vm, key: &str, shift: bool) {
        let keys_json = if shift {
            format!(
                r#"[{{"type":"qcode","data":"shift"}},{{"type":"qcode","data":"{key}"}}]"#
            )
        } else {
            format!(r#"[{{"type":"qcode","data":"{key}"}}]"#)
        };
        virsh_qmp(
            vm,
            &format!(r#"{{"execute":"send-key","arguments":{{"keys":{keys_json}}}}}"#),
        );
        std::thread::sleep(std::time::Duration::from_millis(KEY_DELAY_MS));
    }

    fn send_combo(vm: &Vm, keys: &[String]) {
        let parts = keys
            .iter()
            .map(|k| {
                let q = key_to_qcode(k);
                format!(r#"{{"type":"qcode","data":"{q}"}}"#)
            })
            .collect::<Vec<_>>()
            .join(",");
        virsh_qmp(
            vm,
            &format!(r#"{{"execute":"send-key","arguments":{{"keys":[{parts}]}}}}"#),
        );
        std::thread::sleep(std::time::Duration::from_millis(CMD_DELAY_MS));
    }

    fn type_text(vm: &Vm, text: &str, cancel: &Arc<AtomicBool>) {
        for ch in text.chars() {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            match char_to_qcode(ch) {
                Some((shift, key)) => send_key(vm, &key, shift),
                None => eprintln!("[keys] No qcode for {:?}", ch),
            }
        }
    }

    fn key_to_qcode(key: &str) -> String {
        match key.to_lowercase().as_str() {
            "enter" | "ret" | "return" => "ret".into(),
            "space" | "spc" => "spc".into(),
            "tab" => "tab".into(),
            "backspace" | "bspc" => "backspace".into(),
            "delete" | "del" => "delete".into(),
            "escape" | "esc" => "esc".into(),
            "up" => "up".into(),
            "down" => "down".into(),
            "left" => "left".into(),
            "right" => "right".into(),
            "f1" => "f1".into(),
            "f2" => "f2".into(),
            "f3" => "f3".into(),
            "f4" => "f4".into(),
            "f5" => "f5".into(),
            "f6" => "f6".into(),
            "f7" => "f7".into(),
            "f8" => "f8".into(),
            "f9" => "f9".into(),
            "f10" => "f10".into(),
            "f11" => "f11".into(),
            "f12" => "f12".into(),
            "ctrl" | "control" => "ctrl".into(),
            "alt" => "alt".into(),
            "shift" => "shift".into(),
            "home" => "home".into(),
            "end" => "end".into(),
            "pageup" | "pgup" => "pgup".into(),
            "pagedown" | "pgdn" => "pgdn".into(),
            s => s.to_string(),
        }
    }

    fn char_to_qcode(c: char) -> Option<(bool, String)> {
        Some(match c {
            'a'..='z' => (false, c.to_string()),
            'A'..='Z' => (true, c.to_ascii_lowercase().to_string()),
            '0'..='9' => (false, c.to_string()),
            ' ' => (false, "spc".into()),
            '\n' => (false, "ret".into()),
            '\t' => (false, "tab".into()),
            '.' => (false, "dot".into()),
            ',' => (false, "comma".into()),
            ';' => (false, "semicolon".into()),
            '\'' => (false, "apostrophe".into()),
            '-' => (false, "minus".into()),
            '=' => (false, "equal".into()),
            '[' => (false, "bracket_left".into()),
            ']' => (false, "bracket_right".into()),
            '/' => (false, "slash".into()),
            '\\' => (false, "backslash".into()),
            '`' => (false, "grave_accent".into()),
            ':' => (true, "semicolon".into()),
            '"' => (true, "apostrophe".into()),
            '_' => (true, "minus".into()),
            '+' => (true, "equal".into()),
            '{' => (true, "bracket_left".into()),
            '}' => (true, "bracket_right".into()),
            '|' => (true, "backslash".into()),
            '~' => (true, "grave_accent".into()),
            '!' => (true, "1".into()),
            '@' => (true, "2".into()),
            '#' => (true, "3".into()),
            '$' => (true, "4".into()),
            '%' => (true, "5".into()),
            '^' => (true, "6".into()),
            '&' => (true, "7".into()),
            '*' => (true, "8".into()),
            '(' => (true, "9".into()),
            ')' => (true, "0".into()),
            '<' => (true, "comma".into()),
            '>' => (true, "dot".into()),
            '?' => (true, "slash".into()),
            _ => return None,
        })
    }
}
