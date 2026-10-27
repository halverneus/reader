// Where the voices are, and where the video should open.
//
// Nothing in here knows who is talking. Dev reaches the timeline as spans
// detected in the mic and Glitch as the logged TTS clips, but past that point
// a span is a span: the cold open belongs to whoever speaks first. Every
// script up to Week 06 opened on Dev, so "the first word" and "Dev's first
// word" were the same thing and nobody had to say which one the code meant.
// W06L06 opens on Glitch, mid-sentence, with Dev silent (2026-10-27).
export type Span = [number, number];

export const FPS = 60;
/** The thumbnail finishes fading 1.567 s in; the first word follows 0.5 s later. */
export const COLD_OPEN_FIRST_WORD = 2.067;
/** Where the lesson's picture starts on the timeline. */
export const COLD_OPEN_AT = 1.0;
/** Picture the opener needs to show before anyone speaks. */
export const COLD_OPEN_LEAD = COLD_OPEN_FIRST_WORD - COLD_OPEN_AT;

/** Earliest moment any voice is heard inside [from, to), or undefined for silence. */
export const firstSpeechStart = (spans: Span[], from: number, to: number): number | undefined => {
  const s = spans.filter(([a, b]) => b > from && a < to).map(([a]) => Math.max(a, from));
  return s.length ? Math.min(...s) : undefined;
};

/** Latest moment any voice is still heard inside [from, to), or undefined for silence. */
export const lastSpeechEnd = (spans: Span[], from: number, to: number): number | undefined => {
  const e = spans.filter(([a, b]) => a < to && b > from).map(([, b]) => Math.min(b, to));
  return e.length ? Math.max(...e) : undefined;
};

/** A logged spoken line becomes the stretches where sound is actually coming
 *  out of it. `gaps` are [startMs, endMs] silences inside the wav, so a line
 *  that opens or closes on a [pause] does not drag the first or last word with
 *  it. `t` is the moment the room heard the clip start, in timeline seconds. */
export function voiceSpans(t: number, duration = 0, gaps: [number, number][] = []): Span[] {
  const out: Span[] = [];
  let at = 0;
  for (const [a, b] of [...gaps, [duration, duration] as [number, number]]) {
    if (a > at) out.push([t + at / 1000, t + a / 1000]);
    at = Math.max(at, b);
  }
  return out;
}

/** Trim the wait before the opener's first word so it lands COLD_OPEN_FIRST_WORD
 *  into the video, just after the thumbnail has faded.
 *
 *  `pad` is the lead-in the recording could not supply, in frames. It is zero
 *  in every session so far, because the first marker lands seconds after the
 *  capture starts. It stops being zero if a cold open ever begins talking right
 *  away, which a TTS opener can: Glitch's clip starts about a quarter of a
 *  second after the marker, where Dev takes a breath first. Rather than let the
 *  first word slide under the thumbnail that is still fading, the opener is
 *  pushed that much later down the timeline. */
export function openerTrim(word: number | undefined, fps = FPS): { src0: number; pad: number } | null {
  if (word == null) return null;
  const src0 = Math.max(0, word - COLD_OPEN_LEAD);
  return { src0, pad: Math.round((COLD_OPEN_LEAD - (word - src0)) * fps) };
}
