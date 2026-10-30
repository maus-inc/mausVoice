# PR 288 visual audit — in progress

## Scope and evidence

The PR changes the routed settings surface (Overview, Dictation, AI and models, Shortcuts, Appearance, Privacy and data, System and Account), account/profile and destructive dialogs, shared rows and theme consumers. The QA artifacts branch capture predates the current tooltip and layout changes; it is useful as historical evidence, not as proof of the current head.

A Chromium browser rendered the production-component desktop preview in a populated workspace. The first pass captured **240 images**: eight settings pages × five viewport sizes (1440×900, 1280×720, 1024×768, 800×600 and 640×480) × light/dark × top, bottom and search views. These are combinations, not 240 independently designed edge cases; searches in particular repeat the same query. The 640×480 viewport is below the native window minimum (800×600), but approximates the reduced CSS viewport available at higher zoom. The first pass was captured while the compact-rail fix was being developed, so it is not a clean before/after baseline for that fix.

A second pass captured **100 images**: profile, clear-data, delete-account and shortcut dialogs in two states, plus tooltip hover/focus, at the same five sizes and two themes. The profile name was changed to an unusually long value; destructive confirmation phrases were typed but the destructive actions were not executed. These are combinations inspired by the issues below, **not** 100 separate external issues. Both capture passes reported zero uncaught page errors. Screenshots and the capture scripts are temporary sandbox artifacts, not checked into the repository.

Selected images were inspected at full size and contact-sheet scale; capture count must not be confused with a full visual sign-off of every image. The tooltip's arrow center was within 0.5 CSS pixels of its info icon in the ten measured hover captures. Keyboard focus, real scrollability, translations, larger text, native desktop rendering, all other changed theme consumers and screenshots after each fix still require systematic coverage. No claim of zero visual regressions is made.

## Findings and fixes

1. At 800×600, the selected item in the horizontal settings rail could be outside its scroll viewport. The selected item is now revealed on route changes and window resize. A fresh Chromium capture at 800×600 shows Account in view; unit tests cover both directions and the no-scroll cases.
2. At 800×600, wide segmented controls squeezed settings descriptions into narrow columns. Non-interactive control rows now wrap when the text needs room; a fresh Appearance capture shows the description spanning the card with the control below it. Wide cards retain the existing side-by-side layout.
3. At 640×480, the profile dialog's form prevented its content from shrinking, clipping the footer. The form is now a shrinkable flex column, letting the dialog body scroll while keeping the actions visible. A fresh capture shows the Save button inside the dialog bounds; the content's scroll height exceeds its client height.

The local visual check uses a browser preview, not a native macOS/Windows/Linux window. A complete re-capture and visual review at the final head is still needed.

## Research and issue-derived checks

- [Apple: Designing for macOS](https://developer.apple.com/design/human-interface-guidelines/designing-for-macos) — density, resizing and keyboard use are desktop requirements.
- [Apple: Inclusive design](https://developer.apple.com/videos/play/wwdc2021/10275/) — explicitly inspect truncation and clipping at larger text sizes.
- [NN/g: Progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/) — keep frequently needed options discoverable and make transitions to secondary controls clear.
- [Atlassian: Tooltip usage](https://atlassian.design/components/tooltip/usage/) and [positioning](https://atlassian.design/server/components/tooltips) — focusable triggers, nonessential copy, and collision-aware placement.
- [Carbon: Dialogs](https://www.carbondesignsystem.com/building-blocks/core/patterns/dialogs) — clear actions and focus management for modal tasks.
- [VS Code #53255](https://github.com/microsoft/vscode/issues/53255) — settings cropping under zoom.
- [QuickAdd #1888](https://github.com/chhoumann/quickadd/pull/1888) — dialog action clipping at short window heights.
- [Meridian Flow #811](https://github.com/haowjy/meridian-flow/pull/811) — settings controls overflowing and descriptions becoming cramped in narrow desktop windows.
- [Mastodon #450](https://github.com/fedibird/mastodon/issues/450) — clipping near responsive breakpoints; hiding overflow is not a fix for incorrect layout.

## Remaining work

- Independently design and visually inspect the requested broad set of edge cases; do not count repeated cross-product screenshots as distinct issue investigations.
- Exercise languages and long translations, text scaling/zoom, empty/loading/error states, provider combinations, focus order, high contrast and reduced motion, and other changed components outside settings.
- Repeat before/after capture and review at the final commit, including native desktop rendering where possible; investigate every regression rather than assuming the theme or layout is correct.
- Address outstanding PR review findings separately; visual review does not resolve functional review comments.
