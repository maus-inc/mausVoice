# UI verification output

Generated, not committed. The screenshots and the JSON measurements under this
directory are what the scripts in `scripts/verify/` produced when the settings
dialog and the preview app were inspected in a real headless browser; they are
evidence for a review round, not source.

Regenerate them:

```bash
node scripts/verify/install-chromium.mjs   # once
node scripts/verify/shot-mic-dialog.mjs
node scripts/verify/shot-home.mjs
node scripts/verify/sweep-preview.mjs
```

Each script starts the preview app itself or uses `PREVIEW_URL`, and writes to
`reports/ui-verify` relative to the repository root. `OUT_DIR` overrides that.

Only the prose reports in `reports/` are tracked. A binary screenshot in a diff
is a review cost that a reviewer cannot read in a terminal, and it goes stale the
moment a colour token changes.
