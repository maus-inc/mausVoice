#!/usr/bin/env node

// Renders the Homebrew cask from its source-of-truth template in this repo,
// stamping in the release version and the computed SHA-256 of the published
// macOS DMG. Writes the finished cask to stdout.
//
// Reads:
//   VERSION - e.g. 0.1.3
//   SHA256  - hex digest of mausVoice_<version>_universal.dmg

import { readFileSync } from "node:fs";

const version = process.env.VERSION ?? "";
const sha256 = process.env.SHA256 ?? "";

if (!version) {
  console.error("VERSION is required");
  process.exit(1);
}
if (!sha256) {
  console.error("SHA256 is required");
  process.exit(1);
}

const template = new URL(
  "../../homebrew-mausvoice/Casks/mausvoice-desktop.rb",
  import.meta.url,
);

let cask = readFileSync(template, "utf8");
cask = cask.replace(/^  version ".*"$/m, `  version "${version}"`);
cask = cask.replace(/^  sha256 .*$/m, `  sha256 "${sha256}"`);

process.stdout.write(cask);
