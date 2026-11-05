#!/usr/bin/env node
/**
 * ui-capture: turn a captured frame sequence into a smooth GIF, plus an MP4,
 * a contact sheet, and a machine-checkable report.
 *
 *   node encode.mjs <captureDir> [--fps 30] [--width 1280] [--max-seconds 20]
 *   node encode.mjs --check <file.gif>     # validate a GIF and print its stats
 *
 * Pipeline (two-pass palette, the only way to get a clean GIF):
 *   1. palettegen over the whole clip, stats_mode=diff so the moving region
 *      drives the palette rather than the static background.
 *   2. paletteuse with a low bayer dither, which keeps gradients from banding
 *      without the shimmer ordered/random dither adds at 30fps.
 *   3. gifsicle -O3 to shrink the result losslessly.
 *
 * Reads <captureDir>/timeline.json (written by capture.mjs) for the measured
 * capture rate, so the GIF plays at wall-clock speed. Emits:
 *   <captureDir>/out.gif, out.mp4, contact-sheet.png, encode-report.json
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const log = (line = "") => process.stdout.write(`${line}\n`);

const have = (bin) => {
  for (const flag of ["-version", "--version"]) {
    try {
      execFileSync(bin, [flag], { stdio: "ignore" });
      return true;
    } catch {
      // Try the next flag spelling: ffmpeg accepts -version, gifsicle --version.
    }
  }
  return false;
};
const run = (bin, args) => {
  try {
    execFileSync(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
  } catch (err) {
    const stderr = err.stderr ? String(err.stderr) : "";
    throw new Error(`${bin} failed: ${stderr.trim() || err.message}`);
  }
};

/** ffprobe a media file into a small stats object. */
const probe = (file) => {
  const out = execFileSync(
    "ffprobe",
    [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height,nb_frames,avg_frame_rate,duration",
      "-of", "json",
      file,
    ],
    { encoding: "utf8" },
  );
  const s = JSON.parse(out).streams?.[0] ?? {};
  const [num, den] = String(s.avg_frame_rate ?? "0/1").split("/").map(Number);
  return {
    width: Number(s.width) || 0,
    height: Number(s.height) || 0,
    frames: Number(s.nb_frames) || 0,
    fps: den ? Number((num / den).toFixed(2)) : 0,
    durationSec: Number(s.duration) || 0,
  };
};

/* ---------------------------- check mode ---------------------------- */

const argv = process.argv.slice(2);
if (argv[0] === "--check") {
  const file = argv[1];
  if (!file || !existsSync(file)) {
    log(`[encode] --check needs an existing file`);
    process.exit(2);
  }
  if (!have("ffprobe")) {
    log("[encode] ffprobe not found; install ffmpeg to validate.");
    process.exit(3);
  }
  const stats = probe(file);
  const bytes = statSync(file).size;
  // A GIF merges identical consecutive frames into one with a longer delay, so
  // avg_frame_rate understates how smooth the moving part is. Read the real
  // per-frame delays and report the rate of the frames that actually move.
  let movingFps = stats.fps;
  try {
    const delays = execFileSync(
      "ffprobe",
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "frame=duration_time", "-of", "csv=p=0", file],
      { encoding: "utf8" },
    )
      .split("\n")
      .map((v) => Number(v.trim()))
      .filter((v) => Number.isFinite(v) && v > 0);
    const minDelay = delays.length ? Math.min(...delays) : 0;
    if (minDelay) movingFps = Number((1 / minDelay).toFixed(1));
  } catch {
    // Fall back to the average rate when per-frame delays are unavailable.
  }
  log(JSON.stringify({ file: basename(file), ...stats, movingFps, kb: Math.round(bytes / 1024) }, null, 2));
  const problems = [];
  if (movingFps < 24) problems.push(`moving frames run at ${movingFps}fps, below 24fps`);
  if (stats.frames < 10) problems.push(`only ${stats.frames} frames`);
  if (bytes > 10 * 1024 * 1024) problems.push(`${Math.round(bytes / 1024 / 1024)}MB exceeds the 10MB inline limit`);
  if (problems.length) {
    log(`[encode] WARN: ${problems.join("; ")}`);
    process.exit(1);
  }
  log("[encode] OK: smooth, inline-sized GIF.");
  process.exit(0);
}

/* ---------------------------- encode mode --------------------------- */

const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const captureDir = resolve(argv.find((a) => !a.startsWith("--")) ?? ".");
const framesDir = join(captureDir, "frames");
if (!existsSync(framesDir)) {
  log(`[encode] no frames dir at ${framesDir}; run capture.mjs first.`);
  process.exit(2);
}
if (!have("ffmpeg")) {
  log("[encode] ffmpeg not found. Install it: sudo apt-get install -y ffmpeg (Debian) or brew install ffmpeg (macOS).");
  process.exit(3);
}
const haveGifsicle = have("gifsicle");

