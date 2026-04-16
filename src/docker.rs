use anyhow::{bail, Context, Result};
use std::process::Command;

const CONTAINER_NAME: &str = "kokoro-tts";
const IMAGE: &str = "ghcr.io/remsky/kokoro-fastapi-gpu:latest";

/// Starts the Kokoro container in detached mode and returns the container ID.
/// If a container with the same name is already running, stops it first.
pub fn start() -> Result<String> {
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
    let status = Command::new("docker")
        .args(["stop", CONTAINER_NAME])
        .status();

    match status {
        Ok(s) if s.success() => println!("Container stopped."),
        Ok(s) => eprintln!("docker stop exited with {s}"),
        Err(e) => eprintln!("Failed to run `docker stop`: {e}"),
    }
}
