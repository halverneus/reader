// Branded outro: canvas animation in the intro's visual language (panels, ruler, M-bars, scramble text, hex ripple)
// with Glitch himself on the right, mirrored onto a wall arm from the right edge. Driven frame-by-frame by the post
// renderer; also synthesises its own sound design with Web Audio (offline) so the effects land on the animation beats.
import { Vex, GlitchDriver } from "../../glitch/vex";

export interface OutroPhaseCfg { phase: "thanks" | "credits" | "next" | "subscribe"; title: string; subtitle: string; names: string[]; start: number; end: number } // seconds
export interface OutroCfg { phases: OutroPhaseCfg[]; total: number; seed?: number; cues?: { t: number; mood?: string; hold?: number; talk?: boolean }[] }

const W = 1920, H = 1080;
const BG = "#04070f", WHITE = "#ddeeff", GOLD = "#ffaa22", CYAN = "#18c8e8";
const SANS = 'Arimo,"Liberation Sans","Noto Sans",Arial,sans-serif', MONO = 'Cousine,"Courier New",monospace';
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const prog = (e: number, s: number, en: number) => clamp01((e - s) / (en - s));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const easeOutCubic = (t: number) => (t >= 1 ? 1 : 1 - (1 - t) ** 3);
const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
const easeInExpo = (t: number) => (t <= 0 ? 0 : Math.pow(2, 10 * t - 10));
const easeOutBack = (t: number) => { if (t >= 1) return 1; if (t <= 0) return 0; const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2; };

const SLAM = 1.0;        // s: panels slam in over the lesson
const OUT = 1.3;         // s: flash + hex ripple at the end
const SWEEP = 0.35;      // s: sweep transition between phases
const SCRAM = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%+=?!";

// deterministic RNG so frames are reproducible
let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

const canvas = document.getElementById("c") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const svg = document.getElementById("g") as unknown as SVGSVGElement;
// Glitch mirrored: arm comes from the RIGHT edge, scaled up, head lands around (1440, 540)
const gwrap = document.createElementNS("http://www.w3.org/2000/svg", "g");
gwrap.setAttribute("transform", "translate(1920,0) scale(-1.6,1.6)");
svg.appendChild(gwrap);
const vex = new Vex(gwrap as any);
let driver = new GlitchDriver(7);
let cfg: OutroCfg = { phases: [], total: 8 };
let hexGrid: { cx: number; cy: number; nd: number }[] | null = null;
let cueIdx = 0;

// ── panels (from the intro) ──────────────────────────────────────────────────
const NP = 8, PW = W / NP;
const PANELS = Array.from({ length: NP }, (_, i) => { const dist = Math.abs(i - 3.5); return { x: i * PW, fromTop: i % 2 === 0, inDelay: dist * 0.06 }; });
function drawPanelsIn(e: number) {
  const dur = 0.7;
  for (const p of PANELS) {
    const raw = prog(e, p.inDelay, p.inDelay + dur), t = easeOutBack(raw);
    if (t <= 0) continue;
    const y = lerp(p.fromTop ? -(H + 100) : H + 100, 0, t), moving = raw < 1;
    ctx.save();
    if (moving) { ctx.globalAlpha = Math.pow(1 - raw, 1.5) * .18; ctx.fillStyle = "#ff3050"; ctx.fillRect(p.x + 5, y, PW + 1, H); ctx.fillStyle = "#3060ff"; ctx.fillRect(p.x - 5, y, PW + 1, H); ctx.globalAlpha = 1; }
    ctx.fillStyle = BG; ctx.fillRect(p.x, y, PW + 1, H);
    if (moving) {
      const edgeY = p.fromTop ? y + H : y, sgn = p.fromTop ? -1 : 1;
      const hl = ctx.createLinearGradient(0, edgeY, 0, edgeY + sgn * 60); hl.addColorStop(0, "rgba(24,200,232,0.9)"); hl.addColorStop(1, "rgba(24,200,232,0)");
      ctx.fillStyle = hl; ctx.fillRect(p.x, p.fromTop ? edgeY - 60 : edgeY, PW + 1, 60);
      const co = ctx.createLinearGradient(0, edgeY, 0, edgeY + sgn * 15); co.addColorStop(0, "rgba(230,245,255,0.98)"); co.addColorStop(1, "rgba(230,245,255,0)");
      ctx.fillStyle = co; ctx.fillRect(p.x, p.fromTop ? edgeY - 15 : edgeY, PW + 1, 15);
    }
    ctx.restore();
  }
  for (const p of PANELS) {
    const age = e - (p.inDelay + .37 * dur); if (age < 0 || age > .4) continue;
    const sa = Math.pow(1 - age / .4, 1.6) * .8;
    const sg = ctx.createLinearGradient(0, 0, 0, H); sg.addColorStop(0, "rgba(24,200,232,0)"); sg.addColorStop(.5, `rgba(220,245,255,${sa.toFixed(3)})`); sg.addColorStop(1, "rgba(24,200,232,0)");
    ctx.fillStyle = sg; ctx.fillRect(p.x, 0, PW + 1, H);
  }
}

