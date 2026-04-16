/// A single time-marked block of script content.
#[derive(Debug, Clone)]
pub struct Block {
    pub marker: u32,
    pub character: String,
    pub content: String,
}

pub struct Script {
    /// Blocks in document order (metadata header already stripped).
    pub blocks: Vec<Block>,
    /// Unique character names in first-appearance order.
    pub characters: Vec<String>,
}

/// Parse a Kokoro script file.
///
/// Format rules:
/// - Everything before the first `---` line is metadata and is ignored.
/// - `*N*` on its own line starts a new block (N is the time marker).
/// - `# NAME`, `## NAME`, or `### NAME` sets the current speaker.
///   If a `*N*` block has no such line, the previous speaker carries over.
/// - Fenced code blocks (``` … ```) are stripped from content.
/// - A character named `IGNORE` (case-insensitive) defaults to skipped.
pub fn parse(input: &str) -> Script {
    let body = strip_header(input);

    let mut blocks: Vec<Block> = Vec::new();
    let mut current_marker: Option<u32> = None;
    let mut current_character = String::new();
    let mut current_lines: Vec<&str> = Vec::new();
    let mut in_code_block = false;

    for line in body.lines() {
        // ── Time marker ───────────────────────────────────────────────────
        if let Some(m) = parse_marker(line.trim()) {
            flush(&mut blocks, current_marker, &current_character, &current_lines);
            current_marker = Some(m);
            // Don't reset current_character — continuation blocks inherit
            // the previous speaker (e.g. block *9* with no ### line).
            current_lines.clear();
            in_code_block = false;
            continue;
        }

        // Skip content before the first marker
        if current_marker.is_none() {
            continue;
        }

        // ── Code fence ────────────────────────────────────────────────────
        if line.trim_start().starts_with("```") {
            in_code_block = !in_code_block;
            continue;
        }
        if in_code_block {
            continue;
        }

        // ── Character heading ─────────────────────────────────────────────
        if let Some(name) = parse_character(line) {
            current_character = name;
            continue;
        }

        // ── Regular content ───────────────────────────────────────────────
        current_lines.push(line);
    }

    flush(&mut blocks, current_marker, &current_character, &current_lines);

    // Collect unique characters in order of first appearance.
    let mut seen: Vec<String> = Vec::new();
    for block in &blocks {
        if !block.character.is_empty() && !seen.contains(&block.character) {
            seen.push(block.character.clone());
        }
    }

    Script {
        blocks,
        characters: seen,
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn strip_header(input: &str) -> &str {
    // Find a line that is exactly "---" and return everything after it.
    let mut byte_pos = 0usize;
    for line in input.lines() {
        byte_pos += line.len() + 1; // +1 for newline
        if line.trim() == "---" {
            return &input[byte_pos.min(input.len())..];
        }
    }
    // No separator found — use the whole file.
    input
}

fn parse_marker(line: &str) -> Option<u32> {
    if line.len() > 2 && line.starts_with('*') && line.ends_with('*') {
        let inner = &line[1..line.len() - 1];
        if inner.chars().all(|c| c.is_ascii_digit()) {
            return inner.parse().ok();
        }
    }
    None
}

fn parse_character(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.starts_with('#') {
        let name = trimmed.trim_start_matches('#').trim().to_uppercase();
        if !name.is_empty() {
            return Some(name);
        }
    }
    None
}

fn flush(
    blocks: &mut Vec<Block>,
    marker: Option<u32>,
    character: &str,
    lines: &[&str],
) {
    let Some(m) = marker else { return };

    let content = lines.join("\n").trim().to_string();

    // Only skip a block that has neither a character nor any content.
    if content.is_empty() && character.is_empty() {
        return;
    }

    blocks.push(Block {
        marker: m,
        character: character.to_string(),
        content,
    });
}
