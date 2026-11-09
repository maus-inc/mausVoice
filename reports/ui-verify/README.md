# UI verification output

The JSON measurements under this directory are committed; the screenshots are
not (`.gitignore` covers `reports/ui-verify/*.png`). Both are what the scripts in
`scripts/verify/` produced when the settings dialog and the preview app were
inspected in a real headless browser, so they are evidence for a review round
rather than source.

The JSON is committed deliberately: it is small, it is text, and a reviewer can
read a diff of it. Regenerating it is expected whenever the UI changes, and the
diff is the point — it shows what the change did to the measured numbers.

Regenerate them:

```bash
node scripts/verify/install-chromium.mjs   # once
node scripts/verify/shot-mic-dialog.mjs
node scripts/verify/shot-home.mjs
node scripts/verify/sweep-preview.mjs
```

Each script starts the preview app itself or uses `PREVIEW_URL`, and writes to
`reports/ui-verify` relative to the repository root. `OUT_DIR` overrides that.

A binary screenshot in a diff is a review cost that a reviewer cannot read in a
terminal, and it goes stale the moment a colour token changes. Keep them out of
the commit; they are for the round in which they were produced.
