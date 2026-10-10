## QA report: polish for the Style and Language pickers

I ran this branch and its base side by side in the sanctioned browser preview, drove every changed surface by hand, and read the results out of the live DOM and computed styles. Verdict: the change does what the description says. The Style menu is compact and bounded, the selected row is unmistakable, the focus ring is the designed silver one, the Language menu no longer runs past the window, and the Retranscribe options became real options again.

Two things drove this pass. First, the Retranscribe Style list was broken on the base: its options rendered but registered as zero selectable options, so nothing could be chosen. That is the important user-visible fix here and it is proven below by driving a real selection. Second, the language labels. The branch swaps 34 endonyms for English exonyms to avoid tofu boxes on systems without CJK, Arabic, Devanagari, Greek, Hebrew, and Thai fonts. I could not reproduce that tofu in this sandbox because it ships broad font coverage, so I say so plainly rather than claiming a fix I did not witness.

### Before and after

![Style menu, base vs PR291](https://work-1-ranlryontuidqusg.prod-runtime.all-hands.dev/pr291/291-cmp-style-menu.png)

The Style menu on the branch sits in a tighter band. Rows drop from 15px type and 8px padding to 14px type and 6px padding, and the chosen row is now bold with a check beside it. The paper is capped at 360px.

![Language menu, base vs PR291](https://work-1-ranlryontuidqusg.prod-runtime.all-hands.dev/pr291/291-cmp-language-menu.png)

The Language paper on the base grew to 804px tall and its bottom edge landed at 888px, inside a 900px viewport, so the last rows were pressed against the window edge. The branch caps it at 400px and it scrolls instead.

![Focus ring, base vs PR291](https://work-1-ranlryontuidqusg.prod-runtime.all-hands.dev/pr291/291-cmp-focus-ring.png)

Focus on an outlined field changes from MUI's 2px charcoal border swap at radius 14 to a 1px accent hairline plus a soft silver wash at radius 7.

![Retranscribe dialog, base vs PR291](https://work-1-ranlryontuidqusg.prod-runtime.all-hands.dev/pr291/291-cmp-retranscribe.png)

![Style and Language flow on this branch](https://work-1-ranlryontuidqusg.prod-runtime.all-hands.dev/pr291/291-flow.gif)

The recording walks the Import dialog: open the Style menu, hover a row, pick a style, then open the Language menu and scroll it.

### What I checked

| Area | Base | PR291 |
| --- | --- | --- |
| Style menu paper cap | `calc(100% - 96px)` (grew to 399px tall) | `min(360px, calc(100vh - 96px))`, computed 360px |
| Language menu paper cap | `calc(100% - 96px)`, computed 804px tall, bottom 888 in a 900px viewport | `min(400px, calc(100vh - 96px))`, computed 400px, bottom 782 |
| Menu row type | 15px, 8px padding | 14px, 6px padding |
| Selected row weight and glyph | weight 400, low-contrast fill, check only where already present | weight 600, fill, explicit check on Style rows |
| Outlined field radius | 14px | 7px |
| Outlined focus | 2px `rgb(26,23,18)` border swap, no ring | 1px `rgba(107,103,96,0.6)` border plus `rgba(107,103,96,0.14)` 3px ring |
| Retranscribe Style options | 0 selectable options | 9 selectable options |
| Retranscribe selection | could not change | changed from Meeting notes to Polished |
| Import Style and Language ARIA | labels have empty ids, comboboxes have no `aria-labelledby` | labels carry ids, comboboxes point at them |
| Settings language paper | 300px, radius 14 | 400px, radius 21 |
| Dialog name | `aria-labelledby` present | unchanged, still present |

### Details

<details>
<summary>Programmatic proof</summary>

Everything below was read from the live DOM and computed styles in the running preview. Nothing is a mock.

**Style menu paper and rows**, Import dialog:

```
base:
  maxHeight calc(100% - 96px)
  paper height 399
  row fontSize 15px, paddingTop 8px
  selected fontWeight 400, hasCheck true
branch:
  maxHeight 360px
  paper height 349
  row fontSize 14px, paddingTop 6px
  selected fontWeight 600, hasCheck true
  row borderLeftWidth 0px
```

**Language menu paper**, Import dialog:

```
base:   maxHeight calc(100% - 96px), height 804, bottom 888, viewport height 900
branch: maxHeight 400px, height 400, bottom 782
```

**Focus ring**, Style select in the Import dialog:

```
base:   Mui-focused, borderWidth 2px, borderColor rgb(26, 23, 18), boxShadow none, radius 14px
branch: Mui-focused, borderWidth 1px, borderColor rgba(107, 103, 96, 0.6),
        boxShadow rgba(107, 103, 96, 0.14) 0px 0px 0px 3px, radius 7px
```

**Retranscribe Style menu**, driven with a real click:

```
base:   optionCount 0, value stayed "Meeting notes"
branch: optionCount 9, clicked "Polished", value became "Polished", changed true
```

The base rows render inside the listbox but MUI does not treat them as options, so a user cannot pick a style. The branch emits direct MenuItem children, which is what the description calls out.

**Accessible naming**, Import and Retranscribe dialogs:

```
base Import:        labels Style(id ""), Language(id ""); comboboxes labelledby null
branch Import:      labels Style(id _r_1f_), Language(id _r_1g_); comboboxes labelledby _r_1f_, _r_1g_
base Retranscribe:  labels Style(id ""), Language(id ""); comboboxes labelledby null
branch Retranscribe: labels Style(id _r_2_), Language(id _r_3_); comboboxes labelledby _r_2_, _r_3_
both: dialog aria-labelledby present
```

**Language labels**, read from the open menu:

```
base:   19 labels in CJK, Arabic, Devanagari, Greek, Hebrew, or Thai script
        examples 中文, 中文 (台灣), 한국어, 日本語, العربية, हिन्दी
branch: 0 such labels, exonyms present
        examples Chinese, Chinese (Taiwan), Chinese (Simplified), Korean, Japanese, Arabic, Hindi,
                 Hebrew, Greek, Thai, Yiddish, Cantonese, Chinese (Hong Kong)
```

Latin and Cyrillic endonyms stay native on the branch, for example Español, Français, Русский.

**Tofu probe**, canvas rasterization of every label against the font's missing-glyph box:

```
base:   tofuCount 0 of 106
branch: tofuCount 0 of 106
```

I report this honestly. The branch's exonym change cannot be verified as a visual fix in this sandbox, because the sandbox renders CJK and Arabic fine and the base showed no tofu here. The claim holds only on systems that lack those fonts, which I could not construct.

**Settings dictation language menu**:

```
base:   maxHeight 300px, radius 14px, selected fontWeight 400
branch: maxHeight 400px, radius 21px, selected fontWeight 600
```

**Suites**, run locally on this head:

```
desktop unit:          230 files, 3043 tests passed
ToneSelect:            2 passed
StyleAvailabilityDialogs: 10 passed
shadows:               22 passed
desktop check-types:   passed
```

</details>

<details>
<summary>Small observations, none blocking</summary>

Two notes for the author, neither of which holds up the merge.

The Settings dictation language menu applies the bold `.Mui-selected` weight from `chromeSelectMenuItemSx` but adds no check glyph, while the Import and Retranscribe language menus render the check. The three menus therefore treat the selected row slightly differently. This matches the description's line that language menus keep the generic treatment, so it may be intended.

The tofu fix could not be exercised in this sandbox, as noted above. The code path and the label set are correct on inspection, and the unit suite pins them, but the visual symptom is unverified here.

</details>

### Artifacts

All images are served from the sanctioned preview host and mirrored on the [`qa-artifacts`](https://github.com/maus-inc/mausVoice/tree/qa-artifacts/qa-artifacts/pr291) branch.

<details>
<summary>Full artifact list</summary>

Comparison: `291-cmp-style-menu.png`, `291-cmp-language-menu.png`, `291-cmp-focus-ring.png`, `291-cmp-retranscribe.png`.

Recording: `291-flow.gif`.

</details>

---

MausAgent | Filed by `openhands-agent`, with @Owie6789, on 2026-10-10
