#!/usr/bin/env node

// Generates a polished GitHub Release body for mausVoice.
//
// Reads:
//   ARTIFACTS_DIR   - downloaded artifact root (dist/)
//   RELEASE_VERSION - e.g. 0.1.3
//   RELEASE_TAG     - e.g. mausVoice-v0.1.3
//   RELEASE_NAME    - e.g. mausVoice v0.1.3
//   RELEASE_PRERELEASE - "true" | "false"
//   RELEASE_NOTES   - optional markdown for "What's new" ("" = auto from commits)
// Writes the final markdown to stdout.

import { promises as fs } from "node:fs";
import path from "node:path";

const artifactsRoot = path.resolve(
  process.env.ARTIFACTS_DIR ?? "dist",
);
const version = process.env.RELEASE_VERSION ?? "";
const tag = process.env.RELEASE_TAG ?? "";
const releaseName = process.env.RELEASE_NAME ?? "";
const prerelease = process.env.RELEASE_PRERELEASE === "true";
const customNotes = process.env.RELEASE_NOTES ?? "";

const repository = process.env.GITHUB_REPOSITORY ?? "";
const [owner, repo] = repository.split("/");

function assetUrl(fileName) {
  const encoded = fileName
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
  return `https://github.com/${owner}/${repo}/releases/download/${tag}/${encoded}`;
}

async function collectFiles(dir) {
  const out = [];
  const queue = [dir];
  while (queue.length) {
    const current = queue.pop();
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  return out;
}

function classify(fileName) {
  const lower = fileName.toLowerCase();
  const ext = path.extname(lower);
  if (lower.includes("setup") || lower.includes("installer") || ext === ".exe") {
    return { platform: "Windows", kind: "installer", label: "Windows installer (.exe)" };
  }
  if (ext === ".msi") return { platform: "Windows", kind: "msi", label: "Windows MSI (.msi)" };
  if (ext === ".appimage") return { platform: "Linux", kind: "appimage", label: "Linux AppImage" };
  if (ext === ".deb") return { platform: "Linux", kind: "deb", label: "Linux DEB (.deb)" };
  if (lower.endsWith(".app.tar.gz")) return { platform: "macOS", kind: "app", label: "macOS app archive" };
  if (ext === ".dmg") return { platform: "macOS", kind: "dmg", label: "macOS DMG (.dmg)" };
  return null;
}

function markdownLink(label, url) {
  return `[${label}](${url})`;
}

async function autoNotes() {
  // Best effort: commits since the previous mausVoice-v* tag (or everything if none).
  const { execSync } = await import("node:child_process");
  try {
    const tags = execSync(
      "git for-each-ref refs/tags/mausVoice-v* --sort=-version:refname --format=%(refname:short)",
      { encoding: "utf8" },
    )
      .trim()
      .split("\n")
      .map((s) => s.trim())
      .find(Boolean);
    const prev = tags;
    const range = prev ? `${prev}..HEAD` : "HEAD";
    const log = execSync(`git log ${range} --no-merges --format=%s`, {
      encoding: "utf8",
    }).trim();
    if (!log) return null;
    return log
      .split("\n")
      .filter(Boolean)
      .map((line) => `- ${line.replace(/^[a-z]+(\([^)]*\))?:\s*/i, "")}`)
      .join("\n");
  } catch {
    return null;
  }
}

const files = await collectFiles(artifactsRoot);
const downloads = [];
for (const file of files) {
  const rel = path.relative(artifactsRoot, file).split(path.sep).join(path.posix.sep);
  const info = classify(path.basename(file));
  if (!info) continue;
  downloads.push({ ...info, rel, basename: path.basename(file) });
}

const win = downloads.find((d) => d.platform === "Windows" && d.kind === "installer") ?? downloads.find((d) => d.platform === "Windows");
const mac = downloads.find((d) => d.platform === "macOS" && d.kind === "dmg") ?? downloads.find((d) => d.platform === "macOS");
const linDeb = downloads.find((d) => d.platform === "Linux" && d.kind === "deb");
const linAppImage = downloads.find((d) => d.platform === "Linux" && d.kind === "appimage");

const linuxLinks = [linDeb, linAppImage].filter(Boolean).map((d) => markdownLink(d.basename, assetUrl(d.rel)));

let notes = customNotes.trim();
if (!notes) notes = (await autoNotes()) ?? "";

const body = [
  `# ${releaseName}`,
  "",
  "Voice typing for your own machine. Dictate into any app, clean it up with AI. No account, no subscription.",
  "",
  "---",
  "",
  "## What's new",
  "",
  notes || "This release continues the mausVoice desktop line with the changes on this branch.",
  "",
  "## Downloads",
  "",
  "| Platform | Package |",
  "| --- | --- |",
  ...(mac ? [`| macOS | ${markdownLink(mac.basename, assetUrl(mac.rel))} |`] : []),
  ...(win ? [`| Windows | ${markdownLink(win.basename, assetUrl(win.rel))} |`] : []),
  ...(linuxLinks.length ? [`| Linux | ${linuxLinks.join(" · ")} |`] : []),
  "",
  ...(!mac || !win || !linuxLinks.length
    ? ["> Some platform packages may be missing if a matrix build failed. Check the run log for details.", ""]
    : []),
  "## Installation",
  "",
  prerelease
    ? "This is an **unsigned pre-release** build for personal testing. No code signing or notarization."
    : "Unsigned, self-built binaries for personal use. No code signing or notarization.",
  "",
  "- **macOS** — right-click the `.dmg`, choose **Open**, then confirm. The first launch bypasses the \"unidentified developer\" warning.",
  "- **Windows** — SmartScreen may warn about an unknown publisher. Click **More info → Run anyway**.",
  "- **Linux** — install the `.deb` with `sudo dpkg -i <file>.deb`, or mark the AppImage executable and run it.",
  "",
  "> You'll need your own transcription (Deepgram) and cleanup (Groq) API keys on first launch. Keys stay on your machine, encrypted.",
  "",
  "---",
  "",
  `Found an issue? [Open one on GitHub](https://github.com/${repository}/issues). · [Repository](https://github.com/${repository}) · [License](LICENCE)`,
];

console.log(body.join("\n"));