const timelinePath = join(captureDir, "timeline.json");
const timeline = existsSync(timelinePath) ? JSON.parse(readFileSync(timelinePath, "utf8")) : {};

const frameFiles = readdirSync(framesDir).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort();
if (frameFiles.length === 0) {
  log(`[encode] frames dir is empty`);
  process.exit(2);
}
const pattern = join(framesDir, frameFiles[0].replace(/\d+(?=\.\w+$)/, "%06d"));

// Input frame rate = how fast the frames were actually captured, so the GIF
// runs at wall-clock speed. Fall back to a sane 30 when no timeline exists.
const captureFps = Number(opt("--capture-fps", timeline.captureFps ?? 30)) || 30;
const gifFps = Number(opt("--fps", timeline.gifFps ?? 30));
const maxSeconds = Number(opt("--max-seconds", 20));

// A 30fps GIF longer than maxSeconds is a download the reviewer will not open.
// Cap by dropping frames evenly (not by truncating), so the whole flow survives.
const nativeSeconds = frameFiles.length / captureFps;
const fpsForCap = nativeSeconds > maxSeconds
  ? Math.max(12, Math.floor((frameFiles.length / maxSeconds)))
  : gifFps;
const useFps = Math.min(gifFps, fpsForCap);

const outGif = join(captureDir, "out.gif");
const outMp4 = join(captureDir, "out.mp4");
const sheet = join(captureDir, "contact-sheet.png");
const palette = join(captureDir, ".palette.png");

// Even width for yuv420p; GIF tolerates odd, the MP4 does not.
let width = Number(opt("--width", 0));
if (!width && timeline.viewport) width = timeline.viewport.width;
if (!width) width = 1280;
const scale = `scale=${width}:-1:flags=lanczos`;

log(`[encode] ${frameFiles.length} frames @ ${captureFps}fps -> gif ${useFps}fps, width ${width}`);

// Pass 1: palette. Pass 2: apply. The `fps=` filter resamples the capture rate
// down to the GIF rate with motion interpolation, which is what keeps a 60fps
// capture smooth at 30fps.
run("ffmpeg", ["-y", "-framerate", String(captureFps), "-i", pattern,
  "-vf", `${scale},fps=${useFps},palettegen=stats_mode=diff:reserve_transparent=0`, palette]);
run("ffmpeg", ["-y", "-framerate", String(captureFps), "-i", pattern, "-i", palette,
  "-lavfi", `${scale},fps=${useFps}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3`, "-loop", "0", outGif]);

if (haveGifsicle) run("gifsicle", ["-O3", "--careful", outGif, "-o", outGif]);
else log("[encode] gifsicle not found; GIF is unoptimized (larger). Install gifsicle for -O3.");

run("ffmpeg", ["-y", "-framerate", String(captureFps), "-i", pattern,
  "-vf", `fps=${useFps},${scale.replace(":-1", ":-2")}`, "-c:v", "libx264", "-pix_fmt", "yuv420p",
  "-movflags", "+faststart", outMp4]);

// Contact sheet: 8 columns, one row per ~8 frames, evenly sampled so the whole
// timeline is visible in one image the agent can read.
const cols = 8;
const rows = Math.max(1, Math.ceil(Math.min(frameFiles.length, cols * 6) / cols));
run("ffmpeg", ["-y", "-framerate", String(captureFps), "-i", pattern,
  "-vf", `fps=${Math.max(1, Math.min(useFps, Math.ceil(frameFiles.length / (cols * rows))))},${scale},tile=${cols}x${rows}`,
  "-frames:v", "1", sheet]);

const gifStats = probe(outGif);
const report = {
  gif: { file: basename(outGif), ...gifStats, kb: Math.round(statSync(outGif).size / 1024) },
  mp4: { file: basename(outMp4), ...probe(outMp4), kb: Math.round(statSync(outMp4).size / 1024) },
  contactSheet: basename(sheet),
  captureFps,
  gifFps: useFps,
  optimized: haveGifsicle,
  warnings: timeline.errors?.length ? [`${timeline.errors.length} console error(s) during capture`] : [],
};
writeFileSync(join(captureDir, "encode-report.json"), JSON.stringify(report, null, 2));

log(`[encode] out.gif  ${gifStats.width}x${gifStats.height} ${gifStats.fps}fps ${gifStats.frames}f ${report.gif.kb}KB`);
log(`[encode] out.mp4  ${report.mp4.width}x${report.mp4.height} ${report.mp4.fps}fps ${report.mp4.kb}KB`);
log(`[encode] contact-sheet.png, encode-report.json`);
if (report.gif.kb > 10 * 1024) {
  log(`[encode] WARN: GIF is ${Math.round(report.gif.kb / 1024)}MB. Re-run with --width 900 --max-seconds 12.`);
}
