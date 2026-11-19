# Storyboard schema

A storyboard is one JSON file that describes one recorded flow. `capture.mjs`
reads it, drives the browser through the steps in order, and records frames
underneath the whole run.

## Top-level fields

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `name` | string | `capture` | Label used in the timeline and the badge |
| `url` | string | `http://127.0.0.1:48921/` | Page to open. Use `?seed=project` for the fake open project |
| `viewport` | object | `{width:1280,height:800}` | Browser viewport. Match the size you want in the GIF |
| `deviceScaleFactor` | number | `1` | Capture scale. Keep 1 for a GIF; 2 doubles the bytes for no gain on screen |
| `fps` | number | `30` | Target GIF frame rate |
| `captureFps` | number | `60` | Capture frame rate. Keep above `fps` so the encode has frames to drop |
| `quality` | number | `90` | JPEG quality for captured frames. Lower to shrink a huge run |
| `settleMs` | number | `600` | Wait after load before the first step, so fonts and data land |
| `tailMs` | number | `600` | Hold on the last frame after the steps, so the end state is readable |
| `outDir` | string | `.qa-artifacts/capture` | Output directory, unless `--out` overrides it |
| `steps` | array | required | The actions below |

## Steps

Each step is an object with an `action` and the fields that action uses. Add
`waitMs` to any step to pause after it.

### `subtitle`

Sets the bottom caption. Pass `""` to hide it.

| Field | Type | Meaning |
| --- | --- | --- |
| `text` | string | The caption. Keep it under about sixty characters so it fits one line |

### `badge`

Sets the small corner label. Use it for the scenario name or the head SHA.

| Field | Type | Meaning |
| --- | --- | --- |
| `text` | string | The label |

### `move`

Glides the cursor to a point and, when the target is interactive, moves the real
pointer with it so hover states fire as the cursor arrives.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `selector` | string | | Element to center on. Takes precedence over `x`/`y` |
| `x`, `y` | number | | Absolute viewport coordinates when there is no selector |
| `ms` | number | `500` | Glide duration. Below about 250ms reads as a jump |
| `steps` | number | derived from `ms` | Interpolation steps. Leave unset |

### `click`

Glides to the target, presses, holds briefly, releases, and shows the ripple.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `selector`, `x`, `y` | | | Target, as in `move` |
| `ms` | number | `450` | Glide duration before the press |
| `holdMs` | number | `90` | How long the press ring is shown before release |
| `button` | string | `left` | `right` also sends a context-menu click |

### `dblclick`

Two clicks in quick succession, with the press ring shown.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `selector`, `x`, `y` | | | Target |
| `ms` | number | `450` | Glide duration |

### `hover`

Glides to the target and stops, so a hover state is visible.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `selector`, `x`, `y` | | | Target |
| `ms` | number | `400` | Glide duration |

### `drag`

Presses at one point, glides to another, and releases.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `from` | object | required | `{selector}` or `{x,y}` for the press point |
| `to` | object | required | `{selector}` or `{x,y}` for the release point |
| `ms` | number | `400` | Glide duration for the drag itself |
| `steps` | number | `30` | Interpolation steps during the drag |

### `type`

Clicks a field, if given, then types text.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `selector` | string | | Field to focus first |
| `text` | string | `""` | Text to type |
| `delay` | number | `45` | Milliseconds between keystrokes, so the typing is visible |

### `press`

| Field | Type | Meaning |
| --- | --- | --- |
| `key` | string | A key name, for example `Enter`, `Escape`, `Tab`, `ArrowDown` |

### `scroll`

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `dx` | number | `0` | Horizontal wheel delta |
| `dy` | number | `400` | Vertical wheel delta. Positive scrolls down |

### `screenshot`

Saves a still to `screenshots/<label>.png`. Use it for the named states a
reviewer needs as static evidence.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `label` | string | `shot-N` | File name, sanitized |
| `fullPage` | boolean | `false` | Capture the whole scrollable page, not just the viewport |

### `scene`

A marker only. It labels a point in `timeline.json` so a long capture can be
split into clips later. It performs no page action.

### `wait`

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `ms` | number | `400` | Milliseconds to hold before the next step |

## Timing guidance

- Give a `move` at least 400ms. Faster reads as a teleport and hides the path.
- Hold a state that changes with `wait` for 700ms or more, so a viewer sees it.
- Keep the whole storyboard under about fifteen seconds. The encode caps at
  twenty by dropping frames evenly, but a shorter clip is always better.
- Put a `subtitle` before the action it describes, not after, so the caption is
  on screen while the action happens.

## Selectors

Use the repo's conventions: roles and visible text, as `e2e/*.spec.ts` does.
Examples:

- `[aria-label="Settings"]`
- `button:has-text("Open")`
- `[role="switch"]`
- `[data-testid="welcome-screen"]`

A selector that matches nothing fails the step and stops the capture with a
non-zero exit, so a broken storyboard never produces a GIF.

A selector that matches more than one element does not fail. It silently takes
the first match, which is often the wrong one. `text=Editor` in the settings nav
matches the inert group header before the button, so the click lands on nothing
and the capture still exits 0 with a still screen. Prefer an unambiguous form
such as `button:has-text("Editor")` or `role=button[name="Editor"]`, and scope it
with a parent (`#bettershape-settings nav >> ...`). When a step's effect does not
appear, check `review/inspect-sheet.png` and count the matches with
`page.locator(sel).count()` before you blame the app.
