# Keycap3d prototype

The preview route is `/#/c/keycap-3d`. The current prototype is also used in the
onboarding shortcut simulator, dashboard dictation shortcut, settings overview,
and feature-release dialog. Long labels in compact badges retain the classic
keycap so they remain readable; other shared badges keep their previous appearance.

## Reference and status

The black, white and red bell caps in the available Wannathis image use an angled
view. The image does not establish a separate front view. The dashboard camera
is provisional and has not been validated against a front-view reference. Neither
view has passed a one-to-one visual comparison. A matched-width comparison still
shows differences in the body, face boundaries and surface finish. A prototype
that clipped the top-to-wall intersection with extra bevel planes was rejected:
its highlight band and silhouette moved further from the reference. A stronger
corner reflection made the highlight more prominent, but increased the mean
luminance difference in a matched-width comparison that excluded the bell area,
so that change was also rejected. These pixel comparisons are diagnostic, not a
proof of fidelity: the images still have different geometry.

The reference comes from Wannathis. Its published license distinguishes native
app use, restricts redistribution, and limits freebies to personal use. The
reference images are not bundled with this component. Confirm the applicable
rights before incorporating any original Wannathis asset into the application:
<https://wannathis.one/license>.

## Implementation

- `apps/desktop/src/components/common/keycap3d.geometry.ts` builds a convex hull
  from the base and tilted top outlines and casts one ray per raster pixel.
- Plane normals are blended at edges. Duplicate wall planes are compacted before
  shading so they do not overweight the transition. The dish perturbs shading
  normals near the top plane only; it does not alter the intersected geometry or
  silhouette.
- Supporting wall planes enclose both outline rings. The face tilt is limited
  when necessary to prevent the top plane from crossing the base. This fixes the
  former mismatch between the layout outline and wall intersections, but does
  not by itself establish a closer visual match.
- `apps/desktop/src/styles/keycap.ts` supplies hand-tuned lights and material.
  A lower albedo and softer, dimmer reflections give the cap a darker matte
  finish. The renderer is not a physically based material model. The direction
  of this change follows the [Unreal Engine material guide](https://docs.unrealengine.com/4.26/en-US/RenderingAndGraphics/Materials/PhysicallyBased/),
  which describes rough surfaces as producing broader reflections, and the
  [Khronos PBR guide](https://github.khronos.org/glTF-Tutorials/PBR/), which
  distinguishes diffuse and glossy reflection. Neither source validates this
  renderer's coefficients or proves a match to a particular keycap.
- `keycap3d.texture.ts` adds clean procedural grain in object coordinates, not
  scratches, fingerprints or a photographed texture. Both views use the same
  material. Grain contrast tapers at smaller raster sizes; this limits aliasing
  but is not a full texture filter. The dashboard retains the 34px base edge.
- `Keycap3d.tsx` paints the cap into a canvas and places the legend in the DOM.
  The raster runs in a shared worker where available; worker failures fall back
  to the main thread. A watchdog detects a lack of worker progress rather than
  timing out each request while it waits in the queue. Identical in-flight
  rasters are shared. The client discards queued rasters after their last
  consumer unmounts or changes shape, and it ignores stale replies. During one
  headless preview run, 15 camera-tilt key presses issued 42 worker requests
  including initial render, compared with 124 before queued-work cancellation.
  This is one test of the preview, not a device benchmark. If canvas or raster
  painting fails or a 2D context is lost, a plain keycap keeps the legend visible;
  the cap is repainted if the browser restores the context. A projective CSS matrix
  maps the legend onto the flat top plane. Its transform origin is the top-left
  corner so the centering translation is applied before the face projection.
  In Chromium, the previous default centre origin moved the centre of a 190px
  angled legend about 7px left and 7px down. The corrected projection matched the
  calculated face plane at the centre and four legend corners in one Chromium
  check. The legend is not engraved in the geometry. Silhouette pixels use
  additional coverage samples.
- `angle` uses tilt 55 degrees, spin -30 degrees and screen roll 12 degrees.
  A thresholded matched-width comparison improved silhouette overlap and the
  height-to-width ratio relative to the previous camera. This is not a full
  perspective or material match. The provisional `front` camera is near overhead,
  with tilt 22 degrees, spin 0 and roll 0. Both use perspective distance 20 base
  edges.
- The cap moves down when pressed. There is no board or changing contact shadow.
  Reduced motion disables translation and transitions.
- `size` expresses the base-edge scale. The dashboard target is 34 CSS pixels.
  A browser check measured a 34 CSS pixel painted width at DPR 1 and 2.
- Geist Pixel Square is bundled for legends. A Shift key with a side uses the
  Shift glyph with the side word above it. Legends use compact text for Space and
  modifier glyphs missing from the font; accessible names retain the usual key
  names. Legend sizing uses advances from the bundled font for ASCII and common
  arrow glyphs. Unknown glyphs use an estimate. A checksum test flags font changes
  that would require updating the metrics.

## Remaining work

Validate and revise silhouette, face, walls, lighting and legends against the
original at matched size. Establish a separate front-view reference. Optimize the
first raster: in a sandbox browser it took roughly 25–42 ms at 34px/DPR 2 and
205–214 ms at 190px/DPR 2; cached identical rasters were much faster. The worker
moves this work off the main thread but does not reduce first-paint CPU time. In
one headless run at 189px/DPR 2, worker and synchronous runs took ~255ms and
~246ms; their largest animation-frame gaps were 50ms and 233ms. This is one
sandbox measurement, not a device benchmark. Worker and local pixels matched
exactly for one 190px/DPR 2 case. The production preview build emits a worker
asset; native Tauri webview and CSP compatibility have not been tested. Verify real
native hotkey input and assistive technology as the browser preview mocks native
boundaries. The desktop window has an 800px minimum width; the preview layout
clips at 400px and is not a mobile layout.
