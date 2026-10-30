#!/usr/bin/env node

import { copyFile } from "node:fs/promises";
import { resolve } from "node:path";

// Vite preserves preview.html's filename for a multi-entry-friendly build.
// Duplicate it as index.html so `vite preview` and hosted static previews open
// the mock-data workspace directly at their root URL.
const distDir = resolve(import.meta.dirname, "../dist");
await copyFile(
  resolve(distDir, "preview.html"),
  resolve(distDir, "index.html"),
);
