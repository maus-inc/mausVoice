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

const artifactsRoot = path.resolve(process.env.ARTIFACTS_DIR ?? "dist");
const version = process.env.RELEASE_VERSION ?? "";
const tag = process.env.RELEASE_TAG ?? "";
const releaseName = process.env.RELEASE_NAME ?? "";
const prerelease = process.env.RELEASE_PRERELEASE === "true";
const customNotes = process.env.RELEASE_NOTES ?? "";

const repository = process.env.GITHUB_REPOSITORY ?? "";
const [owner, repo] = repository.split("/");

// Logo-only shieldcn chips: empty label + empty value + black background.
// <img src="https://shieldcn.dev/badge/-black.svg?logo=<slug>" height="32" />
// Windows logo as data URI (simple-icons removed the windows slug).
const WINDOWS_LOGO =
  "data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI%2BPHBhdGggZmlsbD0iI2ZmZiIgZD0iTTAgMy40NDlMOS43NSAyLjF2OS40NTFIMG0xMC45NDktOS42MDJMMjQgMHYxMS40SDEwLjk0OU0wIDEyLjZoOS43NXY5LjQ1MUwwIDIwLjY5OU0xMC45NDkgMTIuNkgyNFYyNGwtMTIuOS0xLjgwMSIvPjwvc3ZnPg%3D%3D";

// mausVoice logo rendered from the repo so releases carry the brand mark.
const MAUSVOICE_LOGO = `https://raw.githubusercontent.com/${owner}/${repo}/main/branding/mausvoice-logo-256.png`;

// GitHub flattens release assets to their basenames, so asset URLs point at the
// basename only — never the nested artifact-directory path.
function assetUrl(basename) {
  const encoded = encodeURIComponent(basename);
  return `https://github.com/${owner}/${repo}/releases/download/${tag}/${encoded}`;
}

async function collectFiles(dir) {
  const out = [];
  const queue = [dir];
  while (queue.length) {
    const current = queue.pop();
    const entries = await fs
      .readdir(current, { withFileTypes: true })
      .catch(() => []);
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
  // Detached minisign signatures are never downloadable installers — skip
  // them so a `mausVoice_x.x.x_x64-setup.exe.sig` isn't offered as a Windows
  // installer download.
  if (lower.endsWith(".sig")) return null;
  if (lower.endsWith(".app.tar.gz"))
    return { platform: "macOS", kind: "app", label: "macOS app archive" };
  if (lower.endsWith(".dmg"))
    return { platform: "macOS", kind: "dmg", label: "macOS DMG (.dmg)" };
  if (lower.endsWith(".exe"))
    return {
      platform: "Windows",
      kind: "installer",
      label: "Windows installer (.exe)",
    };
  if (lower.endsWith(".msi"))
    return { platform: "Windows", kind: "msi", label: "Windows MSI (.msi)" };
  if (lower.endsWith(".appimage"))
    return { platform: "Linux", kind: "appimage", label: "Linux AppImage" };
  if (lower.endsWith(".deb"))
    return { platform: "Linux", kind: "deb", label: "Linux DEB (.deb)" };
  if (lower.endsWith(".rpm"))
    return { platform: "Linux", kind: "rpm", label: "Linux RPM (.rpm)" };
  return null;
}

function markdownLink(label, url) {
  return `[${label}](${url})`;
}

// Badges and download chips live inside `<p align="center">` raw-HTML blocks.
// GitHub does not parse Markdown link syntax inside raw HTML, so a
// `[<img>](url)` here renders as literal text. Emit a real HTML anchor instead.
function badgeImage(src, alt, url) {
  const img = `<img src="${src}" alt="${alt}" height="32" />`;
  return url ? `<a href="${url}">${img}</a>` : img;
}

function logoChip(slug, alt, url) {
  return badgeImage(
    `https://shieldcn.dev/badge/-black.svg?logo=${slug}`,
    alt,
    url,
  );
}

async function autoNotes() {
  // Best effort: commits since the previous mausVoice-v* tag (or everything if none).
  // spawnSync with an args array avoids shell interpretation entirely — the
  // %(refname:short) format is otherwise parsed as a shell syntax error by /bin/sh.
  const { spawnSync } = await import("node:child_process");
  try {
    const tagsResult = spawnSync(
      "git",
      [
        "for-each-ref",
        "refs/tags/mausVoice-v*",
        "--sort=-version:refname",
        "--format=%(refname:short)",
      ],
      { encoding: "utf8" },
    );
    const prev = (tagsResult.stdout ?? "")
      .trim()
      .split("\n")
      .map((s) => s.trim())
      .find(Boolean);
    const range = prev ? `${prev}..HEAD` : "HEAD";
    const logResult = spawnSync(
      "git",
      ["log", range, "--no-merges", "--format=%s"],
      { encoding: "utf8" },
    );
    const log = (logResult.stdout ?? "").trim();
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

let notes = customNotes.trim();
if (!notes) notes = (await autoNotes()) ?? "";
if (!notes)
  notes =
    "This release continues the mausVoice desktop line with the changes on this branch.";
const noteItems = notes
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => (line.startsWith("- ") ? line : `- ${line}`))
  .join("\n");

const githubBase = `https://github.com/${owner}/${repo}`;
const actionsUrl = `${githubBase}/actions`;
const releasesUrl = `${githubBase}/releases`;
const licenceUrl = `${githubBase}/blob/main/LICENCE`;

const downloadChips = [
  ...(mac
    ? [
        logoChip(
          "apple",
          "Download mausVoice for macOS",
          assetUrl(mac.basename),
        ),
      ]
    : []),
  ...(win
    ? [
        logoChip(
          WINDOWS_LOGO,
          "Download mausVoice for Windows",
          assetUrl(win.basename),
        ),
      ]
    : []),
  ...(linDeb || linAppImage || linRpm
    ? [
        logoChip(
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
  `# ${releaseName}`,
  "",
  "Voice typing for your own machine. Dictate into any app, clean it up with AI. No account, no subscription.",
  "",
  `<p align="center">`,
  `  ${logoChip("opensourceinitiative", "AGPL-3.0 license", licenceUrl)}`,
  `  ${logoChip("githubactions", "CI passing", actionsUrl)}`,
  `  ${logoChip("box", "Downloads", releasesUrl)}`,
  `</p>`,
  "",
  "---",
  "",
  "<details>",
  "<summary><b>What's new</b></summary>",
  "",
  noteItems,
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
