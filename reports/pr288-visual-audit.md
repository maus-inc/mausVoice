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

## Localized and long-name pass

A subsequent browser run captured 160 page states (ten supported locales × eight routes × 1280×720 and 800×600) and 100 issue-derived states (the profile, clear-data, delete-account and shortcuts dialogs plus the segmented control, in those locales and sizes). The themes alternated between locales rather than covering both themes for every locale. These are reproducible combinations, not 260 distinct defects or 100 separate outside reports. All 260 captures completed without an uncaught page error; measured visible segmented options and dialog boundaries remained inside their containers. Individual screenshots have not all been manually reviewed.

The initial Korean and Chinese screenshots rendered missing-glyph boxes because the sandbox lacked CJK system fonts. The three CJK locales were re-captured after provisioning a CJK fallback font; 78 additional captures completed without page errors. This still does not establish what fonts a user's operating system supplies or how every translated label behaves under scaling.

An additional real browser test saved a single 100-character name. Before the fix, the header button extended from x=28 to x=946 in an 800px window and pushed its name off-screen; the name value also crowded the Account description. The header now bounds and ellipsises its visual name while retaining the full accessible text, and the value/action column leaves room for the description at compact widths. Afterward the button measured x=452 to x=772. Short names and wide-window states need continued regression coverage.

