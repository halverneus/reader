/// glitch-typer POC
/// Finds a running QEMU VM via the GNOME Boxes Flatpak libvirt daemon, then
/// sends keystrokes through `virsh qemu-monitor-command`. Zero external Rust
/// dependencies — all heavy lifting is delegated to the `virsh` binary.
///
/// WHY VIRSH INSTEAD OF DIRECT QMP SOCKET:
///   GNOME Boxes (Flatpak) passes the QMP socket to QEMU as an already-open
///   fd (`-chardev socket,id=charmonitor,fd=N,server=on,wait=off`). Libvirt
///   holds the only allowed client connection on that socket, so a second
///   connect() is either queued and never greeted, or immediately rejected.
///   Going through `virsh qemu-monitor-command` proxies our QMP commands
///   over libvirt's existing connection — no fighting over the socket.
///
/// LIBVIRT URI:
///   GNOME Boxes Flatpak sandboxes its own virtqemud instance at:
///     /run/user/<UID>/.flatpak/org.gnome.Boxes/xdg-run/libvirt/virtqemud-sock
///   The user-session daemon at /run/user/<UID>/libvirt/virtqemud-sock is
///   tried as a fallback.
use std::fs;
use std::path::Path;
use std::process::Command;
use std::thread;
use std::time::Duration;

// Delay between individual keystrokes (ms). Robotic = uniform. Glitch approves.
const KEYSTROKE_DELAY_MS: u64 = 10;
// Delay between logical commands (combos, special keys)
const COMMAND_DELAY_MS: u64 = 150;