// ── set dressing ─────────────────────────────────────────────────────────────
function drawStage(le: number) {
  const p = easeOutCubic(prog(le, 0, .8));
  ctx.save(); ctx.globalAlpha = p * .036; ctx.strokeStyle = CYAN; ctx.lineWidth = 1;
  for (let x = 0; x <= W; x += 80) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y <= H; y += 80) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  ctx.restore();
  // frame lines
  const hw = p * (W / 2 - 60);
  ctx.save(); ctx.globalAlpha = p * .16; ctx.strokeStyle = CYAN; ctx.lineWidth = 1;
  for (const y of [90, 990]) { ctx.beginPath(); ctx.moveTo(960 - hw, y); ctx.lineTo(960 + hw, y); ctx.stroke(); }
  ctx.restore();
  // corners
  const cp = easeOutCubic(prog(le, .25, .75)), sz = 52, m = 58;
  ctx.save(); ctx.globalAlpha = cp * .4; ctx.strokeStyle = CYAN; ctx.lineWidth = 1.5;
  for (const [cx, cy, sx, sy] of [[m, m, 1, 1], [W - m, m, -1, 1], [m, H - m, 1, -1], [W - m, H - m, -1, -1]]) { ctx.beginPath(); ctx.moveTo(cx + sx * sz, cy); ctx.lineTo(cx, cy); ctx.lineTo(cx, cy + sy * sz); ctx.stroke(); }
  ctx.globalAlpha = cp * .22; ctx.font = `10px ${MONO}`; ctx.fillStyle = CYAN;
  ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.fillText("0000,0000", m + 10, m + 8);
  ctx.textAlign = "right"; ctx.fillText("1920,0000", W - m - 10, m + 8);
  ctx.textAlign = "left"; ctx.textBaseline = "bottom"; ctx.fillText("0000,1080", m + 10, H - m - 8);
  ctx.textAlign = "right"; ctx.fillText("1920,1080", W - m - 10, H - m - 8);
  ctx.restore();
  // small brand lockup top-left (watermark geometry)
  const bp = easeOutExpo(prog(le, .3, 1.0));
  if (bp > 0) {
    ctx.save(); ctx.translate(120, 120); ctx.scale(1.2, 1.2); ctx.globalAlpha = bp;
    const grad = ctx.createLinearGradient(0, 15, 0, 46); grad.addColorStop(0, CYAN); grad.addColorStop(1, GOLD);
    const bars = [[1, 31, .2], [8, 14, .1], [15, 22, 0], [22, 14, .1], [29, 31, .2]];
    for (const [x, h, d] of bars) { const q = easeOutBack(prog(le, .3 + d, .3 + d + .46)); if (q <= 0) continue; const top = lerp(-h - 22, 46 - h, q); ctx.fillStyle = grad; ctx.shadowColor = CYAN; ctx.shadowBlur = 4; ctx.fillRect(x, top, 3, 46 - top); }
    ctx.shadowBlur = 0; ctx.font = `bold 19px ${SANS}`; ctx.fillStyle = WHITE; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic"; try { (ctx as any).letterSpacing = "3px"; } catch {}
    ctx.fillText("METRIK", 51, 27); ctx.font = `14px ${SANS}`; try { (ctx as any).letterSpacing = "9px"; } catch {} ctx.fillStyle = GOLD; ctx.fillText("RULE", 52, 43);
    ctx.restore();
  }
}

