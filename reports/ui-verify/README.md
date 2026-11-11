# UI verification output

The JSON measurements under this directory are committed; the screenshots are
not (`.gitignore` covers `reports/ui-verify/*.png`). Both are what the scripts in
`scripts/verify/` produced when the settings dialog and the preview app were
inspected in a real headless browser, so they are evidence for a review round
rather than source.

The JSON is committed deliberately: it is small, it is text, and a reviewer can
read a diff of it. Regenerating it is expected whenever the UI changes, and the
diff is the point: it shows what the change did to the measured numbers.

Regenerate them:

```bash
# once per machine, into /tmp
node scripts/verify/install-chromium.mjs

# in one terminal: the preview app these scripts point at
pnpm --filter @maus-inc/preview dev --port 5193

# in another
node scripts/verify/shot-home.mjs
node scripts/verify/shot-mic-dialog.mjs
node scripts/verify/sweep-preview.mjs
```

**None of these scripts starts the preview app.** They launch a headless browser
and navigate to a URL that has to be serving already; run them with nothing on
port 5193 and the first `page.goto` fails. The app is started by hand, as above.

Which URL each one reads:

| Script | Reads | Default |
| --- | --- | --- |
| `shot-home.mjs` | `PREVIEW_URL` | `http://127.0.0.1:5193` |
| `sweep-preview.mjs` | `argv[2]`, then `PREVIEW_URL` | `http://127.0.0.1:5193` |
| `shot-mic-dialog.mjs` | `HARNESS_URL` | `http://127.0.0.1:5193/verify-harness/mic-dialog.html` |

The dialog has its own variable because it does not screenshot the ordinary app:
it loads the verification harness, which mounts the dialog against faked native
commands so every state is reachable in one page.

All three write to `reports/ui-verify`, resolved from the script's own location
rather than the working directory. `OUT_DIR` overrides it.

A binary screenshot in a diff is a review cost that a reviewer cannot read in a
terminal, and it goes stale the moment a colour token changes. Keep them out of
the commit; they are for the round in which they were produced.