Further issue inspiration: [Tauon #2348](https://github.com/Taiko2k/Tauon/issues/2348) documents localized settings text clipping, [R-Instat #10589](https://github.com/IDEMSInternational/R-Instat/issues/10589) describes longer translated dialog controls, and [jvid #310](https://github.com/jarradbanks/jvid/issues/310) proposes pseudo-localization for longer labels. The capture matrix above checks related conditions; it does not replace a pseudo-locale or actual assistive-technology testing.

## App chrome and motion pass

The production preview was also captured on Home, History, Dictionary, Styles and Help, using populated and empty fixtures, light and dark themes, and 800×600 and 1280×720 windows (40 route/fixture combinations, with top and scrolled captures). These exercise the shared theme, navigation and header in other domains; several representative captures were inspected, not every captured state. No uncaught page errors were recorded. The preview fixtures and browser cannot prove native Tauri behavior.

A real reduced-motion run exposed confetti still animating over every page after the feature introduction, despite `prefers-reduced-motion: reduce`. The root celebration now suppresses that nonessential animation for this preference, while leaving the normal celebration intact. Follow-up captures confirmed no falling confetti with reduced motion and retained confetti with the normal preference. This follows the principle in [W3C technique C39](https://www.w3.org/WAI/WCAG22/Techniques/css/C39/); it is not a claim that all motion in the app meets WCAG.

The clear-data dialog was additionally inspected at 640×480, below the desktop's configured 800×600 minimum. Its content scrolls, but the initial confirmation field is partially below the content viewport; the prior focus effect does not focus it after the dialog opens. This is an outstanding smaller-than-supported-window limitation, not a passing visual result. A subsequent keyboard check found that the first Tab focuses the input and scrolls it completely into view (input bottom 372.4px, content bottom 372.8px). The initial partial field remains a smaller-than-supported-window limitation; a suitable initial focus choice should be evaluated before changing that destructive dialog.

## Review-driven navigation checks

A later review identified two Overview style rows pointing to the editor for individual styles rather than the general shortcut editor, and deep links that could miss provider-dependent rows while API keys were still loading. Both paths now target and reveal the intended row; delayed availability and navigation away from a pending anchor have focused regression tests. A browser check of the previous-style shortcut at 800×600 reached and highlighted **Hotkey shortcuts**.

That check also showed the compact search/rail scrolling away during the jump. The compact rail and search now remain sticky together, as the wider rail already did; the same 800×600 browser check confirmed both remain visible. This needs further comparison on long pages, localized content and native desktop builds, rather than being treated as a complete visual regression pass.

After the compact sticky-rail change, 48 scrolled page captures covered eight settings routes, three locales (English, German, Korean), and the 800×600 and 1280×720 sizes. All captures completed; representative light, dark, Latin and Korean images were inspected. Contact-sheet review exposed segmented-control text painting over the compact rail at some scroll positions; the rail now sits above those controls, and the 800×600 Appearance capture was rechecked. The rest of the supported locales and other scroll positions still require manual comparison.

Contact sheets were subsequently reviewed at reduced scale for the 800×600 page and issue captures across all ten locales (80 page images and 50 issue-state images). This is a broad visual scan, not a full-resolution inspection of every text label; the larger-size captures and native rendering remain outstanding. A later review also found that a pending deep-link retry could erase a newer search while keys were loading. Typing in search now cancels the pending jump, and a regression test covers that race.

## Checked switch state

Full-size review of the scrolled settings captures found that a checked switch's thumb and track had the same color in both schemes, hiding the thumb and making its position ambiguous. The shared theme now uses a contrasting thumb on the checked track. The Privacy and data page was re-captured in light and dark at 800×600; both on and off positions were visible. A theme regression test checks the checked thumb and track colors in both schemes. [W3C's non-text contrast guidance](https://www.w3.org/WAI/WCAG21/Understanding/non-text-contrast.html) explains why visual information identifying a control's state must contrast with adjacent colors; this focused fix is not a whole-app contrast conformance claim.

## Credential onboarding

At the supported 800×600 minimum, the API-key onboarding form initially placed the Groq field mostly below its scrolling viewport. The credential form now gives its text and fields more width at compact sizes and uses tighter spacing; wider windows retain the original equal pane split. In English and German 800×600 captures, both fields and provider links are visible without scrolling. Portuguese's longer copy still needs scrolling for its second provider link. Across ten locales at 800×600 and 1280×720, 20 browser runs focused the second field and measured it inside the scrolling content viewport; representative light, dark and CJK screenshots were inspected. This is browser-preview evidence, not a native onboarding verification.

For Brazilian Portuguese at 800×600, a keyboard pass reached the initially hidden Groq link: Tab scrolled it into view (link bottom 517.3px, content bottom 517.8px), then reached the skip action. The credential page also duplicated the shared onboarding header but rendered its title as an `h4` with no preceding heading. It now uses the shared visually identical `h1` header; a component test checks the heading, and a German compact browser recapture retained the same measured field and action positions.

## Number-field accessibility and validation

Inspired by [GitHub Desktop's accessibility work](https://github.blog/changelog/2023-05-03-github-desktop-makes-force-pushing-and-fetching-easy-and-adds-pull-request-comment-notifications/) on labelled preference inputs and zoom, a browser accessibility check found that the dictation limit and hands-free delay spinbuttons had no accessible names even though their visible rows had titles. Both now reference their row titles and descriptions, and an invalid field also references its validation message. A focused regression test checks those associations.

At 800×600, 20 sequential browser inputs exercised empty, negative, above-maximum, boundary, fractional, leading-zero and exponent values across the two fields. All produced the expected valid/invalid state and retained their accessible label and description; representative screenshots were inspected, not all 20 individually. The first run showed a validation message below the viewport when Enter was pressed in the bottom field. The error now scrolls into view if that field still has focus; it does not pull the page away after blur. A second capture showed the message at the bottom of the viewport. These browser-preview checks do not substitute for a screen-reader or native desktop test.

## Dialog keyboard pass

Following [my-family #1143](https://github.com/cacack/my-family/pull/1143) on focused controls in scrollable dialogs and [#1144](https://github.com/cacack/my-family/issues/1144) on shortcuts behind modals, a browser pass opened settings dialogs at 800×600 in both schemes, tabbed repeatedly, checked focus stayed in each dialog, then checked Escape closed it and returned focus to its trigger. Twenty-two dialog/theme runs completed those checks; four more had harness timeouts while dismissing the preview's feature introduction, so they are not passing results. Representative screenshots were inspected. The local-model dialog also emitted preview-only errors because native shell operations are unavailable; the browser cannot establish native model behavior or global-shortcut suppression.

The Audio dialog's interaction-feedback switch had a visible title and explanation but no accessible name. It now references both using generated IDs. A component test checks the associations, and a browser role query finds the named switch; the compact Audio dialog was re-captured. This is a focused accessibility correction, not a complete dialog accessibility audit.

The four introduction-dismissal timeouts were retried successfully, and the same 13 dialogs were exercised in both schemes at 1280×720 as well: 52 dialog/size/theme combinations in total passed the scripted Tab containment, Escape and trigger-focus-return checks. Only selected screenshots were examined in detail; the script did not exercise every control or prove native global-shortcut behavior. On the shortcut dialog the accessible dialog name concatenated its title and explanation without a separator. They now have separate label and description associations; a unit test and compact browser recapture verify the distinction. [OBS Studio #12475](https://github.com/obsproject/obs-studio/issues/12475) highlights a separate native hotkey-recording/Shift+Tab risk that remains to be tested in the actual desktop, since the browser preview omits native keyboard side effects.
