# UI verification output

The JSON measurements under this directory are committed; the screenshots are
not (`.gitignore` covers `reports/ui-verify/*.png`). Both are what the scripts in
`scripts/verify/` produced when the settings dialog and the preview app were
inspected in a real headless browser, so they are evidence for a review round
rather than source.

The exception is `settings-compare/`, which holds the before/after pairs a
review of the settings layout is asked for. Each file is one page, captured from
the same harness against the base branch and against the branch under review,
side by side with a label over each half. They are committed because a reviewer
has to be able to see the change without running a browser, and because a
picture of the base branch cannot be regenerated once the base moves.

```bash
# two captures, one per tree, then one montage per page
OUT_DIR=/tmp/shots/before node scripts/verify/shot-settings.mjs   # with the base files checked out
OUT_DIR=/tmp/shots/after  node scripts/verify/shot-settings.mjs   # with the branch files checked out
montage -background '#0f1012' -fill '#f4f4f5' -font DejaVu-Sans -pointsize 20 \
  -label "Before: base branch" /tmp/shots/before/settings-1100-dictation.png \
  -label "After: this branch"  /tmp/shots/after/settings-1100-dictation.png \
  -tile 2x1 -geometry '+16+16' reports/ui-verify/settings-compare/1100-dictation.png
```

The dev server caches modules, so a tree swapped under a running server is not
what the next probe measures: restart `pnpm --filter @maus-inc/preview dev`
after checking out a different tree, then confirm the page it serves is the one
you meant (the branch has `.setting-row-label` on the rows; the base does not)
before trusting a capture.

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
node scripts/verify/shot-settings.mjs
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
| `shot-settings.mjs` | `HARNESS_URL` | `http://127.0.0.1:5193/verify-harness/settings.html` |

The dialog has its own variable because it does not screenshot the ordinary app:
it loads the verification harness, which mounts the dialog against faked native
commands so every state is reachable in one page.

`shot-settings.mjs` reads the same variable for the same reason. It walks every
settings page at each window size the app allows (1280x900, 1100x700 and the
800x600 minimum) and asserts the geometry rather than only recording it: every
page starts on the same line, every row's label starts on one column within a
page, every group heading sits on that column, no group draws a heading over an
empty card, and nothing clips or overflows. Its report,
`settings-layout.json`, keeps the derived columns per page so a layout change
shows up as a readable diff.

Every one of them writes to `reports/ui-verify`, resolved from the script's own location
rather than the working directory. `OUT_DIR` overrides it.

A binary screenshot in a diff is a review cost that a reviewer cannot read in a
terminal, and it goes stale the moment a colour token changes. Keep them out of
the commit; they are for the round in which they were produced.