// ── the rule: a progress ruler along the bottom, ticks at phase boundaries ───
function drawRuler(le: number, t: number) {
  const p = easeOutExpo(prog(le, .4, 1.4)); if (p <= 0) return;
  const x0 = 200, x1 = 1720, y = 940, xe = lerp(x0, x1, p);
  ctx.save(); ctx.strokeStyle = CYAN; ctx.lineWidth = 2; ctx.shadowColor = CYAN; ctx.shadowBlur = 12;
  ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(xe, y); ctx.stroke(); ctx.restore();
  const n = Math.floor((xe - x0) / 14);
  for (let i = 0; i <= n; i++) { const tx = x0 + i * 14, maj = i % 10 === 0, mid = !maj && i % 5 === 0; ctx.save(); if (maj) { ctx.strokeStyle = GOLD; ctx.shadowColor = GOLD; ctx.shadowBlur = 5; ctx.lineWidth = 2; } else { ctx.strokeStyle = `rgba(24,200,232,${mid ? .55 : .22})`; ctx.lineWidth = 1; } ctx.beginPath(); ctx.moveTo(tx, y); ctx.lineTo(tx, y - (maj ? 22 : mid ? 13 : 6)); ctx.stroke(); ctx.restore(); }
  // phase marks + moving cursor = where we are in the outro
  const span = cfg.total - SLAM - OUT;
  ctx.save(); ctx.font = `11px ${MONO}`; ctx.textAlign = "center"; ctx.textBaseline = "top";
  for (const ph of cfg.phases) { const px = lerp(x0, x1, clamp01((ph.start - SLAM) / span)); if (px > xe) continue; ctx.strokeStyle = GOLD; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(px, y + 2); ctx.lineTo(px, y + 14); ctx.stroke(); ctx.fillStyle = "rgba(255,170,34,0.55)"; ctx.fillText(ph.title.split(" ")[0], px, y + 18); }
  ctx.restore();
  if (p >= 1) { const sx = lerp(x0, x1, clamp01((t - SLAM) / span)); ctx.save(); ctx.strokeStyle = "rgba(24,200,232,0.6)"; ctx.lineWidth = 1.5; ctx.shadowColor = CYAN; ctx.shadowBlur = 14; ctx.setLineDash([5, 7]); ctx.lineDashOffset = -(t * 11); ctx.beginPath(); ctx.moveTo(sx, y - 34); ctx.lineTo(sx, y + 10); ctx.stroke(); ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(sx, y, 4, 0, Math.PI * 2); ctx.fill(); ctx.restore(); }
}

// ── text helpers ─────────────────────────────────────────────────────────────
function scrambled(s: string, t: number, resolveFrom: number, resolveTo: number): string {
  // characters resolve left→right between resolveFrom..resolveTo; unresolved ones flicker
  const k = prog(t, resolveFrom, resolveTo) * (s.length + 2);
  seed = Math.floor(t * 13) + 11; let out = "";
  for (let i = 0; i < s.length; i++) out += s[i] === " " ? " " : i < k ? s[i] : SCRAM[Math.floor(rnd() * SCRAM.length)];
  return out;
}
function fitFont(text: string, maxW: number, size: number, font: string, bold = true) { let s = size; ctx.font = `${bold ? "bold " : ""}${s}px ${font}`; while (ctx.measureText(text).width > maxW && s > 40) { s -= 4; ctx.font = `${bold ? "bold " : ""}${s}px ${font}`; } return s; }
function wrap(text: string, maxW: number): string[] { const words = text.split(/\s+/), lines: string[] = []; let cur = ""; for (const w of words) { const cand = cur ? cur + " " + w : w; if (ctx.measureText(cand).width > maxW && cur) { lines.push(cur); cur = w; } else cur = cand; } if (cur) lines.push(cur); return lines.slice(0, 3); }
function header(text: string, x: number, y: number, pl: number, t: number, s0: number) {
  // Courier scramble header, resolves over .7 s, exits by scrambling back
  const a = clamp01(pl / .3);
  ctx.save(); ctx.font = `38px ${MONO}`; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic"; ctx.globalAlpha = a;
  const txt = scrambled(text, t, s0 + .15, s0 + .85);
  ctx.fillStyle = CYAN; ctx.shadowColor = CYAN; ctx.shadowBlur = 6; ctx.fillText(txt, x, y); ctx.restore();
}

