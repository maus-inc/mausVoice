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
// Writes the final markdown to stdout. RELEASE_NOTES_FILE optionally receives
// the normalized notes alone for the changelog and updater consumers.

import { promises as fs } from "node:fs";
import path from "node:path";
import { collectArtifactFiles } from "./artifact-files.mjs";
import { normalizeReleaseNotes } from "./release-notes.mjs";
import { autoReleaseNotes } from "./auto-release-notes.mjs";

const artifactsRoot = path.resolve(process.env.ARTIFACTS_DIR ?? "dist");
const version = process.env.RELEASE_VERSION ?? "";
const tag = process.env.RELEASE_TAG ?? "";
const releaseName = process.env.RELEASE_NAME ?? "";
const prerelease = process.env.RELEASE_PRERELEASE === "true";
const customNotes = process.env.RELEASE_NOTES ?? "";

const repository = process.env.GITHUB_REPOSITORY ?? "";
const [owner, repo] = repository.split("/");

// House badge chips: local SVGs under docs/assets/badges/ (black capsule,
// inner top highlight, drop shadow, Geist outlines), referenced by absolute
// raw URL so they render on release pages. The title chip (version +
// stable/pre-release channel) changes with every release, so it is a
// shields.io static badge whose values this script bakes in per run,
// styled flat black to sit next to the house badges.
const BADGE_BASE = `https://raw.githubusercontent.com/${owner}/${repo}/main/docs/assets/badges`;

// shields lets `-` act as a segment separator in static badge URLs, so
// literal dashes and underscores in the copy must be doubled.
function shieldsText(s) {
  return s.replaceAll("-", "--").replaceAll("_", "__");
}

const channelLabel = prerelease ? "pre-release" : "stable";
const versionLabel = version ? `v${version}` : tag || "release";
const CHANNEL_BADGE = `https://img.shields.io/badge/${encodeURIComponent(shieldsText(versionLabel))}-${encodeURIComponent(shieldsText(channelLabel))}-000000?style=flat&labelColor=000000`;

// mausVoice logo rendered from the repo so releases carry the brand mark.
const MAUSVOICE_LOGO = `https://raw.githubusercontent.com/${owner}/${repo}/main/branding/mausvoice-logo-256.png`;

// GitHub flattens release assets to their basenames, so asset URLs point at the
// basename only — never the nested artifact-directory path.
function encodeDownloadSegment(value) {
  // encodeURIComponent leaves parentheses untouched, but these URLs are also
  // embedded in Markdown links where parentheses delimit the destination.
  return encodeURIComponent(value)
    .replaceAll("(", "%28")
    .replaceAll(")", "%29");
}

function assetUrl(basename) {
  return `https://github.com/${owner}/${repo}/releases/download/${encodeDownloadSegment(tag)}/${encodeDownloadSegment(basename)}`;
}

const ARTIFACT_TYPES = [
  [
    ".app.tar.gz",
    { platform: "macOS", kind: "app", label: "macOS app archive" },
  ],
  [".dmg", { platform: "macOS", kind: "dmg", label: "macOS DMG (.dmg)" }],
  [
    ".exe",
    {
      platform: "Windows",
      kind: "installer",
      label: "Windows installer (.exe)",
    },
  ],
  [".msi", { platform: "Windows", kind: "msi", label: "Windows MSI (.msi)" }],
  [
    ".appimage",
    { platform: "Linux", kind: "appimage", label: "Linux AppImage" },
  ],
  [".deb", { platform: "Linux", kind: "deb", label: "Linux DEB (.deb)" }],
  [".rpm", { platform: "Linux", kind: "rpm", label: "Linux RPM (.rpm)" }],
];

function classify(fileName) {
  const lower = fileName.toLowerCase();
  // Detached signatures are not installer downloads.
  if (lower.endsWith(".sig")) return null;
  return ARTIFACT_TYPES.find(([suffix]) => lower.endsWith(suffix))?.[1] ?? null;
}

