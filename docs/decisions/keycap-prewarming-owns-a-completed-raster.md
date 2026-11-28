# Keycap prewarming retains the completed raster in the renderer

Date: 2026-11-27
Status: accepted

## Context

Issue #358 reports a flat keycap appearing before the first 3D raster. The
worker starts on demand. Its completed-image cache lives in a different context,
so a mounted keycap still needed a worker message even when that cache was warm.
The component also started painting in a passive effect, after the browser could
show its pending appearance.

## Decision

`AppWithLoading` schedules the shared dashboard raster without awaiting it. The
prewarm uses the same layout, material and display-scale calculation as visible
keycaps. Labels do not affect the raster, so one front-view image covers the Home
shortcuts, compact badges and pill modifier setting.

Prewarming uses only the worker. If workers fail or are unavailable, visible
keycaps retain the existing incremental local renderer and readable fallback.
Startup does not spend main-thread time rendering an invisible decoration.

Worker replies enter the renderer's existing eight-image LRU cache. A layout
effect copies an available image into a mounted canvas before the browser paints.
A cache miss still uses asynchronous rendering. No raster computation runs
synchronously in the layout effect. The incremental local renderer also defers
its image and mask allocation until its first scheduled slice, so unsupported
worker environments do not allocate raster buffers before the initial paint.

## Consequences

Repeated mounts can use the completed image without another worker message.
Prewarming and a visible request still share in-flight work. DPR and geometry
remain part of the cache key. The cache remains bounded, so eviction can require
a later worker request. A Home visit that beats prewarming can still show the
readable pending appearance until its raster arrives. Startup never waits for it.

The shared-grain component test now uses an uncached size to exercise request
construction. The worker-failure test checks both retained completed images and
uncached requests after worker shutdown. These changes preserve the original
failure checks while accounting for the new completed-cache contract.

## References

- [React useLayoutEffect](https://github.com/reactjs/react.dev/blob/main/src/content/reference/react/useLayoutEffect.md)
  distinguishes work before paint from passive effects and warns against blocking
  rendering with expensive work.
- [MDN worker guide](https://github.com/mdn/content/blob/main/files/en-us/web/api/web_workers_api/using_web_workers/index.md)
  describes worker contexts and copied messages.
- [MDN putImageData](https://github.com/mdn/content/blob/main/files/en-us/web/api/canvasrenderingcontext2d/putimagedata/index.md)
  describes copying an ImageData into a canvas and detached-buffer failures.

## Verification and design scope

The real keycap preview was inspected in light and dark schemes. The existing
camera, grain, projected legend, pressed travel and forced-colors rules are
unchanged. This is Stageshow product mode, not an illustrated scene. Against the
shipped keycap specimen, the intended difference is readiness, not shape or density.
The `clipped glyph:` and `anchor drift:` checks found no new visual defect in the
settled specimen. No new control, copy, focus behavior or motion was introduced.

A headless Chromium probe measured cold dashboard prewarming at approximately
45, 66 and 76 ms for DPR 1, 2 and 3 in this sandbox. The warmed component's canvas
was visible at its first animation frame at each scale. This is browser evidence,
not a native-device startup benchmark. A visit that beats the warmup remains an
asynchronous path and is deliberately not gated.

The design review used the recorded desktop baseline, keycap preview spec,
Impeccable craft floor and optimize guidance, Stageshow craft/verify/rehearse,
anti-slop, design-taste and UI/UX guidance. Their role was to preserve the shipped
visual world and reduce visible loading, not redesign it. No skill scripts ran.
The repository skill files were read directly; no external skill loader was
available. Some reference reads and the craft-floor reread occurred after the
initial patch, so this record does not attest to the prescribed pre-edit order.
No new visual tokens or design dependencies were needed.