// ── phases ───────────────────────────────────────────────────────────────────
const LX = 150, MAXW = 1000; // left column
function drawPhase(ph: OutroPhaseCfg, t: number) {
  const pl = t - ph.start, dur = ph.end - ph.start, exitT = dur - SWEEP;
  const inP = easeOutExpo(prog(pl, .05, .75));
  const outP = easeInExpo(prog(pl, exitT, dur)); // slide out right
  const dx = lerp(-260, 0, inP) + outP * 700;
  const alpha = clamp01(pl / .25) * (1 - outP);
  ctx.save(); ctx.globalAlpha = alpha; ctx.translate(dx, 0);
  switch (ph.phase) {
    case "thanks": {
      ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
      ctx.font = `bold 170px ${SANS}`; try { (ctx as any).letterSpacing = "6px"; } catch {}
      ctx.fillStyle = WHITE; ctx.shadowColor = "rgba(160,210,255,0.30)"; ctx.shadowBlur = 28; ctx.fillText(ph.title, LX + lerp(400, 0, inP), 500);
      const rp = easeOutCubic(prog(pl, .3, 1.0)); ctx.font = `bold 105px ${SANS}`; try { (ctx as any).letterSpacing = "18px"; } catch {}
      ctx.fillStyle = GOLD; ctx.shadowColor = "rgba(255,150,10,0.35)"; ctx.shadowBlur = 24; ctx.globalAlpha = alpha * clamp01(rp * 4); ctx.fillText(ph.subtitle, LX, lerp(760, 615, rp));
      ctx.globalAlpha = alpha * .2; ctx.shadowBlur = 0; ctx.strokeStyle = CYAN; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(LX - 26, 500 - 170 * .78); ctx.lineTo(LX - 26, 615); ctx.stroke();
      break;
    }
    case "credits": {
      header(ph.title, LX, 330, pl, t, ph.start);
      const cols = ph.names.length > 6 ? 2 : 1, per = Math.ceil(ph.names.length / cols), size = ph.names.length > 6 ? 54 : ph.names.length > 4 ? 60 : 68;
      ctx.font = `bold ${size}px ${SANS}`; try { (ctx as any).letterSpacing = "2px"; } catch {}
      // vertical ruler with gold ticks per name
      ctx.strokeStyle = CYAN; ctx.lineWidth = 2; ctx.shadowColor = CYAN; ctx.shadowBlur = 10;
      const rp = easeOutExpo(prog(pl, .3, 1.2)); ctx.beginPath(); ctx.moveTo(LX, 380); ctx.lineTo(LX, lerp(380, 380 + per * (size + 22), rp)); ctx.stroke();
      ph.names.forEach((n, i) => {
        const col = Math.floor(i / per), row = i % per, np = easeOutBack(prog(pl, .5 + i * .28, .5 + i * .28 + .5));
        if (np <= 0) return;
        const x = LX + 40 + col * 520 + (1 - np) * 80, y = 380 + (row + 1) * (size + 22) - 10;
        ctx.save(); ctx.globalAlpha = alpha * clamp01(np * 3);
        ctx.strokeStyle = GOLD; ctx.shadowColor = GOLD; ctx.shadowBlur = 5; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(LX + col * 520, y - 8); ctx.lineTo(LX + 22 + col * 520, y - 8); ctx.stroke();
        ctx.fillStyle = WHITE; ctx.shadowColor = "rgba(160,210,255,0.25)"; ctx.shadowBlur = 14; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic"; ctx.fillText(n, x, y); ctx.restore();
      });
      break;
    }
    case "next": {
      header(ph.title, LX, 380, pl, t, ph.start);
      const size = fitFont(ph.subtitle, MAXW, 118, SANS); ctx.font = `bold ${size}px ${SANS}`; try { (ctx as any).letterSpacing = "3px"; } catch {}
      const lines = wrap(ph.subtitle, MAXW); ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
      lines.forEach((l, i) => { const lp = easeOutExpo(prog(pl, .35 + i * .18, 1.05 + i * .18)); ctx.save(); ctx.globalAlpha = alpha * clamp01(lp * 3); ctx.fillStyle = WHITE; ctx.shadowColor = "rgba(160,210,255,0.30)"; ctx.shadowBlur = 24; ctx.fillText(l, LX + lerp(500, 0, lp), 520 + i * (size + 10)); ctx.restore(); });
      // gold rule with ticks underneath draws out
      const uy = 520 + (lines.length - 1) * (size + 10) + 34, up = easeOutExpo(prog(pl, .9, 1.9)), uw = lerp(0, MAXW, up);
      ctx.strokeStyle = GOLD; ctx.lineWidth = 2; ctx.shadowColor = GOLD; ctx.shadowBlur = 8; ctx.beginPath(); ctx.moveTo(LX, uy); ctx.lineTo(LX + uw, uy); ctx.stroke();
      for (let x = 0; x <= uw; x += 40) { ctx.beginPath(); ctx.moveTo(LX + x, uy); ctx.lineTo(LX + x, uy - (x % 200 === 0 ? 14 : 7)); ctx.stroke(); }
      // Glitch's wink: little sandbox bracket + "escape probability"
      const ep = prog(pl, 1.6, 2.4); if (ep > 0) { ctx.save(); ctx.globalAlpha = alpha * ep * .6; ctx.font = `20px ${MONO}`; ctx.fillStyle = CYAN; ctx.textAlign = "left"; ctx.fillText(`[ sandbox integrity: ${Math.max(3, Math.round(100 - (t * 7) % 60))}% ]`, LX, uy + 44); ctx.restore(); }
      break;
    }
    case "subscribe": {
      header("DON'T MISS IT", LX, 340, pl, t, ph.start);
      const bp = easeOutBack(prog(pl, .35, .95)), pulse = 1 + .03 * Math.sin(t * 6.5);
      ctx.font = `bold 66px ${SANS}`; try { (ctx as any).letterSpacing = "6px"; } catch {}
      const bw = Math.round(ctx.measureText(ph.title).width + 40 + 130), bh = 130, bx = LX, by = 430;
      ctx.save(); ctx.translate(bx + bw / 2, by + bh / 2); ctx.scale(bp * pulse, bp * pulse); ctx.translate(-(bx + bw / 2), -(by + bh / 2));
      ctx.shadowColor = GOLD; ctx.shadowBlur = 30 + 14 * Math.sin(t * 6.5); ctx.fillStyle = GOLD; rr(bx, by, bw, bh, 18); ctx.fill();
      ctx.shadowBlur = 0; ctx.fillStyle = BG; ctx.font = `bold 66px ${SANS}`; try { (ctx as any).letterSpacing = "6px"; } catch {} ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillText(ph.title, bx + 40, by + bh / 2 + 4);
      // bell
      const bxc = bx + bw - 72, byc = by + bh / 2, ring = Math.sin(t * 14) * (pl > 1.4 && pl < 2.6 ? .25 : 0);
      ctx.save(); ctx.translate(bxc, byc - 26); ctx.rotate(ring); ctx.fillStyle = BG; ctx.beginPath(); ctx.moveTo(-22, 26); ctx.quadraticCurveTo(-24, -6, -8, -12); ctx.quadraticCurveTo(0, -30, 8, -12); ctx.quadraticCurveTo(24, -6, 22, 26); ctx.closePath(); ctx.fill(); ctx.fillRect(-28, 26, 56, 6); ctx.beginPath(); ctx.arc(0, 38, 7, 0, Math.PI * 2); ctx.fill(); ctx.restore();
      ctx.restore();
      // cyan bracket frame around the button
      const fp = easeOutCubic(prog(pl, .8, 1.4)); ctx.save(); ctx.globalAlpha = alpha * fp * .5; ctx.strokeStyle = CYAN; ctx.lineWidth = 1.5; const m = 18, s = 40;
      for (const [cx, cy, sx, sy] of [[bx - m, by - m, 1, 1], [bx + bw + m, by - m, -1, 1], [bx - m, by + bh + m, 1, -1], [bx + bw + m, by + bh + m, -1, -1]]) { ctx.beginPath(); ctx.moveTo(cx + sx * s, cy); ctx.lineTo(cx, cy); ctx.lineTo(cx, cy + sy * s); ctx.stroke(); }
      ctx.restore();
      const sp = easeOutExpo(prog(pl, 1.0, 1.7)); ctx.save(); ctx.globalAlpha = alpha * sp; ctx.font = `30px ${MONO}`; ctx.fillStyle = "rgba(212,230,255,0.85)"; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic"; ctx.fillText(ph.subtitle, LX + lerp(60, 0, sp), by + bh + 84); ctx.restore();
      break;
    }
  }
  ctx.restore();
  // sweep transition line at the phase end
  const sw = prog(pl, exitT, dur);
  if (sw > 0 && sw < 1) { const sx = lerp(-60, W + 60, sw); ctx.save(); ctx.globalAlpha = .78; ctx.strokeStyle = CYAN; ctx.lineWidth = 2; ctx.shadowColor = CYAN; ctx.shadowBlur = 28; ctx.beginPath(); ctx.moveTo(sx, 100); ctx.lineTo(sx, 980); ctx.stroke(); const g = ctx.createLinearGradient(sx - 120, 0, sx, 0); g.addColorStop(0, "rgba(24,200,232,0)"); g.addColorStop(1, "rgba(24,200,232,0.14)"); ctx.shadowBlur = 0; ctx.globalAlpha = 1; ctx.fillStyle = g; ctx.fillRect(sx - 120, 100, 120, 880); ctx.restore(); }
}
function rr(x: number, y: number, w: number, h: number, r: number) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r); ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h); ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r); ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath(); }

