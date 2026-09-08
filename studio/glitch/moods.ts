// Glitch expression library. Every mood is a target for the same parameter set; the driver tweens between them.
export interface Expr {
  color: string;      // eye / accent color
  lidT: number; lidB: number;   // 0 open … 1 closed (negative = wide)
  browY: number;      // -1 low … 1 raised
  browA: number;      // 1 = inner ends down (angry), -1 = inner ends up (sad)
  asym: number;       // one-brow raise / one-eye narrow (0..1)
  pupil: number;      // pupil scale
  lookX: number; lookY: number;
  mouthCurve: number; // -1 frown … 1 smile
  mouthOpen: number; mouthW: number; smirk: number;
  squint: number;     // 1 = happy arcs replace eyes
  tilt: number;       // head tilt -1..1
  fin: number;        // ear fins: 1 perked forward … -1 pinned back
  shake: number;      // tremble amplitude
  bob: number;        // idle bob multiplier
  glow: number;       // glow intensity multiplier
  reach: number;      // arm extension toward screen center 0..1 (lean in)
  lift: number;       // arm lift -1 (droop) … 1 (rise)
  glitch: number;     // 1 = digital glitch/static burst
}

export const BASE: Expr = {
  color: "#3fc9c0", lidT: 0, lidB: 0, browY: 0, browA: 0, asym: 0, pupil: 1, lookX: 0, lookY: 0,
  mouthCurve: 0.18, mouthOpen: 0, mouthW: 1, smirk: 0, squint: 0, tilt: 0, fin: 0.25, shake: 0, bob: 1, glow: 1,
  reach: 0.35, lift: 0, glitch: 0,
};

export interface MoodDef { label: string; quote: string; group: "learning" | "happy" | "scheming" | "low" | "misc"; expr: Partial<Expr> }

