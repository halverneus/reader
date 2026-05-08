use anyhow::{bail, Context, Result};
use std::process::Command;

const CONTAINER_NAME: &str = "kokoro-tts";
const IMAGE: &str = "ghcr.io/remsky/kokoro-fastapi-gpu:latest";

/// Returns the (ContainerPID, ShimPID) if the container exists.
fn get_container_pids() -> Option<(String, String)> {
    let output = Command::new("docker")
        .args(["inspect", "--format", "{{.State.Pid}}", CONTAINER_NAME])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let c_pid = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if c_pid == "0" || c_pid.is_empty() {
        return None;
    }

    // Find the parent PID (the shim)
    let ps_output = Command::new("ps")
        .args(["-o", "ppid=", "-p", &c_pid])
        .output()
        .ok()?;

    if !ps_output.status.success() {
        return Some((c_pid, "unknown".to_string()));
    }

    let s_pid = String::from_utf8_lossy(&ps_output.stdout).trim().to_string();
    Some((c_pid, s_pid))
}

/// Starts the Kokoro container in detached mode and returns the container ID.
/// If a container with the same name is already running, stops it first.
pub fn start() -> Result<String> {
    // Check for existing container and provide escape hatch before trying to remove it
    if let Some((c_pid, s_pid)) = get_container_pids() {
        println!("[INFO] Existing container found (Host PID: {c_pid}, Shim PID: {s_pid}).");
        println!("[INFO] If startup hangs, run: sudo kill -9 {s_pid} {c_pid}");
    }

    // Clean up any leftover container from a previous run.
    let _ = Command::new("docker")
        .args(["rm", "-f", CONTAINER_NAME])
        .output();

    let output = Command::new("docker")
        .args([
            "run",
            "--gpus", "all",
            "-p", "8880:8880",
            "--name", CONTAINER_NAME,
            "--rm",
            "-d",
            IMAGE,
        ])
        .output()
        .context("Failed to run `docker run`")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("Docker failed to start container: {stderr}");
    }

    let id = String::from_utf8(output.stdout)
        .context("Docker returned non-UTF-8 container ID")?
        .trim()
        .to_string();

    println!("Container started: {id}");
    Ok(id)
}

/// Stops the container by name. Ignores errors (container may already be gone).
pub fn stop() {
    // Attempt a graceful stop first with a short timeout
    let _ = Command::new("docker")
        .args(["stop", "-t", "2", CONTAINER_NAME])
        .status();

    // Force remove just in case
    let _ = Command::new("docker")
        .args(["rm", "-f", CONTAINER_NAME])
        .status();

    println!("Container stopped.");
}