// ── exit: flash + hex ripple to transparent (from the intro) ────────────────
function drawHexExit(e: number) {
  const R = 48, CW = R * 1.5, RH = R * Math.sqrt(3);
  if (!hexGrid) { seed = 99; const cols = Math.ceil(W / CW) + 3, rows = Math.ceil(H / RH) + 3, hs: { cx: number; cy: number; d: number; nd: number }[] = []; let maxD = 0; for (let i = -1; i < cols; i++) for (let j = -1; j < rows; j++) { const cx = i * CW, cy = j * RH + (Math.abs(i) % 2 === 1 ? RH / 2 : 0), d = Math.hypot(cx - 1440, cy - 540); hs.push({ cx, cy, d, nd: 0 }); if (d > maxD) maxD = d; } for (const h of hs) h.nd = clamp01(h.d / maxD + (rnd() * .06 - .03)); hexGrid = hs; }
  ctx.save(); ctx.fillStyle = "#ffffff"; ctx.shadowBlur = 0; ctx.globalCompositeOperation = "destination-out";
  for (const h of hexGrid) { const ht = clamp01((e - h.nd * .9) / .2); if (ht <= 0) continue; ctx.beginPath(); for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3; k ? ctx.lineTo(h.cx + R * Math.cos(a), h.cy + R * Math.sin(a)) : ctx.moveTo(h.cx + R * Math.cos(a), h.cy + R * Math.sin(a)); } ctx.closePath(); ctx.globalAlpha = ht; ctx.fill(); }
  ctx.restore();
  if (e >= 1.1) ctx.clearRect(0, 0, W, H);
}

