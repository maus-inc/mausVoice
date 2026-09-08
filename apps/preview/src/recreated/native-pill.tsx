/**
 * Native overlay pill — pixel recreation.
 *
 * The real pill is painted by a separate native process
 * (packages/rust_macos_pill, Cairo canvas) outside the webview, so direct
 * reuse is impossible. Every number below is copied from
 * packages/rust_macos_pill/src/constants.rs + draw.rs + rust_pill_shared:
 *
 *  window 200×86 · pill area 48 · min 48×6 → expanded 120×32 ·
 *  radius = min(w,h)/2 capped at EXPANDED_RADIUS 16 ·
 *  bg black lerp(0.6 → 0.92, expand_t) · border white 0.3 inset 0.5px ·
 *  waveform: 3 white waves (freq .8/1.0/1.25, mult 1.6/1.35/1.05,
 *    offsets 0/.85/1.7, opacity 1/.78/.56), stroke 1.6, amplitude
 *    pill_h*0.75*clamp(level*mult, .03, 1.3), pad pill_h*0.1 ·
 *  loading: 2px track white .15, indicator 40% width white .7 ·
 *  paused: centered 40% bar white .45 on track white .1 ·
 *  idle label: Satoshi 12 white ("Click to dictate") ·
 *  edge gradients: black .9*expand_t, left 18% / right 15% ·
 *  expand spring stiffness 200.
 *
 * KNOWN UNKNOWN: the expand spring's damping ratio is not in constants.rs
 * (only SPRING_STIFFNESS 200). The recreation uses damping tuned to settle
 * without overshoot per DESIGN.md ("never spring-bounce on a tool") —
 * flagged in specs/native-pill.md.
 */
import { Box, Typography } from "@mui/material";
import { useReducedMotion } from "framer-motion";
import { useEffect, useRef } from "react";
import { useSpecValue } from "../lib/spec-store";

export type PillPhase = "idle" | "recording" | "loading" | "paused";

const WW = 200;
const WH = 86;
const PILL_AREA_H = 48;
const MIN_W = 48;
const MIN_H = 6;
const IDLE_BG = 0.6;
const BORDER_ALPHA = 0.3;
const SPRING_K = 200;
const SPRING_D = 2 * Math.sqrt(200); // critically damped — see header note
const LEVEL_SMOOTHING = 0.18;
const TARGET_DECAY = 0.985;
const PHASE_STEP = 0.11;
const PHASE_GAIN = 0.32;
const MIN_AMP = 0.03;
const MAX_AMP = 1.3;
const STROKE = 1.6;
const LOAD_FRAC = 0.4;
const LOAD_SPEED = 0.015;

const WAVES = [
  { frequency: 0.8, multiplier: 1.6, phaseOffset: 0, opacity: 1 },
  { frequency: 1.0, multiplier: 1.35, phaseOffset: 0.85, opacity: 0.78 },
  { frequency: 1.25, multiplier: 1.05, phaseOffset: 1.7, opacity: 0.56 },
];

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

const roundedRect = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) => {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
};

