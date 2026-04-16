use anyhow::{Context, Result};
use rodio::{Decoder, OutputStream, Sink};
use std::io::Cursor;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

const API_URL: &str = "http://localhost:8880/v1/audio/speech";
const MODEL: &str = "kokoro";

/// POST `text` to Kokoro, buffer the MP3, and play it through the default
/// audio output.  Checks `cancel` every 50 ms — sets the flag to abort early.
pub async fn speak(text: String, voice: String, cancel: Arc<AtomicBool>) -> Result<()> {
    let client = reqwest::Client::new();

    let response = client
        .post(API_URL)
        .json(&serde_json::json!({
            "model": MODEL,
            "voice": voice,
            "input": text,
        }))
        .send()
        .await
        .context("Failed to reach Kokoro API")?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("Kokoro API {status}: {body}");
    }

    let bytes = response.bytes().await.context("Failed to read audio bytes")?;

    tokio::task::spawn_blocking(move || -> Result<()> {
        let (_stream, handle) =
            OutputStream::try_default().context("No audio output device")?;
        let sink = Sink::try_new(&handle).context("Failed to create audio sink")?;
        let source = Decoder::new(Cursor::new(bytes)).context("Failed to decode MP3")?;
        sink.append(source);

        while !sink.empty() {
            if cancel.load(Ordering::Relaxed) {
                sink.stop();
                return Ok(());
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        Ok(())
    })
    .await
    .context("Playback thread panicked")??;

    Ok(())
}