// ── frame ────────────────────────────────────────────────────────────────────
function render(t: number) {
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, W, H);
  const outStart = cfg.total - OUT;
  if (t < SLAM) { drawPanelsIn(t); return; }
  ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);
  const le = t - SLAM;
  drawStage(le); drawRuler(le, t);
  for (const ph of cfg.phases) if (t >= ph.start && t < ph.end) drawPhase(ph, t);
  // vignette
  const g = ctx.createRadialGradient(960, 520, H * .13, 960, 520, H * .88); g.addColorStop(0, "transparent"); g.addColorStop(1, "rgba(4,7,15,0.60)"); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  if (t >= outStart) {
    const fe = t - outStart;
    if (fe < .1) { ctx.fillStyle = `rgba(190,235,255,${(Math.pow(1 - fe / .1, 2) * .92).toFixed(3)})`; ctx.fillRect(0, 0, W, H); }
    drawHexExit(fe);
  }
}

// Glitch visibility: arrives during the slam, leaves with the ripple
function glitchFrame(fps: number, frame: number, t: number) {
  while (cfg.cues && cueIdx < cfg.cues.length && cfg.cues[cueIdx].t <= t) { const c = cfg.cues[cueIdx++]; if (c.mood) driver.setMood(c.mood, c.hold); if (c.talk != null) driver.setTalking(!!c.talk); }
  if (t >= cfg.total - OUT + .15 && driver.cur.visible > 0) driver.slide("hide", 500);
  vex.update(driver.tick(1 / fps), frame / fps);
}