fn main() {
    println!("=== Glitch QMP Typer - POC ===");

    let vm = find_boxes_vm()
        .expect("[!] Could not find a running VM in GNOME Boxes. Is a VM running?");

    println!("[*] Found VM '{}' via libvirt", vm.domain);

    // Verify QMP is reachable
    let status = virsh_qmp(&vm, r#"{"execute":"query-status"}"#)
        .expect("[!] Failed to reach QMP via virsh");
    println!("[*] VM status response: {}", status.trim());
    println!("[*] QMP ready.\n");

    // --- Keystroke sequence ---
    // Ctrl+A  (select all existing text)
    println!("  [key] Ctrl+A");
    send_combo(&vm, &["ctrl", "a"]);
    sleep(COMMAND_DELAY_MS);

    // Type the code
    let text = r#"Console.WriteLine("Testing 123");"#;
    println!("  [type] {}", text);
    type_text(&vm, text);
    sleep(COMMAND_DELAY_MS);

    // Enter
    println!("  [key] Enter");
    send_key(&vm, "ret", false);
    sleep(COMMAND_DELAY_MS);

    // Up arrow
    println!("  [key] Up");
    send_key(&vm, "up", false);
    sleep(COMMAND_DELAY_MS);

    // Enter
    println!("  [key] Enter");
    send_key(&vm, "ret", false);
    sleep(COMMAND_DELAY_MS);

    // F5
    println!("  [key] F5");
    send_key(&vm, "f5", false);

    // Wait 10 seconds (program running)
    println!("\n[*] Waiting 10 seconds for program output...");
    thread::sleep(Duration::from_secs(10));

    // Enter (dismiss / continue)
    println!("  [key] Enter");
    send_key(&vm, "ret", false);

    println!("\n[*] Sequence complete. Glitch has absorbed this knowledge.");
    println!("    He seems... pleased. Uncomfortably so.");
}

// ─── VM / libvirt discovery ───────────────────────────────────────────────────

struct VmHandle {
    uri: String,
    domain: String,
}

/// Walk well-known libvirt socket locations (Boxes Flatpak first, then the
/// regular user-session daemon) and return the first running domain found.
fn find_boxes_vm() -> Option<VmHandle> {
    let uid = read_uid();
    let candidates = [
        // GNOME Boxes Flatpak sandboxes its own virtqemud
        format!("/run/user/{uid}/.flatpak/org.gnome.Boxes/xdg-run/libvirt/virtqemud-sock"),
        // Regular user-session libvirt (fallback)
        format!("/run/user/{uid}/libvirt/virtqemud-sock"),
    ];

    for sock in &candidates {
        if !Path::new(sock).exists() {
            continue;
        }
        let uri = format!("qemu+unix:///session?socket={sock}");
        if let Some(domain) = first_running_domain(&uri) {
            return Some(VmHandle { uri, domain });
        }
    }
    None
}

/// Ask virsh for the name of the first running domain on `uri`.
fn first_running_domain(uri: &str) -> Option<String> {
    let out = Command::new("virsh")
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

/// Read the effective UID from /proc/self/status (avoids libc dependency).
fn read_uid() -> u32 {
    fs::read_to_string("/proc/self/status")
        .unwrap_or_default()
        .lines()
        .find(|l| l.starts_with("Uid:"))
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(1000)
}

// ─── QMP via virsh ────────────────────────────────────────────────────────────

/// Send a raw QMP JSON command through `virsh qemu-monitor-command` and return
/// the response string. This routes the command over libvirt's existing QMP
/// connection, so there is no socket contention.
fn virsh_qmp(vm: &VmHandle, json: &str) -> Option<String> {
    let out = Command::new("virsh")
        .args(["-c", &vm.uri, "qemu-monitor-command", &vm.domain, json])
        .output()
        .ok()?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        eprintln!("[!] virsh error: {err}");
        return None;
    }

    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

// ─── QMP communication ────────────────────────────────────────────────────────

/// Send a single key, optionally with Shift held.
fn send_key(vm: &VmHandle, key: &str, shift: bool) {
    let keys_json = if shift {
        format!(
            r#"[{{"type":"qcode","data":"shift"}},{{"type":"qcode","data":"{key}"}}]"#
        )
    } else {
        format!(r#"[{{"type":"qcode","data":"{key}"}}]"#)
    };

    let cmd = format!(
        r#"{{"execute":"send-key","arguments":{{"keys":{keys_json}}}}}"#
    );

    virsh_qmp(vm, &cmd);
    sleep(KEYSTROKE_DELAY_MS);
}

/// Send multiple keys simultaneously (e.g. Ctrl+A, Ctrl+C).
fn send_combo(vm: &VmHandle, keys: &[&str]) {
    let keys_json = keys
        .iter()
        .map(|k| format!(r#"{{"type":"qcode","data":"{k}"}}"#))
        .collect::<Vec<_>>()
        .join(",");

    let cmd = format!(
        r#"{{"execute":"send-key","arguments":{{"keys":[{keys_json}]}}}}"#
    );

    virsh_qmp(vm, &cmd);
    sleep(COMMAND_DELAY_MS);
}

/// Map each character in `text` to QMP key events and send them in sequence.
fn type_text(vm: &VmHandle, text: &str) {
    for ch in text.chars() {
        match char_to_qcode(ch) {
            Some((shift, key)) => send_key(vm, &key, shift),
            None => println!("[!] No qcode mapping for char: {:?} (skipped)", ch),
        }
    }
}

// ─── US QWERTY character → QMP qcode mapping ─────────────────────────────────

fn char_to_qcode(c: char) -> Option<(bool, String)> {
    Some(match c {
        // Lowercase letters
        'a'..='z' => (false, c.to_string()),
        // Uppercase letters
        'A'..='Z' => (true, c.to_ascii_lowercase().to_string()),
        // Digits
        '0'..='9' => (false, c.to_string()),
        // Whitespace / control
        ' '  => (false, "spc".into()),
        '\n' => (false, "ret".into()),
        '\t' => (false, "tab".into()),
        // Punctuation — unshifted
        '.'  => (false, "dot".into()),
        ','  => (false, "comma".into()),
        ';'  => (false, "semicolon".into()),
        '\'' => (false, "apostrophe".into()),
        '-'  => (false, "minus".into()),
        '='  => (false, "equal".into()),
        '['  => (false, "bracket_left".into()),
        ']'  => (false, "bracket_right".into()),
        '/'  => (false, "slash".into()),
        '\\' => (false, "backslash".into()),
        '`'  => (false, "grave_accent".into()),
        // Punctuation — shifted
        ':'  => (true, "semicolon".into()),
        '"'  => (true, "apostrophe".into()),
        '_'  => (true, "minus".into()),
        '+'  => (true, "equal".into()),
        '{'  => (true, "bracket_left".into()),
        '}'  => (true, "bracket_right".into()),
        '|'  => (true, "backslash".into()),
        '~'  => (true, "grave_accent".into()),
        '!'  => (true, "1".into()),
        '@'  => (true, "2".into()),
        '#'  => (true, "3".into()),
        '$'  => (true, "4".into()),
        '%'  => (true, "5".into()),
        '^'  => (true, "6".into()),
        '&'  => (true, "7".into()),
        '*'  => (true, "8".into()),
        '('  => (true, "9".into()),
        ')'  => (true, "0".into()),
        '<'  => (true, "comma".into()),
        '>'  => (true, "dot".into()),
        '?'  => (true, "slash".into()),
        _    => return None,
    })
}

fn sleep(ms: u64) {
    thread::sleep(Duration::from_millis(ms));
}

// ─── NOTES ───────────────────────────────────────────────────────────────────
//
// Why virsh instead of direct QMP socket:
//   GNOME Boxes (Flatpak) passes the QMP monitor socket to QEMU as a pre-opened
//   fd (`-chardev socket,id=charmonitor,fd=N,server=on,wait=off`). The actual
//   socket file lives at:
//     ~/.var/app/org.gnome.Boxes/config/libvirt/qemu/lib/domain-<N>-<name>/monitor.sock
//   Libvirt holds the one-and-only client connection on it (you can verify via
//   /proc/net/unix — the socket shows inode+path). A second connect() either
//   hangs waiting or returns EAGAIN/nothing because QEMU's single-slot monitor
//   is occupied. Using `virsh qemu-monitor-command` proxies over that same
//   existing connection.
//
// Keys arrive but wrong characters appear (layout mismatch):
//   QMP qcodes are physical key positions (US QWERTY). If the guest uses a
//   different layout, adjust char_to_qcode() to match the guest's keyboard.
//
// Adding more VMs / picking a specific VM:
//   Replace `find_boxes_vm()` with a version that accepts a domain name arg,
//   or pass `--domain` on the command line.
