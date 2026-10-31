#!/usr/bin/env node
/**
 * ui-capture: build the evidence an agent must LOOK AT before calling a capture
 * good, and run the mechanical checks that a vision read cannot.
 *
 *   node validate.mjs <captureDir|file.gif>
 *
 * Emits under <captureDir>/review/:
 *   inspect-sheet.png   12 evenly spaced frames, numbered, for one vision read
 *   subtitle-strip.png  the bottom caption band from every frame, stacked, so
 *                       the whole narration is readable in one image
 *   first.png last.png  the endpoints
 *   validate-report.json  per-frame motion signal, caption coverage, frame
 *                       delays, the checks and the verdict
 *
 * The report is evidence, not a verdict on design quality. The skill's rule is
 * that the agent opens inspect-sheet.png and subtitle-strip.png and reads them
 * before reporting; this script only guarantees the images exist, that the clip
 * moves, is smooth, and carries captions.
 *
 * Exit code 1 when a mechanical check fails (frozen clip, choppy timing, no
 * captions, too few frames), so a wrapper can refuse to attach a bad GIF.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const log = (line = "") => process.stdout.write(`${line}\n`);
// ffmpeg writes freezedetect and progress output to stderr and exits 0, so a
// plain execFileSync return value (stdout only) would miss it. spawnSync lets
// both streams be read from a successful run.
const ffmpeg = (args) => {
  const r = spawnSync("ffmpeg", args, { encoding: "utf8" });
  return { code: r.status, text: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
const run = (args) => {
  const r = ffmpeg(args);
  if (r.code !== 0) throw new Error(`ffmpeg failed (${r.code}): ${r.text.slice(-400)}`);
  return r.text;
};
const tryRun = (args) => {
  const r = ffmpeg(args);
  return r.code === 0 ? r.text : null;
};

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

/** Normalised Levenshtein similarity in [0,1], for comparing OCR text to a caption. */
const similarity = (a, b) => {
  const s = a.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const t = b.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!s && !t) return 1;
  if (!s || !t) return 0;
  let prev = Array.from({ length: t.length + 1 }, (_, j) => j);
  for (let i = 1; i <= s.length; i++) {
    const cur = [i];
    for (let j = 1; j <= t.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[t.length] / Math.max(s.length, t.length);
};

if (!have("ffmpeg") || !have("ffprobe")) {
  log("[validate] ffmpeg/ffprobe not found. Install ffmpeg first.");
  process.exit(3);
}

const input = resolve(process.argv[2] ?? ".");
let gifFile = input;
let baseDir = dirname(input);
if (existsSync(join(input, "out.gif"))) {
  gifFile = join(input, "out.gif");
  baseDir = input;
} else if (!existsSync(input)) {
  log(`[validate] nothing to inspect at ${input}`);
  process.exit(2);
}

const reviewDir = join(baseDir, "review");
mkdirSync(reviewDir, { recursive: true });

const probe = (file) => {
  const out = execFileSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height,nb_frames,avg_frame_rate,duration",
      "-of", "json", file],
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

const stats = probe(gifFile);
const checks = [];
const warnings = [];

/* 1. Movement: `tblend=difference` makes each frame the absolute difference
 *    from the previous one, then `blackframe` reports how black (i.e. how
 *    unchanged) each difference frame is as a `pblack` percentage. freezedetect
 *    is deliberately not used: its whole-frame threshold misses a small moving
 *    cursor, which is exactly the motion a UI capture is made of. pblack is an
 *    integer percentage of unchanged pixels, so 100 means identical to the
 *    previous frame and 99 means at least 1% of pixels moved. A clip where
 *    fewer than a tenth of the frames differ at all is a static-screen defect. */
const motionText = tryRun([
  "-i", gifFile,
  "-vf", "tblend=all_mode=difference,blackframe=amount=0:threshold=8",
  "-f", "null", "-",
]);
let activeFrames = 0;
let totalDiffFrames = 0;
if (motionText) {
  const pblacks = [...motionText.matchAll(/pblack:([\d.]+)/g)].map((m) => Number(m[1]));
  totalDiffFrames = pblacks.length;
  activeFrames = pblacks.filter((p) => p < 100).length;
}
const activeFraction = totalDiffFrames ? activeFrames / totalDiffFrames : 0;
if (activeFraction >= 0.1) {
  checks.push({ id: "motion", ok: true, detail: `${Math.round(activeFraction * 100)}% of frames change` });
} else if (activeFraction >= 0.03) {
  warnings.push(`only ${Math.round(activeFraction * 100)}% of frames change; the clip is nearly static`);
  checks.push({ id: "motion", ok: true, detail: `${Math.round(activeFraction * 100)}% of frames change` });
} else {
  checks.push({ id: "motion", ok: false, detail: `only ${Math.round(activeFraction * 100)}% of frames change; the clip is effectively frozen` });
}

/* 2. Smoothness: a GIF's timing is per-frame, so the average frame rate is
 *    misleading. gifsicle merges identical consecutive frames (a static hold)
 *    into one frame with a longer delay, which is smaller and plays the same.
 *    What matters for smoothness is the delay on the frames that actually
 *    move: the shortest delay must be 30fps or near it. A shortest delay above
 *    ~45ms means the animation itself is choppy. */
const delayText = execFileSync(
  "ffprobe",
  ["-v", "error", "-select_streams", "v:0", "-show_entries", "frame=duration_time", "-of", "csv=p=0", gifFile],
  { encoding: "utf8" },
);
const delays = delayText
  .split("\n")
  .map((v) => Number(v.trim()))
  .filter((v) => Number.isFinite(v) && v > 0);
const minDelay = delays.length ? Math.min(...delays) : 0;
const maxDelay = delays.length ? Math.max(...delays) : 0;
const motionFps = minDelay ? Number((1 / minDelay).toFixed(1)) : 0;
if (motionFps >= 24) {
  checks.push({ id: "smoothness", ok: true, detail: `moving frames at ${motionFps}fps (min delay ${(minDelay * 1000).toFixed(0)}ms)` });
} else {
  checks.push({ id: "smoothness", ok: false, detail: `moving frames at only ${motionFps}fps (min delay ${(minDelay * 1000).toFixed(0)}ms)` });
}
if (maxDelay > 3) warnings.push(`longest static hold is ${maxDelay.toFixed(1)}s`);

/* 3. Frames present. gifsicle may merge static holds, so a modest count is
 *    normal; the motion check above is the real guard against a dead clip. */
if (stats.frames >= 15) checks.push({ id: "length", ok: true, detail: `${stats.frames} frames` });
else checks.push({ id: "length", ok: false, detail: `only ${stats.frames} frames` });

/* 4. Inspection sheet: 12 evenly spaced frames, labelled, in one image. */
const inspect = join(reviewDir, "inspect-sheet.png");
const sampleCount = 12;
const step = Math.max(1, Math.floor(stats.frames / sampleCount));
run(["-y", "-i", gifFile,
  "-vf", `select='not(mod(n\\,${step}))',scale=426:-1,tile=4x3:padding=6:margin=6`,
  "-frames:v", "1", inspect]);
checks.push({ id: "inspect-sheet", ok: existsSync(inspect), detail: basename(inspect) });

/* 5. Subtitle strip: the bottom band of every sampled frame, stacked, so the
 *    agent can read the full narration in one image instead of scrubbing. */
const strip = join(reviewDir, "subtitle-strip.png");
const bandH = Math.max(40, Math.round(stats.height * 0.16));
const bandY = stats.height - bandH - Math.round(stats.height * 0.02);
const stripCount = Math.min(stats.frames, 16);
const stripStep = Math.max(1, Math.floor(stats.frames / stripCount));
const stripOut = tryRun(["-y", "-i", gifFile,
  "-vf", `select='not(mod(n\\,${stripStep}))',crop=iw:${bandH}:0:${Math.max(0, bandY)},scale=760:-1,tile=1x${stripCount}`,
  "-frames:v", "1", strip]);
checks.push({ id: "subtitle-strip", ok: Boolean(stripOut) && existsSync(strip), detail: basename(strip) });

/* 6. Captions present. The overlay draws the subtitle band as near-white text
 *    on a dark bar in the bottom eighth of the frame. Threshold every pixel to
 *    pure black or pure white at 225, then read the band's mean luma: a frame
 *    with a caption is clearly non-zero, a frame without one is exactly zero.
 *    A clip whose steps all carry narration must show captions on most frames,
 *    which catches a broken or missing overlay. */
const captionText = tryRun([
  "-i", gifFile,
  "-vf", `crop=iw*0.8:ih*0.09:iw*0.10:ih*0.90,lutyuv=y='if(gte(val,225),255,0)',` +
    "signalstats,metadata=print:key=lavfi.signalstats.YAVG",
  "-f", "null", "-",
]);
const yavgs = captionText
  ? [...captionText.matchAll(/YAVG=([\d.]+)/g)].map((m) => Number(m[1]))
  : [];
const captionFrames = yavgs.filter((v) => v > 0.01).length;
const captionFraction = yavgs.length ? captionFrames / yavgs.length : 0;
if (captionFraction >= 0.3) {
  checks.push({ id: "captions", ok: true, detail: `${Math.round(captionFraction * 100)}% of frames carry a caption` });
} else {
  checks.push({
    id: "captions",
    ok: false,
    detail: `only ${Math.round(captionFraction * 100)}% of frames carry a caption; the subtitle overlay is missing or unreadable`,
  });
}

/* 7. Caption text (optional). Mechanical checks prove the clip moves and shows
 *    a caption band; only reading the text proves the narration is the narration
 *    the storyboard asked for. When tesseract is installed, OCR the caption band
 *    of a frame inside each subtitle segment and compare it to the storyboard
 *    text with a fuzzy ratio. This is the deterministic stand-in for watching the
 *    clip: a wrong screen, a stale caption or a garbled overlay shows up here.
 *    Skipped, with a note, when tesseract or the storyboard is unavailable. */
const timelinePath2 = join(baseDir, "timeline.json");
const haveTesseract = have("tesseract");
let captionCheck = null;
if (haveTesseract && existsSync(timelinePath2)) {
  const tl = JSON.parse(readFileSync(timelinePath2, "utf8"));
  const steps = (tl.timeline ?? []).filter((s) => Number.isFinite(s.startFrame));
  const subs = steps
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.action === "subtitle" && String(s.text ?? "").trim());
  const totalFrames = stats.frames;
  const results = [];
  for (let k = 0; k < subs.length; k++) {
    const { s } = subs[k];
    const want = String(s.text).trim();
    // A caption stays up until the next subtitle replaces it, so read from the
    // middle of that whole span, not the frame the subtitle step itself ends on.
    const nextStart = k + 1 < subs.length ? subs[k + 1].s.startFrame : totalFrames;
    const start = s.startFrame + 2;
    const end = Math.max(start + 1, nextStart);
    const mid = Math.min(end - 1, start + Math.floor((end - start) / 2));
    const framePath = join(baseDir, "frames", `f${String(mid).padStart(6, "0")}.jpg`);
    if (!existsSync(framePath)) continue;
    const shot = join(reviewDir, `caption-${results.length}.png`);
    // Keep only near-white pixels as black text on white, then upscale for OCR.
    run(["-y", "-i", framePath,
      "-vf", `crop=iw*0.8:ih*0.08:iw*0.10:ih*0.905,lutyuv=y='if(gte(val,200),0,255)',scale=iw*4:ih*4:flags=lanczos`,
      "-frames:v", "1", shot]);
    const read = execFileSync("tesseract", [shot, "stdout", "--psm", "7"], { encoding: "utf8" }).trim();
    results.push({ want, read, score: similarity(want, read) });
  }
  if (results.length) {
    const mean = results.reduce((a, r) => a + r.score, 0) / results.length;
    const ok = results.every((r) => r.score >= 0.5);
    captionCheck = { results, mean: Number(mean.toFixed(3)) };
    checks.push({
      id: "caption-text",
      ok,
      detail: ok
        ? `${results.length} captions read back, mean match ${Math.round(mean * 100)}%`
        : `caption text did not match the storyboard (mean ${Math.round(mean * 100)}%)`,
    });
    if (!ok) {
      for (const r of results) log(`  ! want ${JSON.stringify(r.want)} read ${JSON.stringify(r.read)}`);
    }
  }
} else if (!haveTesseract) {
  warnings.push("tesseract not installed; caption text was not read back");
}