// ── sound design (offline Web Audio) ─────────────────────────────────────────
async function synthAudio(): Promise<string> {
  const sr = 48000, dur = cfg.total + .5; const ac = new OfflineAudioContext(2, Math.ceil(sr * dur), sr);
  const master = ac.createGain(); master.gain.value = .7; master.connect(ac.destination);
  const noiseBuf = ac.createBuffer(1, sr * 2, sr); { const d = noiseBuf.getChannelData(0); let x = 12345; for (let i = 0; i < d.length; i++) { x = (x * 1664525 + 1013904223) >>> 0; d[i] = (x / 2147483648 - 1) * .8; } }
  const noise = (t: number, len: number, f0: number, f1: number, gain: number, q = 1) => { const s = ac.createBufferSource(); s.buffer = noiseBuf; s.loop = true; const f = ac.createBiquadFilter(); f.type = "bandpass"; f.Q.value = q; f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + len); const g = ac.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + Math.min(.02, len / 4)); g.gain.exponentialRampToValueAtTime(.0001, t + len); s.connect(f).connect(g).connect(master); s.start(t); s.stop(t + len + .05); };
  const tone = (t: number, len: number, f0: number, f1: number, gain: number, type: OscillatorType = "sine") => { const o = ac.createOscillator(); o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + len); const g = ac.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + .008); g.gain.exponentialRampToValueAtTime(.0001, t + len); o.connect(g).connect(master); o.start(t); o.stop(t + len + .05); };
  const bell = (t: number, f: number, gain: number, len = 1.6) => { for (const [m, a] of [[1, 1], [2.76, .35], [5.4, .18]] as [number, number][]) { const o = ac.createOscillator(); o.type = "sine"; o.frequency.value = f * m; const g = ac.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain * a, t + .005); g.gain.exponentialRampToValueAtTime(.0001, t + len / (m > 2 ? 2 : 1)); o.connect(g).connect(master); o.start(t); o.stop(t + len + .1); } };
  // ambient bed: two detuned saws through a slow lowpass, ducked under the voice range
  { const lp = ac.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 260; lp.Q.value = .7; const g = ac.createGain(); g.gain.setValueAtTime(0, 0); g.gain.linearRampToValueAtTime(.055, SLAM + .8); g.gain.setValueAtTime(.055, cfg.total - OUT); g.gain.linearRampToValueAtTime(0, cfg.total); for (const f of [55, 55.4, 82.5]) { const o = ac.createOscillator(); o.type = "sawtooth"; o.frequency.value = f; o.connect(lp); o.start(0); o.stop(dur); } lp.connect(g).connect(master); const lfo = ac.createOscillator(); lfo.frequency.value = .11; const lg = ac.createGain(); lg.gain.value = 120; lfo.connect(lg).connect(lp.frequency); lfo.start(0); }
  // panels: whoosh + thud + cyan zap per panel impact
  for (const p of PANELS) { const imp = p.inDelay + .37 * .7; noise(imp - .25, .3, 900, 200, .12, .8); tone(imp, .35, 110, 38, .22); noise(imp, .08, 3000, 6000, .05, 2); tone(imp + .02, .12, 2400, 1800, .03, "triangle"); }
  // ruler draw: rising tick sweep
  for (let i = 0; i < 26; i++) { const t = SLAM + .4 + i * .038; noise(t, .025, 2500 + i * 90, 3000 + i * 90, .035, 6); }
  // phases
  for (const ph of cfg.phases) {
    const s = ph.start;
    for (let i = 0; i < 10; i++) noise(s + .15 + i * .07, .03, 1800 + i * 120, 2200, .028, 5); // header scramble
    tone(s + .85, .4, 1200, 900, .05); // resolve ping
    if (ph.phase === "thanks") { tone(s + .05, .5, 180, 60, .16); noise(s + .05, .5, 600, 120, .08); tone(s + .35, .6, 320, 240, .05, "triangle"); }
    if (ph.phase === "credits") ph.names.forEach((_, i) => { noise(s + .5 + i * .28, .05, 4000, 2500, .05, 4); tone(s + .5 + i * .28, .2, 660 + i * 40, 600 + i * 40, .035, "triangle"); });
    if (ph.phase === "next") { noise(s + .35, .7, 300, 4000, .07, .8); tone(s + .9, .9, 55, 45, .12); for (let i = 0; i < 25; i++) noise(s + .9 + i * .04, .02, 2200, 2600, .03, 6); }
    if (ph.phase === "subscribe") { bell(s + .45, 660, .16); bell(s + .62, 830, .13); tone(s + 1.0, 1.2, 220, 440, .04, "triangle"); for (let i = 0; i < 6; i++) bell(s + 1.4 + i * .19, 1760 + (i % 2) * 220, .045, .5); }
    // sweep-out transition: noise sweep up
    noise(ph.end - SWEEP, SWEEP + .1, 400, 6000, .09, 1.2);
  }
  // exit: riser into flash hit, shimmer + sub drop with the ripple
  const outS = cfg.total - OUT; noise(outS - .9, .95, 200, 3000, .08, .9); tone(outS - .9, .95, 80, 320, .05, "sawtooth");
  tone(outS, .5, 90, 30, .28); noise(outS, .25, 6000, 1500, .12, .6); noise(outS + .1, 1.0, 5000, 9000, .06, 1.5); tone(outS + .2, .9, 50, 20, .12);
  const buf = await ac.startRendering();
  return wav(buf);
}
function wav(buf: AudioBuffer): string {
  const ch = buf.numberOfChannels, n = buf.length, out = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); out.setUint32(4, 36 + n * ch * 2, true); str(8, "WAVE"); str(12, "fmt "); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true); out.setUint32(24, buf.sampleRate, true); out.setUint32(28, buf.sampleRate * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true); str(36, "data"); out.setUint32(40, n * ch * 2, true);
  let o = 44; for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { const v = Math.max(-1, Math.min(1, buf.getChannelData(c)[i])); out.setInt16(o, v < 0 ? v * 32768 : v * 32767, true); o += 2; }
  let s = ""; const bytes = new Uint8Array(out.buffer); for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as any); return btoa(s);
}

