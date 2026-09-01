#!/usr/bin/env node

// Renders the Homebrew cask from its source-of-truth template in this repo,
// stamping in the release version, the computed SHA-256 of the published
// macOS DMG, and the exact release tag it was published under. Writes the
// finished cask to stdout.
//
// Reads:
//   VERSION - e.g. 0.1.3
//   SHA256  - hex digest of mausVoice_<version>_universal.dmg
//   TAG     - release tag the DMG was published under (e.g. mausVoice-v0.1.3)

import { readFileSync } from "node:fs";

const version = process.env.VERSION ?? "";
const sha256 = process.env.SHA256 ?? "";
const tag = process.env.TAG ?? "";

if (!version) {
  console.error("VERSION is required");
  process.exit(1);
}
if (!sha256) {
  console.error("SHA256 is required");
  process.exit(1);
}
if (!/^[0-9a-f]{64}$/i.test(sha256)) {
  console.error("SHA256 must be a 64-character hexadecimal digest");
  process.exit(1);
}
if (!tag) {
  console.error("TAG is required");
  process.exit(1);
}

const template = new URL(
  "../../homebrew-mausvoice/Casks/mausvoice-desktop.rb",
  import.meta.url,
);

let cask = readFileSync(template, "utf8");
cask = cask.replace(/^ {2}version ".*"$/m, `  version "${version}"`);
cask = cask.replace(/^ {2}sha256 .*$/m, `  sha256 "${sha256}"`);
cask = cask.replaceAll("{{tag}}", tag);

// Never publish a cask with an unverified checksum.
if (cask.includes(":no_check")) {
  console.error("Rendered cask still contains ':no_check'; refusing to publish");
  process.exit(1);
}

process.stdout.write(cask);