function escapeHtmlText(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeMarkdownText(value) {
  return escapeHtmlText(value)
    .replaceAll("\\", "\\\\")
    .replace(/([\[\]_*`|])/g, "\\$1")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r");
}

function markdownLink(label, url) {
  return `[${escapeMarkdownText(label)}](${url})`;
}

// Badges and download chips live inside `<p align="center">` raw-HTML blocks.
// GitHub does not parse Markdown link syntax inside raw HTML, so a
// `[<img>](url)` here renders as literal text. Emit a real HTML anchor instead.
function badgeImage(src, alt, url, height = 40) {
  const img = `<img src="${src}" alt="${alt}" height="${height}" />`;
  return url ? `<a href="${url}">${img}</a>` : img;
}

function houseBadge(name, alt, url) {
  return badgeImage(`${BADGE_BASE}/${name}.svg`, alt, url);
}

const files = await collectArtifactFiles(artifactsRoot);
const downloads = [];
for (const file of files) {
  const rel = path
    .relative(artifactsRoot, file)
    .split(path.sep)
    .join(path.posix.sep);
  const info = classify(path.basename(file));
  if (!info) continue;
  downloads.push({ ...info, rel, basename: path.basename(file) });
}

const win =
  downloads.find((d) => d.platform === "Windows" && d.kind === "installer") ??
  downloads.find((d) => d.platform === "Windows");
const mac =
  downloads.find((d) => d.platform === "macOS" && d.kind === "dmg") ??
  downloads.find((d) => d.platform === "macOS");
const linDeb = downloads.find(
  (d) => d.platform === "Linux" && d.kind === "deb",
);
const linAppImage = downloads.find(
  (d) => d.platform === "Linux" && d.kind === "appimage",
);
const linRpm = downloads.find(
  (d) => d.platform === "Linux" && d.kind === "rpm",
);

let notes = normalizeReleaseNotes(customNotes);
if (!notes) notes = normalizeReleaseNotes(autoReleaseNotes(tag));
if (!notes)
  notes =
    "This release continues the mausVoice desktop line with the changes on this branch.";
if (process.env.RELEASE_NOTES_FILE) {
  const notesPath = path.resolve(process.env.RELEASE_NOTES_FILE);
  await fs.mkdir(path.dirname(notesPath), { recursive: true });
  await fs.writeFile(notesPath, notes, "utf8");
}

const githubBase = `https://github.com/${owner}/${repo}`;
const releasesUrl = `${githubBase}/releases`;
const licenceUrl = `${githubBase}/blob/main/LICENCE`;

const downloadChips = [
  ...(mac
    ? [
        houseBadge(
          "macos",
          "Download mausVoice for macOS",
          assetUrl(mac.basename),
        ),
      ]
    : []),
  ...(win
    ? [
        houseBadge(
          "windows",
          "Download mausVoice for Windows",
          assetUrl(win.basename),
        ),
      ]
    : []),
  ...(linDeb || linAppImage || linRpm
    ? [
        houseBadge(
          "linux",
          "Download mausVoice for Linux",
          assetUrl((linAppImage ?? linDeb ?? linRpm).basename),
        ),
      ]
    : []),
];

const body = [
  `<p align="center">`,
  `  <img src="${MAUSVOICE_LOGO}" alt="mausVoice" width="110" />`,
  `</p>`,
  "",
  `# ${escapeMarkdownText(releaseName)} <a href="${releasesUrl}"><img src="${CHANNEL_BADGE}" alt="${escapeHtmlText(versionLabel)} ${channelLabel}" /></a>`,
  "",
  "Voice typing for your own machine. Dictate into any app, clean it up with AI. No account, no subscription.",
  "",
  `<p align="center">`,
  `  ${houseBadge("license", "AGPL-3.0 license", licenceUrl)}`,
  `  ${houseBadge("downloads", "Downloads for all platforms", releasesUrl)}`,
  `</p>`,
  "",
  "---",
  "",
  "<details>",
  "<summary><b>What's new</b></summary>",
  "",
  notes,
  "",
  "</details>",
  "",
  "## Downloads",
  "",
  ...(downloadChips.length
    ? [`<p align="center">`, ...downloadChips.map((b) => `  ${b}`), `</p>`, ""]
    : []),
  "| Platform | Package |",
  "| --- | --- |",
  ...(mac
    ? [`| macOS | ${markdownLink(mac.basename, assetUrl(mac.basename))} |`]
    : []),
  ...(win
    ? [`| Windows | ${markdownLink(win.basename, assetUrl(win.basename))} |`]
    : []),
  ...(linDeb || linAppImage || linRpm
    ? [
        `| Linux | ${[linDeb, linAppImage, linRpm]
          .filter(Boolean)
          .map((d) => markdownLink(d.basename, assetUrl(d.basename)))
          .join(" · ")} |`,
      ]
    : []),
  "",
  ...(!mac || !win || !(linDeb || linAppImage)
    ? [
        "> Some platform packages may be missing if a matrix build failed. Check the run log for details.",
        "",
      ]
    : []),
  "## Installation",
  "",
  prerelease
    ? "This is an **unsigned pre-release** build for personal testing. No code signing or notarization."
    : "Unsigned, self-built binaries for personal use. No code signing or notarization.",
  "",
  '- **macOS** — right-click the `.dmg`, choose **Open**, then confirm. The first launch bypasses the "unidentified developer" warning.',
  "- **Windows** — SmartScreen may warn about an unknown publisher. Click **More info → Run anyway**.",
  "- **Linux** — install the `.deb` with `sudo dpkg -i <file>.deb`, or mark the AppImage executable and run it.",
  "",
  "> You'll need your own transcription (Deepgram) and cleanup (Groq) API keys on first launch. Keys stay on your machine, encrypted.",
  "",
  "Grab Your [Free Groq↗](https://console.groq.com/keys) and [Free Deepgram↗](https://console.deepgram.com/) API Keys.",
  "",
  "---",
  "",
  `Found an issue? [Open one on GitHub](${githubBase}/issues). · [Repository](${githubBase}) · [License](LICENCE)`,
];

console.log(body.join("\n"));
