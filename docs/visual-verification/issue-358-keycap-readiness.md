# Keycap readiness — visual verification

Compared base `0f15abe5d4ff8b17685d931e70e46d35f9bbda58` with the issue #358 implementation after integrating that base. The retained dark frames are `docs/assets/issue-358/home-before.dark.png` and `home-after.dark.png`. The latter was captured from the final source tree; subsequent edits added only this report and the image files.

## Capture and inspection

Used the desktop browser preview's production route tree with mocked Tauri, at `/dashboard?previewPopup=hidden&scenario=populated`, 1157×727 CSS pixels, DPR 2, reduced motion. Captured and opened both light and dark frames for both trees. Satoshi was loaded, `--app-spacing` was 8px, the selected color scheme matched, no horizontal overflow or browser page errors occurred, and no tip covered the surface. The toolbar popup was hidden using its supported URL option, not CSS. Light frames remain temporary verification artifacts rather than expanding the retained dark pair.

Compared the Home title, hotkey row, sidebar and metrics against base. Alt and SPC remain readable with unchanged cap silhouette, material, alignment and spacing in both schemes. The cap wrapper is 35.796875×39 CSS pixels on both trees. No geometry, color, motion or interaction was redesigned. The upper-left shell and Home heading edges match. The viewport intentionally shows only the start of Recent transcriptions; this is the same vertical viewport boundary in both frames, not newly clipped keycap content.

## Runtime observations and limitations

Instrumented real Worker `postMessage` calls and canvas `putImageData`, and navigated Home → History → Home. The base issued one extra raster request on return; the implementation issued zero, in both color schemes. Both initial views used one worker request and six canvas copies. This demonstrates completed-image reuse rather than merely a mocked request counter in a unit test.

Direct cold Home entry did **not** demonstrate an initial latency improvement. In this sandbox development run, hidden-to-visible times were base 1301ms dark / 2763.8ms light and implementation 2872.2ms dark / 2883.3ms light. CPU load and development worker compilation make these unsuitable native benchmarks. More importantly, immediate navigation can beat the asynchronous warmup: this change does not promise that every cold entry has ready pixels. Production startup is never gated on decoration. Earlier isolated warmed-component probes established prepaint cache copying; they are not evidence that native startup always completes warmup first.

The preview originally bypassed `AppWithLoading` and therefore its warmup. Both roots now call the same small timer hook. Tests verify mount is usable before warming, StrictMode leaves one scheduled timer, and unmount cancels it. A negative control removing cancellation failed both timer assertions; restored code passed.

## Surfaces not recaptured in this pass

Compact hotkey badges, the pill modifier and onboarding variants share the renderer but were not captured in the real Home comparison. Existing component tests and the earlier light/dark keycap catalogue inspection cover their renderer states; this report does not imply a fresh native or all-route capture. No packaged Tauri launch, native keyboard/device timing, or narrow-window screenshot is claimed. Worker failure, disabled-worker fallback, stale generations, cancellation and cache eviction are covered by the focused renderer tests.