/* 8. Endpoints for a before/after glance. */
run(["-y", "-i", gifFile, "-vf", "select=eq(n\\,0)", "-frames:v", "1", join(reviewDir, "first.png")]);
run(["-y", "-i", gifFile, "-vf", `select=eq(n\\,${Math.max(0, stats.frames - 1)})`, "-frames:v", "1", join(reviewDir, "last.png")]);

const failed = checks.filter((c) => !c.ok);
const report = {
  gif: basename(gifFile),
  ...stats,
  kb: Math.round(statSync(gifFile).size / 1024),
  activeFrames,
  totalDiffFrames,
  activeFraction: Number(activeFraction.toFixed(3)),
  captionFrames,
  captionFraction: Number(captionFraction.toFixed(3)),
  captionText: captionCheck,
  checks,
  warnings,
  verdict: failed.length ? "FAIL" : warnings.length ? "PASS_WITH_WARNINGS" : "PASS",
  instruction:
    "Open review/inspect-sheet.png and review/subtitle-strip.png and read them. " +
    "Confirm each frame matches the step it claims, the cursor lands on the intended " +
    "control, and every caption is legible and correct. A PASS here means the clip is " +
    "smooth and moving; only your eyes can confirm it makes sense.",
};
writeFileSync(join(reviewDir, "validate-report.json"), JSON.stringify(report, null, 2));

log(`[validate] ${report.gif} ${stats.width}x${stats.height} ${stats.fps}fps ${stats.frames}f ${report.kb}KB`);
for (const c of checks) log(`  ${c.ok ? "ok  " : "FAIL"} ${c.id}: ${c.detail}`);
for (const w of warnings) log(`  warn ${w}`);
log(`[validate] verdict ${report.verdict}; evidence in ${reviewDir}`);
process.exit(failed.length ? 1 : 0);