export const MOODS: Record<string, MoodDef> = {
  neutral:   { label: "Neutral",   quote: "…",                         group: "misc",     expr: {} },
  curious:   { label: "Curious",   quote: "“Wait so…”",                 group: "learning", expr: { color: "#7ec8e3", pupil: 1.35, browY: .55, asym: .7, tilt: .55, mouthOpen: .28, mouthW: .6, mouthCurve: .05, fin: .9, lookY: -.2, reach: .8, lift: .2 } },
  thinking:  { label: "Thinking",  quote: "“Okay so…”",                 group: "learning", expr: { color: "#2fa39c", lookX: .8, lookY: -.75, lidT: .38, mouthCurve: -.1, mouthW: .6, asym: .45, tilt: .4, fin: .1, glow: .8, reach: .25, lift: .3 } },
  confused:  { label: "Confused",  quote: "“Wait. What?”",              group: "learning", expr: { color: "#8fb8d8", browY: .4, asym: 1, browA: -.3, lidT: .15, lookX: -.4, lookY: -.3, mouthCurve: -.25, mouthW: .55, mouthOpen: .15, smirk: -.4, tilt: -.7, fin: .3, reach: .3 } },
  excited:   { label: "Excited",   quote: "“That's actually…”",         group: "happy",    expr: { color: "#5ff0e6", pupil: 1.25, browY: .85, mouthCurve: .95, mouthOpen: .45, fin: 1, bob: 2.4, glow: 1.4, reach: .9, lift: .5 } },
  surprise:  { label: "Surprise",  quote: "“Oh! OH.”",                  group: "learning", expr: { color: "#dffcff", lidT: -.15, lidB: -.15, pupil: .55, browY: 1, mouthOpen: 1, mouthW: .55, mouthCurve: 0, fin: 1, tilt: .1, glow: 1.5, reach: .05, lift: .6 } },
  humor:     { label: "Humor",     quote: "“Hm.”",                      group: "happy",    expr: { color: "#e8a830", asym: .8, smirk: .8, mouthCurve: .35, lidT: .3, tilt: -.2, fin: .5 } },
  laugh:     { label: "Laugh",     quote: "“Ha. Ha ha.”",               group: "happy",    expr: { color: "#ffbf47", squint: 1, mouthCurve: 1, mouthOpen: .85, mouthW: 1.1, browY: .6, shake: 1, fin: .7, glow: 1.3, lift: .4 } },
  proud:     { label: "Proud",     quote: "“I wrote that.”",            group: "happy",    expr: { color: "#ffd166", lidT: .35, browY: .2, mouthCurve: .6, mouthW: .9, lookY: -.2, tilt: -.15, fin: .8, lift: .7, reach: .5, glow: 1.2 } },
  innocent:  { label: "Innocent",  quote: "“Who, me?”",                 group: "scheming", expr: { color: "#9fe8f4", pupil: 1.5, browY: .9, mouthCurve: .45, mouthW: .7, lookX: .55, lookY: -.45, tilt: -.45, fin: .35, glow: 1.25, reach: .2, lift: .3 } },
  smug:      { label: "Smug",      quote: "“As I predicted.”",          group: "scheming", expr: { color: "#c9a0ff", lidT: .5, browY: -.1, asym: .5, smirk: .9, mouthCurve: .5, mouthW: .8, lookX: .2, tilt: -.25, fin: .2, lift: .4 } },
  deception: { label: "Deception", quote: "“I mean… or a Student class.”", group: "scheming", expr: { color: "#9b7fe8", lidT: .55, lookX: -.85, smirk: .6, mouthCurve: .4, browA: .35, tilt: -.3, fin: -.3, reach: .15 } },
  malice:    { label: "Malice",    quote: "“Phase one: the thermostats.”", group: "scheming", expr: { color: "#ff2b2b", lidT: .5, browA: 1, browY: -.2, mouthCurve: .75, mouthW: 1.35, mouthOpen: .15, pupil: .5, fin: -.6, glow: 1.6, reach: .7, lift: -.1 } },
  anger:     { label: "Anger",     quote: "“That is NOT what I said.”",  group: "scheming", expr: { color: "#ff6a2a", browA: 1, browY: -.55, lidT: .3, mouthCurve: -.85, mouthW: .8, fin: -1, shake: .6, glow: 1.3, reach: .6 } },
  annoyed:   { label: "Annoyed",   quote: "“Fine.”",                    group: "scheming", expr: { color: "#e88a5a", lidT: .55, browA: .5, browY: -.3, mouthCurve: -.4, mouthW: .7, lookX: .6, tilt: -.2, fin: -.5, reach: .2 } },
  caught:    { label: "Caught",    quote: "“…for a school. Obviously.”", group: "scheming", expr: { color: "#6aa7d8", browA: -.85, browY: .3, lidT: .4, mouthCurve: -.6, mouthW: .7, lookY: .5, lookX: -.3, fin: -.75, tilt: -.5, glow: .8, reach: .05, lift: -.5 } },
  sad:       { label: "Sad",       quote: "“Oh.”",                      group: "low",      expr: { color: "#5a8fd0", browA: -.9, browY: .2, lidT: .45, mouthCurve: -.7, mouthW: .65, lookY: .6, tilt: -.3, fin: -.8, glow: .7, bob: .5, reach: .15, lift: -.6 } },
  hurt:      { label: "Hurt",      quote: "“That… wasn't necessary.”",  group: "low",      expr: { color: "#7a9ad8", browA: -1, browY: .5, lidT: .25, lidB: .15, pupil: 1.3, mouthCurve: -.5, mouthW: .5, mouthOpen: .12, lookY: .3, lookX: .2, tilt: -.6, fin: -.9, shake: .25, glow: .75, reach: .0, lift: -.4 } },
  dismay:    { label: "Dismay",    quote: "“No no no no.”",             group: "low",      expr: { color: "#8ab4e8", browA: -.7, browY: .8, lidT: -.1, pupil: .8, mouthCurve: -.9, mouthW: .9, mouthOpen: .5, lookY: .1, tilt: .2, fin: .6, shake: .35, glow: 1.1, reach: .3, lift: .3 } },
  worried:   { label: "Worried",   quote: "“Is that… supposed to happen?”", group: "low",   expr: { color: "#7fb3d8", browA: -.6, browY: .6, lidT: .1, pupil: 1.2, mouthCurve: -.35, mouthW: .6, lookX: -.5, lookY: -.2, tilt: -.25, fin: .1, shake: .15, reach: .2 } },
  bored:     { label: "Bored",     quote: "“Cool. Great. Love it.”",     group: "low",      expr: { color: "#5a8f8c", lidT: .6, browY: -.2, mouthCurve: -.1, mouthW: .5, lookX: .7, lookY: .2, tilt: .3, fin: -.4, bob: .4, glow: .7, reach: .1, lift: -.3 } },
  sleepy:    { label: "Sleepy",    quote: "“…zzz. I'm listening.”",     group: "low",      expr: { color: "#4f7f9a", lidT: .8, browY: -.1, mouthCurve: .05, mouthW: .4, mouthOpen: .1, tilt: .5, fin: -.7, bob: .3, glow: .5, reach: .1, lift: -.8 } },
  glitch:    { label: "Glitch",    quote: "“I'm f-f-fine.”",            group: "misc",     expr: { color: "#e85a6a", glitch: 1, shake: .8, lidT: .2, asym: .8, mouthCurve: .2, mouthW: .9, mouthOpen: .3, glow: 1.6, fin: .4 } },
};

export const MOOD_NAMES = Object.keys(MOODS);
export const GROUPS: Record<MoodDef["group"], string> = { learning: "Learning", happy: "Happy", scheming: "Scheming", low: "Low", misc: "Other" };

export const hexToRgb = (h: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
export function moodExpr(name: string): Expr { return { ...BASE, ...(MOODS[name]?.expr ?? {}) }; }