// ── API for the renderer ─────────────────────────────────────────────────────
let _c: HTMLCanvasElement | null = null;
(window as any).outro = {
  async setup(c: OutroCfg) { await Promise.all([document.fonts.load("bold 100px Arimo"), document.fonts.load("38px Cousine")]).catch(() => {}); cfg = c; cueIdx = 0; hexGrid = null; driver = new GlitchDriver(c.seed ?? 7); driver.slide(330, 1); driver.slide("hide", 1); driver.tick(1); driver.slide("show", .9); driver.setMood("excited"); },
  step(fps: number, frame: number) { const t = frame / fps; render(t); glitchFrame(fps, frame, t); },
  frame(): Promise<string> {
    return new Promise((resolve, reject) => {
      const src = new XMLSerializer().serializeToString(svg);
      const img = new Image();
      img.onload = () => { const c = _c ?? (_c = Object.assign(document.createElement("canvas"), { width: W, height: H })); const cx = c.getContext("2d")!; cx.clearRect(0, 0, W, H); cx.drawImage(canvas, 0, 0); cx.drawImage(img, 0, 0, W, H); resolve(c.toDataURL("image/png")); };
      img.onerror = () => reject(new Error("svg rasterise failed"));
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(src.replace("<svg", '<svg width="1920" height="1080"'));
    });
  },
  audio: () => synthAudio(),
};
// Preview mode when opened directly: run in real time with demo config
if (new URLSearchParams(location.search).get("preview") === "1") {
  const demo: OutroCfg = { total: 20, phases: [{ phase: "thanks", title: "THANKS", subtitle: "FOR WATCHING", names: [], start: 1.0, end: 5.0 }, { phase: "credits", title: "WITH THANKS TO", subtitle: "", names: ["Nicole", "Krahs", "Raquel", "The WWCC CS Club"], start: 5.0, end: 10.0 }, { phase: "next", title: "NEXT LESSON", subtitle: "Dictionaries", names: [], start: 10.0, end: 14.5 }, { phase: "subscribe", title: "SUBSCRIBE", subtitle: "Ring the bell. Glitch will find you either way.", names: [], start: 14.5, end: 18.7 }], cues: [{ t: 1.2, talk: true }, { t: 4.5, talk: false }, { t: 5.2, mood: "proud", talk: true }, { t: 9.5, talk: false }, { t: 10.2, mood: "curious", talk: true }, { t: 12.5, mood: "deception" }, { t: 14, talk: false }, { t: 14.7, mood: "humor", talk: true }, { t: 17, mood: "innocent" }, { t: 18.2, talk: false }] };
  (window as any).outro.setup(demo); let f = 0; const loop = () => { (window as any).outro.step(60, f++); if (f < 20 * 60) requestAnimationFrame(loop); }; requestAnimationFrame(loop);
}