export const NativePillCanvas = ({
  phase,
  hovered = false,
  label,
  width = WW,
}: {
  phase: PillPhase;
  hovered?: boolean;
  label?: string;
  width?: number;
}) => {
  const ref = useRef<HTMLCanvasElement>(null);
  const reduceMotion = useReducedMotion();
  // Live spec values — one edit updates every pill instance site-wide.
  const expandedW = useSpecValue("native-pill", "expanded-w", 120);
  const expandedH = useSpecValue("native-pill", "expanded-h", 32);
  const radiusCap = useSpecValue("native-pill", "radius", 16);
  const bgActive = useSpecValue("native-pill", "bg-active", 0.92);
  const stateRef = useRef({ phase, hovered, expandedW, expandedH, radiusCap, bgActive, reduceMotion });
  stateRef.current = { phase, hovered, expandedW, expandedH, radiusCap, bgActive, reduceMotion };

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = WW * dpr;
    canvas.height = WH * dpr;
    ctx.scale(dpr, dpr);

    let expand = phase === "idle" ? 0 : 1;
    let expandV = 0;
    let wavePhase = 0;
    let level = 0;
    let target = 0;
    let loadOffset = 0;
    let raf = 0;
    let t = 0;

    const frame = () => {
      const s = stateRef.current;
      const active = s.phase !== "idle";
      const targetExpand = active || s.hovered ? 1 : 0;
      // Spring integrate (semi-implicit Euler, 60fps dt)
      const dt = 1 / 60;
      const F = -SPRING_K * (expand - targetExpand) - SPRING_D * expandV;
      expandV += F * dt;
      expand += expandV * dt;
      if (s.reduceMotion) expand = targetExpand;

      // Simulated mic input while recording (deterministic shimmer)
      t += 1;
      if (s.phase === "recording" && !s.reduceMotion) {
        target = 0.45 + 0.4 * Math.abs(Math.sin(t * 0.11)) * Math.sin(t * 0.031 + 1) ** 2 + 0.25 * Math.abs(Math.sin(t * 0.043 + 2));
        target = Math.min(1.2, Math.max(0.1, target));
      } else {
        target *= TARGET_DECAY;
      }
      level += (target - level) * LEVEL_SMOOTHING;
      if (!s.reduceMotion) {
        wavePhase += PHASE_STEP + PHASE_GAIN * level;
        loadOffset = (loadOffset + LOAD_SPEED) % 1;
      }

      // ── paint (mirrors draw_pill) ──
      ctx.clearRect(0, 0, WW, WH);
      const pillW = lerp(MIN_W, s.expandedW, expand);
      const pillH = lerp(MIN_H, s.expandedH, expand);
      const collapsedBottom = 6;
      const expandedBottom = (PILL_AREA_H - s.expandedH) / 2;
      const bottom = lerp(collapsedBottom, expandedBottom, expand);
      const rx = (WW - pillW) / 2;
      const ry = WH - bottom - pillH;
      const radius = Math.min((Math.min(pillW, pillH) * 0.5), s.radiusCap);
      const bgAlpha = lerp(IDLE_BG, s.bgActive, expand);

      roundedRect(ctx, rx, ry, pillW, pillH, radius);
      ctx.fillStyle = `rgba(0,0,0,${bgAlpha.toFixed(3)})`;
      ctx.fill();

      const drawClipped = (fn: () => void) => {
        ctx.save();
        roundedRect(ctx, rx, ry, pillW, pillH, radius);
        ctx.clip();
        fn();
        ctx.restore();
      };

      if (expand > 0.1 && (s.phase === "recording" || (s.phase === "paused" && false))) {
        drawClipped(() => {
          const baseline = ry + pillH / 2;
          const pad = pillH * 0.1;
          const waveW = pillW - pad * 2;
          const segments = Math.max(72, Math.floor(waveW / 2));
          for (const cfg of WAVES) {
            const ampF = Math.min(MAX_AMP, Math.max(MIN_AMP, level * cfg.multiplier));
            const amp = Math.max(1, pillH * 0.75 * ampF);
            ctx.strokeStyle = `rgba(255,255,255,${(cfg.opacity * expand).toFixed(3)})`;
            ctx.lineWidth = STROKE;
            ctx.lineCap = "round";
            ctx.lineJoin = "round";
            ctx.beginPath();
            for (let i = 0; i <= segments; i++) {
              const tt = i / segments;
              const x = rx + pad + waveW * tt;
              const y = baseline + amp * Math.sin(cfg.frequency * tt * Math.PI * 2 + wavePhase + cfg.phaseOffset);
              if (i === 0) ctx.moveTo(x, y);
              else ctx.lineTo(x, y);
            }
            ctx.stroke();
          }
        });
      }

      if (expand > 0.1 && s.phase === "loading") {
        drawClipped(() => {
          const barH = 2;
          const cy = ry + pillH / 2;
          const pad = pillH * 0.1;
          const tx = rx + pad;
          const tw = pillW - pad * 2;
          ctx.lineCap = "round";
          ctx.lineWidth = barH;
          ctx.strokeStyle = `rgba(255,255,255,${(0.15 * expand).toFixed(3)})`;
          ctx.beginPath();
          ctx.moveTo(tx, cy);
          ctx.lineTo(tx + tw, cy);
          ctx.stroke();
          const iw = tw * LOAD_FRAC;
          const ix = tx + (tw + iw) * loadOffset - iw;
          const dl = Math.max(ix, tx);
          const dr = Math.min(ix + iw, tx + tw);
          if (dr > dl) {
            ctx.strokeStyle = `rgba(255,255,255,${(0.7 * expand).toFixed(3)})`;
            ctx.beginPath();
            ctx.moveTo(dl, cy);
            ctx.lineTo(dr, cy);
            ctx.stroke();
          }
        });
      }

      if (expand > 0.1 && s.phase === "paused") {
        drawClipped(() => {
          const barH = 2;
          const barY = ry + (pillH - barH) / 2;
          const pad = pillH * 0.1;
          const tx = rx + pad;
          const tw = pillW - pad * 2;
          ctx.fillStyle = `rgba(255,255,255,${(0.1 * expand).toFixed(3)})`;
          ctx.fillRect(tx, barY, tw, barH);
          const iw = tw * LOAD_FRAC;
          ctx.fillStyle = `rgba(255,255,255,${(0.45 * expand).toFixed(3)})`;
          ctx.fillRect(tx + (tw - iw) / 2, barY, iw, barH);
        });
      }

      if (expand > 0.5 && s.phase === "idle" && s.hovered) {
        ctx.font = "12px Satoshi, system-ui, sans-serif";
        ctx.fillStyle = `rgba(255,255,255,${expand.toFixed(3)})`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("Click to dictate", rx + pillW / 2, ry + pillH / 2 + 0.5);
      }

      if (expand > 0.1 && s.phase !== "idle") {
        drawClipped(() => {
          const a = 0.9 * expand;
          const lw = pillW * 0.18;
          const lg = ctx.createLinearGradient(rx, 0, rx + lw, 0);
          lg.addColorStop(0, `rgba(0,0,0,${a.toFixed(3)})`);
          lg.addColorStop(1, "rgba(0,0,0,0)");
          ctx.fillStyle = lg;
          ctx.fillRect(rx, ry, lw, pillH);
          const rs = rx + pillW * 0.85;
          const rw = pillW * 0.15;
          const rg = ctx.createLinearGradient(rs, 0, rx + pillW, 0);
          rg.addColorStop(0, "rgba(0,0,0,0)");
          rg.addColorStop(1, `rgba(0,0,0,${a.toFixed(3)})`);
          ctx.fillStyle = rg;
          ctx.fillRect(rs, ry, rw, pillH);
        });
      }

      roundedRect(ctx, rx + 0.5, ry + 0.5, pillW - 1, pillH - 1, Math.max(0, radius - 0.5));
      ctx.strokeStyle = `rgba(255,255,255,${BORDER_ALPHA})`;
      ctx.lineWidth = 1;
      ctx.stroke();

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  const scale = width / WW;
  return (
    <Box sx={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 0.5 }}>
      <canvas ref={ref} style={{ width, height: WH * scale, display: "block" }} aria-label={`Dictation pill — ${phase}`} role="img" />
      {label && (
        <Typography variant="labelSmall" color="text.secondary">
          {label}
        </Typography>
      )}
    </Box>
  );
};
