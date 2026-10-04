//! Geometry helpers shared by the per-platform pill renderers
//! (rust_gtk_pill, rust_macos_pill, rust_windows_pill).
//!
//! The long-press progress ring draws a partial outline around a rounded
//! rectangle. Keeping the perimeter math in one crate guarantees every
//! platform traces the *same* path for the same input rectangle, so the
//! ring lines up pixel-for-pixel across Linux, macOS and Windows.

pub mod clock;
pub mod deform;
pub mod drag;
pub mod edge;
pub mod hover;
pub mod placement;
pub mod spring;
pub mod text_fit;

use std::cell::{Cell, RefCell};
use std::f64::consts::FRAC_PI_2;

/// Build the perimeter of an axis-aligned rounded rectangle as an ordered
/// list of `(x, y)` points. The path traces clockwise starting from the
/// left end of the top edge, goes through four quarter-circle corners,
/// and closes back at the start point.
///
/// `arc_steps` controls how many line segments each corner arc is split
/// into; it is chosen automatically from `radius` when callers pass
/// [`RoundedRectArcSteps::Auto`], mirroring the heuristic the three pills
/// previously duplicated locally.
pub fn rounded_rectangle_perimeter(
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    radius: f64,
    arc_steps: RoundedRectArcSteps,
) -> Vec<(f64, f64)> {
    // A zero or negative radius collapses to a plain rectangle; cap the
    // radius at half the shortest side so the arcs never overlap.
    let r = radius.max(0.0).min(w.min(h) * 0.5);
    let steps = match arc_steps {
        RoundedRectArcSteps::Auto => ((r * 0.75).ceil() as usize).clamp(6, 24),
        RoundedRectArcSteps::Exact(n) => n.max(1),
    };

    let mut path: Vec<(f64, f64)> = Vec::with_capacity(steps * 4 + 5);

    let corner = |cx: f64, cy: f64, from: f64, path: &mut Vec<(f64, f64)>| {
        for i in 1..=steps {
            let angle = from + (i as f64 / steps as f64) * FRAC_PI_2;
            path.push((cx + angle.cos() * r, cy + angle.sin() * r));
        }
    };

    // Top edge, left -> right (start point doubles as the progress origin).
    // Always emit both endpoints; consumers already tolerate zero-length segments.
    path.push((x + r, y));
    path.push((x + w - r, y));
    // Top-right corner (-90deg -> 0deg), then the right edge.
    corner(x + w - r, y + r, -FRAC_PI_2, &mut path);
    path.push((x + w, y + h - r));
    // Bottom-right corner (0deg -> 90deg), then the bottom edge, right -> left.
    corner(x + w - r, y + h - r, 0.0, &mut path);
    path.push((x + r, y + h));
    // Bottom-left corner (90deg -> 180deg), then the left edge.
    corner(x + r, y + h - r, FRAC_PI_2, &mut path);
    path.push((x, y + r));
    // Top-left corner (180deg -> 270deg) - closes back at the start point.
    corner(x + r, y + r, std::f64::consts::PI, &mut path);

    path
}

/// Cumulative linear distances along a polygon produced by
/// [`rounded_rectangle_perimeter`], starting at `0.0` for the first vertex.
///
/// Returns `(distances, total_len)` where `distances[i]` is the distance
/// from the first vertex to the `i`-th vertex travelling along the path,
/// and `total_len` is the total perimeter length.
pub fn path_distances(path: &[(f64, f64)]) -> (Vec<f64>, f64) {
    let mut distances = Vec::with_capacity(path.len());
    distances.push(0.0);
    for i in 1..path.len() {
        let dx = path[i].0 - path[i - 1].0;
        let dy = path[i].1 - path[i - 1].1;
        distances.push(distances[i - 1] + (dx * dx + dy * dy).sqrt());
    }
    let total = distances.last().copied().unwrap_or(0.0);
    (distances, total)
}

/// Whether a pill-body click may emit interaction feedback and dispatch its
/// action. Loading owns the current operation, so another body click must be
/// inert: no haptic/audio event and no second action. A click on an unavailable
/// action is also inert. Both conditions stay identical on every platform
/// because the decision lives in this shared crate.
pub const fn can_emit_interaction_feedback(action_available: bool, is_loading: bool) -> bool {
    action_available && !is_loading
}

/// The user's preference for when the pill is on screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PillVisibility {
    Hidden,
    WhileActive,
    Persistent,
}

/// Shared pill visibility policy, used by every platform pill.
///
/// | preference    | idle    | recording | pill owns the surface |
/// |---------------|---------|-----------|-----------------------|
/// | `Hidden`      | hidden  | hidden    | visible               |
/// | `WhileActive` | hidden  | visible   | visible               |
/// | `Persistent`  | visible | visible   | visible               |
///
/// `owns_surface` covers assistant mode and a transcript waiting for a review
/// decision. Both put something on the pill that the user has to answer, so
/// they override the preference: hiding the pill would leave the user with no
/// way to respond and the desktop waiting forever.
pub const fn should_show_pill(
    preference: PillVisibility,
    is_active: bool,
    owns_surface: bool,
) -> bool {
    match preference {
        PillVisibility::Hidden => owns_surface,
        PillVisibility::WhileActive => is_active || owns_surface,
        PillVisibility::Persistent => true,
    }
}

/// Maximum character budget for the review card transcript preview.
/// Longer transcripts are safely truncated for rendering while keeping
/// the complete text intact for insertion and copying.
pub const MAX_REVIEW_PREVIEW_CHARS: usize = 3000;
pub const MAX_REVIEW_PREVIEW_LINES: usize = 60;

/// How far back the word-boundary trim may reach for whitespace.
///
/// Trimming exists so the preview does not end mid-word. It must not become a
/// second way to lose the budget: `rfind` over the whole window found the last
/// whitespace anywhere in it, so a transcript with one space near the top (a
/// long URL, a hash, CJK text) trimmed thousands of characters away and
/// rendered an almost-empty card. A word longer than this is not worth
/// truncating the preview for.
const REVIEW_PREVIEW_TRIM_WINDOW: usize = 64;

/// Byte offset where the character-budget scan stops, or `None` when the whole
/// text fits inside the budget.
///
/// `char_indices().nth` returns the position of the first character *past* the
/// budget, so `None` is the same `chars().count() <= limit` comparison the
/// budget documents without walking the rest of a transcript that can be
/// thousands of times longer than the preview. `chars().count()` did walk all
/// of it, which made every rendered frame cost time proportional to the full
/// text; this returns the offset the scan reached, which is a property of the
/// budget and not of the input's length, so a test can assert the bound without
/// timing a sub-microsecond call.
fn review_preview_scan_end(full_text: &str) -> Option<usize> {
    full_text
        .char_indices()
        .nth(MAX_REVIEW_PREVIEW_CHARS)
        .map(|(byte_index, _)| byte_index)
}

/// Prepare a bounded slice of review text for rendering.
/// Ensures that huge inputs (e.g. long audio imports or transcripts)
/// do not cause unbounded text layout, wrapping, or allocation overhead on every frame.
pub fn bound_review_preview_text(full_text: &str) -> (String, bool) {
    // The budget is documented in characters, so it is measured in characters:
    // `str::len` is bytes, and 3000 bytes of Japanese is about 1000
    // characters.
    let Some(end) = review_preview_scan_end(full_text) else {
        return (full_text.to_string(), false);
    };

    // Trim back to a word boundary, but only within a short window: a
    // transcript can be one long unbroken run, and giving up the whole budget
    // to find whitespace defeats the point of having one.
    let cut_pos = full_text[..end]
        .char_indices()
        .rev()
        .take(REVIEW_PREVIEW_TRIM_WINDOW)
        .find(|(_, ch)| ch.is_whitespace())
        .map_or(end, |(byte_index, _)| byte_index);

    let mut preview = full_text[..cut_pos].to_string();
    preview.push_str("\n… [Full transcript preserved for insert]");
    (preview, true)
}

/// Clip the vertical span of a click target to the band of the panel that is
/// actually on screen.
///
/// Returns the visible top and height, or `None` when the target sits entirely
/// outside the band. Scrolling moves buttons under the panel edge, and the part
/// that slid out is painted over by the surrounding chrome, so it must stop
/// taking clicks. Keeping or dropping the whole target by its centre point is
/// not enough: a target that is half out would either lose its visible half or
/// keep an invisible one, and the user would hit a button they cannot see.
pub fn clip_span_to_band(y: f64, h: f64, band_y: f64, band_h: f64) -> Option<(f64, f64)> {
    let top = y.max(band_y);
    let bottom = (y + h).min(band_y + band_h);
    let height = bottom - top;
    if height > 0.0 {
        Some((top, height))
    } else {
        None
    }
}

/// The rectangle a click target has to cover when the draw code painted it
/// inside a scale transform about `(center_x, center_y)`.
///
/// Pointer coordinates and the input shape are both in unscaled window space,
/// so a target registered with the rectangle's own coordinates covers a
/// different part of the window than the pixels drawn there. The toast banner
/// is scaled about its centre from half size up to full, and for the whole
/// animation that leaves a button's registered rectangle offset from the button
/// the user can see: a click on the visible half misses. Scaling the rectangle
/// about the same centre, with the same factor the transform used, is what puts
/// the target and the paint back in step.
///
/// A `scale` of 1 leaves the rectangle where it was, so this is safe for a
/// caller that is unsure whether the transform was degenerate.
pub fn scaled_click_rect(
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    center_x: f64,
    center_y: f64,
    scale: f64,
) -> (f64, f64, f64, f64) {
    (
        center_x + (x - center_x) * scale,
        center_y + (y - center_y) * scale,
        w * scale,
        h * scale,
    )
}

/// How many line segments to use for each corner arc.
#[derive(Debug, Clone, Copy)]
pub enum RoundedRectArcSteps {
    /// Pick a step count from the radius (higher radius -> smoother arcs),
    /// clamped to 6..=24.
    Auto,
    /// Use exactly `n` segments per corner.
    Exact(usize),
}

/// How much the pill inflates when the long-press completes and drag begins,
/// expressed as a scale factor applied to BOTH axes about the pill's centre.
pub const DRAG_INFLATE_SCALE: f64 = 0.18;
/// Spring stiffness for the inflate/deflate animation.
pub const DRAG_INFLATE_STIFFNESS: f64 = 280.0;
/// Spring stiffness for the pill expand/collapse (idle <-> active).
///
/// 320 is critically damped with ~220 ms settle (4/sqrt(320) ≈ 0.22 s),
/// inside the 100–150 ms to first paint budget (NN/g [1]) and the
/// <300 ms microinteraction ceiling. The behavioural pin is
/// `hover::realistic_pass_at_900_px_s_still_counts_as_intent` (900 px/s
/// arms, 1500 px/s does not) — not an external blog. The previous
/// 200 (≈283 ms) felt sluggish on rapid passes; 320 keeps the same
/// ease-out shape (critically damped, no overshoot) but arrives ~25 %
/// faster, so the dwell reduction and wider hit zone are not wasted
/// waiting for the spring. Label and inflate already use 280, so 320
/// is a deliberate step snappier for the primary affordance.
///
/// [1]: https://www.nngroup.com/articles/timing-exposing-content/
pub const PILL_EXPAND_STIFFNESS: f64 = 320.0;

// ── Idle/drag label crossfade (shared by all pill renderers) ──────────────
/// Base alpha multiplier for the idle label (before expand_t and drag_t).
pub const LABEL_BASE_ALPHA: f64 = 0.55;
/// Vertical slide offset for the crossfade in pixels.
pub const LABEL_SLIDE_OFFSET: f64 = 2.0;
/// Alpha below which a label is not drawn.
///
/// This ends one label when the other has taken over; it is not the
/// sub-perceptual "avoid pointless draws" threshold it used to be. The two
/// alphas are complementary — they sum to `LABEL_BASE_ALPHA * expand_t` — so a
/// cutoff near zero is not a cleanup, it is the width of the crossfade. At
/// `0.01` both labels cleared the bar for `drag_t` in roughly (0.018, 0.982):
/// 96% of the transition, about 14 frames at 60 Hz, with `label_slide_y`
/// parting them by `LABEL_SLIDE_OFFSET` (2px) on 12px glyphs. Two different
/// strings superimposed 2px apart is a smudge, not a crossfade, and it is
/// drawn while the pill tracks the cursor.
///
/// So the cutoff sits just under half the peak. Just under rather than exactly
/// half, because all three renderers gate with `alpha > LABEL_ALPHA_CUTOFF`: at
/// exactly half both arms equal the cutoff at `drag_t == 0.5` and the pill
/// blinks with no label for one frame. At 45% of peak the overlap is ~19ms of
/// the spring's ~350ms travel — about one frame at 60 Hz, at ~47% of peak
/// alpha, so no frame ever draws nothing.
///
/// Raising it cannot suppress a label the geometry would have drawn: all three
/// renderers only call the label painter above `expand_t > 0.5`, and at
/// `drag_t == 0` the idle alpha is already `0.55 * 0.5 = 0.275` there.
pub const LABEL_ALPHA_CUTOFF: f64 = LABEL_BASE_ALPHA * 0.45;

/// Idle label text shown when not dragging.
pub const LABEL_IDLE_TEXT: &str = "Click to dictate";
/// Label text shown when dragging (or held for drag).
pub const LABEL_DRAG_TEXT: &str = "Drag To Move";

/// Independent stiffness for the label crossfade spring (tunable separately
/// from DRAG_INFLATE_STIFFNESS so label feel can evolve independently).
pub const LABEL_SPRING_STIFFNESS: f64 = 280.0;

/// Crossfade alphas for the idle / drag pair given drag progress and expand.
pub fn label_crossfade_alpha(drag_t: f64, expand_t: f64) -> (f64, f64) {
    let drag_t = drag_t.clamp(0.0, 1.0);
    let expand_t = expand_t.clamp(0.0, 1.0);
    (
        LABEL_BASE_ALPHA * expand_t * (1.0 - drag_t),
        LABEL_BASE_ALPHA * expand_t * drag_t,
    )
}

/// Vertical slide Y positions for the two labels, given a base Y and drag_t.
pub fn label_slide_y(base_y: f64, drag_t: f64) -> (f64, f64) {
    let drag_t = drag_t.clamp(0.0, 1.0);
    (
        base_y - LABEL_SLIDE_OFFSET * drag_t,
        base_y + LABEL_SLIDE_OFFSET * (1.0 - drag_t),
    )
}

/// Shared font-registration failure log.
///
/// Strategy: draw-time critical paths (macOS NSFont, Windows DirectWrite
/// text format) must not fall back silently — they log via this helper and
/// then panic. Setup paths (GTK fontconfig, Windows collection refresh)
/// log here without panicking, because failure at install is visible at draw
/// and must be loud, but does not need to abort the process immediately.
pub fn log_font_error(msg: &str) {
    eprintln!("[mausVoice-font] {msg}");
}

// ── Long-press ring: one continuous driver ────────────────────────────────
//
// The ring is a "comet" that sweeps the pill perimeter while the gesture is
// held. Everything below is driven by a SINGLE progress value `p` in 0..=1 —
// there is no separate "filling" and "armed" renderer to switch between, which
// is what previously made completion look like a cut.
//
// Brightness at a point = `ring_envelope(..)` * `ring_glimmer(..)`:
//   * envelope  — comet falloff behind the head, which relaxes to a flat 1.0
//                 as the hold completes (see `ring_seal`).
//   * glimmer   — a travelling sine that keeps the outline alive. It replaces
//                 the old binary dash pattern, whose hard on/off edges read as
//                 busy. Backends have no gradient-along-path primitive (Cairo
//                 and Direct2D both lack one), so the gradient is produced by
//                 shading evenly-resampled segments.

/// Instant progress credited the moment the ramp starts, so a press reads as
/// registered within one frame rather than after the hold delay.
pub const RING_LEAD_IN: f64 = 0.04;

/// Comet tail length at the start of the ramp, as a fraction of the perimeter.
pub const RING_TAIL_START: f64 = 0.34;
/// Tail length once fully relaxed, as a fraction of the perimeter. Greater
/// than 1.0 so the trail wraps past the head instead of ending abruptly.
pub const RING_TAIL_FULL: f64 = 1.35;
/// Progress by which the tail has finished growing to `RING_TAIL_FULL`.
pub const RING_TAIL_RELAX_BY: f64 = 0.62;
/// Dimmest the trail is allowed to get behind the head.
pub const RING_TRAIL_FLOOR: f64 = 0.14;

/// Progress at which the envelope starts crossfading to a uniform outline.
///
/// On a closed path, distance `0` and distance `total_len` are the SAME point.
/// A comet envelope is therefore discontinuous there — bright just behind the
/// head, dim at the tail end — leaving a visible lump at the seam that a
/// longer tail cannot remove. Sealing crossfades the whole envelope to 1.0 so
/// both sides of the seam match exactly at completion.
pub const RING_SEAL_FROM: f64 = 0.72;

/// Full glimmer cycles around the perimeter.
///
/// MUST stay a whole number: a fractional count would not meet itself at the
/// seam, reintroducing the discontinuity that `ring_seal` exists to remove.
pub const RING_GLIMMER_CYCLES: f64 = 3.0;
/// Depth of the glimmer modulation (0 = flat outline, 1 = full dark-to-bright).
pub const RING_GLIMMER_DEPTH: f64 = 0.42;
/// How fast the glimmer travels, as a multiplier on the waveform phase.
pub const RING_GLIMMER_SPEED: f64 = 1.8;

/// Stroke width of the ring at rest.
pub const RING_CORE_WIDTH: f64 = 1.5;
/// Extra stroke width added at the comet head.
pub const RING_WIDTH_SWELL: f64 = 0.7;
/// Brightness multiplier once the gesture is armed and dragging.
pub const RING_ARM_LIFT: f64 = 0.32;

/// Target spacing between resampled perimeter points, in pixels.
pub const RING_SEGMENT_PX: f64 = 2.2;

/// Radius of the soft comet head.
pub const RING_HEAD_RADIUS: f64 = 13.0;
/// Peak alpha of the comet head.
pub const RING_HEAD_ALPHA: f64 = 0.30;
/// Progress at which the head starts dissolving.
pub const RING_HEAD_FADE_FROM: f64 = 0.55;
/// How much the head expands while it dissolves.
pub const RING_HEAD_BLOOM: f64 = 0.45;
/// Concentric steps used to approximate the head's radial falloff.
pub const RING_HEAD_STEPS: usize = 4;

// ── Low-alpha draw cutoffs ────────────────────────────────────────────────
//
// Every ring layer skips draws it cannot make visible. The thresholds live
// here, next to each other, so they are tuned as a set instead of drifting
// apart as literals sprinkled through three renderers.

/// Peak alpha below which a head-disc stack is not painted at all.
///
/// Roughly one 8-bit alpha step (1/255 ≈ 0.0039): below it the concentric
/// discs would only contribute sub-perceptual ghosts. Applied by
/// [`RingLayers`] to both the silver head and its dark underlay.
pub const RING_HEAD_FADE_CUTOFF: f64 = 0.004;
/// Alpha below which one comet segment is skipped.
///
/// Higher than [`RING_HEAD_FADE_CUTOFF`] on purpose: the comet is hundreds of
/// individually-stroked segments per frame, so its threshold buys real time,
/// whereas a head stack is at most [`RING_HEAD_STEPS`] discs. Still about
/// three 8-bit alpha steps — the dimmest tail segments it drops are already
/// indistinguishable from the backdrop.
pub const RING_SEGMENT_ALPHA_CUTOFF: f64 = 0.012;
/// Exponent of the concentric-disc alpha falloff: `falloff = (1 - (k-1)/steps)^exp`,
/// so the outermost disc is dimmest and the innermost is full brightness.
pub const RING_HEAD_FALLOFF_EXP: f64 = 2.2;
/// Alpha scale applied to every head disc. The discs are drawn at half the
/// layer alpha so the stack of overlapping discs sums to roughly the layer's
/// intended brightness instead of overshooting it.
pub const RING_HEAD_DISC_ALPHA_SCALE: f64 = 0.5;

/// Duration of the arm-confirmation pulse.
pub const RING_PULSE_DURATION: f64 = 0.5;
/// How far the arm pulse expands beyond the ring, in pixels.
pub const RING_PULSE_SPREAD: f64 = 10.0;
/// Peak alpha of the arm pulse.
pub const RING_PULSE_ALPHA: f64 = 0.34;
/// Delay of the second, trailing pulse ring as a fraction of the duration.
pub const RING_PULSE_ECHO_DELAY: f64 = 0.18;

/// Time for the ring to reach full opacity after the hold delay.
pub const RING_ALPHA_RISE: f64 = 0.1;
/// Outward drift applied to the ring as it fades after release, in pixels.
pub const RING_RELEASE_DRIFT: f64 = 1.5;

/// Progress at which the pill starts inflating, before the gesture arms.
pub const INFLATE_PRE_AT: f64 = 0.45;
/// How much of the full inflate is reached before arming.
pub const INFLATE_PRE_AMOUNT: f64 = 0.6;
/// Peak scale reduction of the press anticipation dip.
pub const PRESS_DIP: f64 = 0.03;
/// Time constant of the press anticipation dip's decay.
pub const PRESS_DIP_DECAY: f64 = 0.07;

/// Smootherstep (Perlin's second-order smoothstep). Zero first AND second
/// derivative at both ends, so values driven by it start and stop without a
/// visible kink.
pub fn smootherstep(t: f64) -> f64 {
    let t = t.clamp(0.0, 1.0);
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}

/// Cubic ease-out — fast departure, gentle settle.
pub fn ease_out_cubic(t: f64) -> f64 {
    let t = t.clamp(0.0, 1.0);
    1.0 - (1.0 - t).powi(3)
}

/// Exponential ease-out, for opacity rises that must feel instant.
pub fn ease_out_expo(t: f64) -> f64 {
    let t = t.clamp(0.0, 1.0);
    if t >= 1.0 {
        1.0
    } else {
        1.0 - (-9.0 * t).exp2()
    }
}

fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

/// Normalised progress of the ramp portion of the hold, ignoring shaping.
///
/// Returns 0 until `hold_delay` so a quick click never paints a partial ring,
/// and 1 at `duration`, when the gesture arms.
pub fn hold_progress_raw(elapsed: f64, hold_delay: f64, duration: f64) -> f64 {
    let span = duration - hold_delay;
    if span <= 0.0 {
        return if elapsed >= duration { 1.0 } else { 0.0 };
    }
    ((elapsed - hold_delay) / span).clamp(0.0, 1.0)
}

/// Eased hold progress: an instant lead-in so the press registers immediately,
/// then smootherstep so the ring decelerates into completion instead of
/// arriving at full speed.
pub fn hold_progress(elapsed: f64, hold_delay: f64, duration: f64) -> f64 {
    let raw = hold_progress_raw(elapsed, hold_delay, duration);
    if raw <= 0.0 {
        return 0.0;
    }
    RING_LEAD_IN + (1.0 - RING_LEAD_IN) * smootherstep(raw)
}

/// How far the envelope has crossfaded toward a uniform outline. 0 while the
/// comet still reads as a comet, 1 at completion.
pub fn ring_seal(progress: f64) -> f64 {
    smootherstep((progress - RING_SEAL_FROM) / (1.0 - RING_SEAL_FROM).max(1e-3))
}

/// Comet tail length in pixels for the given progress.
pub fn ring_tail_len(progress: f64, total_len: f64) -> f64 {
    let relax = smootherstep(progress / RING_TAIL_RELAX_BY);
    lerp(
        total_len * RING_TAIL_START,
        total_len * RING_TAIL_FULL,
        relax,
    )
}

/// Brightness envelope at `dist` along the perimeter.
///
/// `head_len` is `total_len * progress`. Behind the head the envelope falls off
/// toward `RING_TRAIL_FLOOR`; as `progress` approaches 1 the whole curve
/// crossfades to a flat 1.0 so the seam disappears.
pub fn ring_envelope(dist: f64, head_len: f64, progress: f64, total_len: f64) -> f64 {
    let tail = ring_tail_len(progress, total_len).max(1e-6);
    let floor = lerp(0.0, RING_TRAIL_FLOOR, (progress * 3.0).clamp(0.0, 1.0));
    let u = ((head_len - dist) / tail).clamp(0.0, 1.0);
    let comet = (1.0 - u).powf(1.7).max(floor);
    lerp(comet, 1.0, ring_seal(progress))
}

/// Travelling glimmer multiplier at `dist`, in `0..=1`.
///
/// `wave_phase` is the pill's internal waveform phase, so the outline shimmers
/// in sync with the sine waves inside it.
pub fn ring_glimmer(dist: f64, total_len: f64, wave_phase: f64, progress: f64) -> f64 {
    let cycle = dist / total_len.max(1.0) * std::f64::consts::TAU * RING_GLIMMER_CYCLES;
    let wave = 0.5 + 0.5 * (cycle - wave_phase * RING_GLIMMER_SPEED).sin();
    let depth = RING_GLIMMER_DEPTH * lerp(0.55, 1.0, ring_seal(progress));
    1.0 - depth + depth * wave
}

/// How far the comet head has dissolved, in `0..=1`.
///
/// Driven by `RING_HEAD_FADE_FROM`, but never lags the seal: once the ring has
/// closed into a uniform outline the head must already be gone, or it would
/// sit as a bright lump on the seam.
fn ring_head_dissolve(progress: f64) -> f64 {
    ring_seal(progress).max(smootherstep(
        (progress - RING_HEAD_FADE_FROM) / (1.0 - RING_HEAD_FADE_FROM).max(1e-3),
    ))
}

/// Alpha of the comet head. Reaches 0 before completion so nothing bright is
/// left parked at the seam.
pub fn ring_head_fade(progress: f64, arm_t: f64) -> f64 {
    (1.0 - ring_head_dissolve(progress))
        * (1.0 - arm_t.clamp(0.0, 1.0))
        * (progress * 6.0).clamp(0.0, 1.0)
}

/// Radius of the comet head, which blooms outward as it dissolves so the head
/// spreads into the ring rather than simply vanishing.
pub fn ring_head_radius(progress: f64) -> f64 {
    RING_HEAD_RADIUS * (1.0 + RING_HEAD_BLOOM * ring_head_dissolve(progress))
}

/// Radius fraction and alpha falloff of one concentric head disc.
///
/// Discs are numbered `1..=steps` from the inside out (`k = steps` is the
/// outermost). Returns `(radius_frac, falloff)`: `radius_frac` grows with `k`
/// so discs stack outward from the head centre, while `falloff` shrinks with
/// `k` so brightness falls off toward the rim.
pub fn ring_head_disc(k: usize, steps: usize) -> (f64, f64) {
    let steps = steps.max(1);
    let k = k.clamp(1, steps);
    let radius_frac = k as f64 / steps as f64;
    let falloff = (1.0 - (k - 1) as f64 / steps as f64).powf(RING_HEAD_FALLOFF_EXP);
    (radius_frac, falloff)
}

// ── Long-press ring shadow ────────────────────────────────────
/// Soft dark halo behind the silver ring so it stays readable on light
/// backdrops. The renderers have no blur primitive on the render path, so the
/// halo is approximated with layered strokes over the ring path: each entry
/// is a `(stroke width, alpha)` pass. Widths grow while alphas shrink, so the
/// passes sum to a falloff that is darkest exactly under the ring and gone
/// within a few pixels; the combined alpha is kept low enough that dark
/// backdrops are unaffected.
pub const RING_SHADOW_LAYERS: &[(f64, f64)] =
    &[(2.0, 0.07), (4.0, 0.05), (6.0, 0.035), (8.0, 0.02)];

/// Per-disc alpha of the dark underlay beneath the comet head. It mirrors the
/// head's concentric-disc shading so the soft silver blob also separates from
/// a light backdrop.
pub const RING_SHADOW_HEAD_ALPHA: f64 = 0.06;

/// Guard against dividing by a zero path length when normalising `head_len`
/// against `total_len` in [`ring_head_index`]. A degenerate perimeter would
/// otherwise produce `NaN` and poison the index; the value is tiny relative to
/// any real pixel distance, so it can never shift the selected point.
pub const RING_PATH_LEN_EPSILON: f64 = 1e-9;

/// Index of the resampled perimeter point nearest `head_len`.
///
/// Shared by the comet-head disc and the shadow arc so the two can never
/// drift apart; the renderers previously repeated this placement inline.
/// Returns `0` for degenerate input (`point_count < 2`); callers must treat
/// that as "no perimeter to place a head on".
pub fn ring_head_index(head_len: f64, total_len: f64, point_count: usize) -> usize {
    if point_count < 2 {
        return 0;
    }
    // Degenerate perimeter: there is no meaningful position along the ring,
    // so clamp to the first interior point instead of letting
    // head_len / total_len explode (the epsilon guard alone would produce a
    // huge fraction and clamp to the last point, which is the opposite end).
    if total_len <= RING_PATH_LEN_EPSILON {
        return 1;
    }
    let frac = head_len / total_len;
    ((frac * (point_count - 1) as f64).round() as usize).clamp(1, point_count - 1)
}

/// One concentric disc of the comet head, or of the dark underlay beneath it.
///
/// Positions and alphas are final: a renderer fills a circle per disc and adds
/// nothing of its own but the colour.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RingHeadDisc {
    pub cx: f64,
    pub cy: f64,
    pub radius: f64,
    pub alpha: f64,
}

/// The shadow and head layers of one ring frame, resolved once from the
/// resampled perimeter.
///
/// The three renderers differ only in which primitives they call — Core
/// Graphics strokes, Cairo strokes, Direct2D geometries. Everything *before*
/// the primitive (where the head sits, how many shadow passes to make, each
/// disc's radius and alpha, and which layers are too faint to bother with) is
/// identical, so it lives here: a platform can no longer drift by forgetting a
/// pass, ordering the discs the other way, or applying `ring_alpha` twice.
///
/// The comet body is deliberately NOT part of this: its per-segment shading is
/// already driven by [`ring_envelope`] / [`ring_glimmer`], and it needs a
/// different primitive per backend (batched lines on Windows, immediate
/// strokes elsewhere).
#[derive(Debug, Clone, Copy)]
pub struct RingLayers {
    /// Index of the comet head in the resampled buffer. The shadow arc is
    /// `points[..=head_index]`, i.e. the perimeter the comet has covered.
    pub head_index: usize,
    /// Head centre, taken from the resampled point at `head_index`.
    pub head_x: f64,
    pub head_y: f64,
    /// Head radius for this frame, already bloomed by [`ring_head_radius`].
    pub head_radius: f64,
    /// Peak alpha of the dark underlay discs, before per-disc falloff.
    pub underlay_peak_alpha: f64,
    /// Peak alpha of the silver head discs, before per-disc falloff.
    pub head_peak_alpha: f64,
    /// Master ring alpha, already folded into the peaks above and into
    /// [`RingLayers::shadow_passes`].
    ring_alpha: f64,
}

impl RingLayers {
    /// Resolve the layers for one frame, or `None` when there is nothing to
    /// paint: a degenerate buffer (`points.len() < 2`), a fully faded ring, or
    /// a comet that has not started travelling yet.
    ///
    /// `points` are the `(x, y, dist)` triples from [`resample_perimeter`].
    pub fn new(
        points: &[(f64, f64, f64)],
        head_len: f64,
        total_len: f64,
        progress: f64,
        arm_t: f64,
        ring_alpha: f64,
    ) -> Option<Self> {
        if points.len() < 2 || ring_alpha <= 0.0 || head_len <= 0.0 {
            return None;
        }
        let head_index = ring_head_index(head_len, total_len, points.len());
        let (head_x, head_y, _) = points[head_index];
        let head_fade = ring_head_fade(progress, arm_t);
        Some(Self {
            head_index,
            head_x,
            head_y,
            head_radius: ring_head_radius(progress),
            underlay_peak_alpha: RING_SHADOW_HEAD_ALPHA * head_fade * ring_alpha,
            head_peak_alpha: RING_HEAD_ALPHA * head_fade * ring_alpha,
            ring_alpha,
        })
    }

    /// `(stroke width, alpha)` for each halo pass over `points[..=head_index]`,
    /// with the master ring alpha already applied. Narrowest and darkest pass
    /// first; since every pass paints the same black, source-over compositing
    /// is order-independent here — what matters is that a renderer makes all
    /// of them.
    pub fn shadow_passes(&self) -> impl Iterator<Item = (f64, f64)> {
        let ring_alpha = self.ring_alpha;
        RING_SHADOW_LAYERS
            .iter()
            .map(move |&(width, layer_alpha)| (width, layer_alpha * ring_alpha))
    }

    /// Dark discs painted under the head, so the soft silver blob separates
    /// from a light backdrop. Empty when the head is too faint to matter.
    pub fn underlay_discs(&self) -> impl Iterator<Item = RingHeadDisc> {
        self.discs(self.underlay_peak_alpha)
    }

    /// The silver head itself, as concentric discs approximating a radial
    /// falloff. Empty when the head has dissolved.
    pub fn head_discs(&self) -> impl Iterator<Item = RingHeadDisc> {
        self.discs(self.head_peak_alpha)
    }

    /// Discs for one stack, outermost first so the brighter inner discs are
    /// painted over the dimmer outer ones.
    fn discs(&self, peak_alpha: f64) -> impl Iterator<Item = RingHeadDisc> {
        // An empty range is how "too faint to draw" is expressed, so the
        // decision stays here instead of being re-derived by every renderer.
        let steps = if peak_alpha > RING_HEAD_FADE_CUTOFF {
            RING_HEAD_STEPS
        } else {
            0
        };
        let (cx, cy, head_radius) = (self.head_x, self.head_y, self.head_radius);
        (1..=steps).rev().map(move |k| {
            let (radius_frac, falloff) = ring_head_disc(k, steps);
            RingHeadDisc {
                cx,
                cy,
                radius: head_radius * radius_frac,
                alpha: peak_alpha * falloff * RING_HEAD_DISC_ALPHA_SCALE,
            }
        })
    }
}

/// Inflate target for the current gesture state.
///
/// Inflation begins partway through the hold (`INFLATE_PRE_AT`) so the pill is
/// already growing while the ring fills; arming then continues that motion
/// instead of starting a new one.
pub fn inflate_target(progress: f64, held: bool, dragging: bool) -> f64 {
    if dragging {
        return 1.0;
    }
    if !held {
        return 0.0;
    }
    let t = smootherstep((progress - INFLATE_PRE_AT) / (1.0 - INFLATE_PRE_AT).max(1e-3));
    t * INFLATE_PRE_AMOUNT
}

/// Scale reduction for the press anticipation dip. Decays quickly and is
/// suppressed once the pill starts inflating.
pub fn press_dip(press_elapsed: f64, inflate: f64) -> f64 {
    if press_elapsed < 0.0 {
        return 0.0;
    }
    let decay = (-press_elapsed / PRESS_DIP_DECAY).exp();
    PRESS_DIP * decay * (1.0 - (inflate * 2.0).clamp(0.0, 1.0))
}

/// Once the press/drag ends, the long-press outline lingers only this long.
/// While the gesture is held the outline is pinned at full alpha — it must
/// never fade while the pill is still pressed and inflated.
pub const LONG_PRESS_RING_FADE: f64 = 0.5;

/// Master ring alpha.
///
/// Rises with an exponential ease so the outline appears to arrive instantly,
/// and leaves on an accelerating curve — exits should be quicker than entrances.
/// `hold_elapsed` is time since the press began; `release_elapsed` is time
/// since it ended.
pub fn ring_alpha(held: bool, hold_elapsed: f64, release_elapsed: f64, hold_delay: f64) -> f64 {
    if held {
        return ease_out_expo((hold_elapsed - hold_delay) / RING_ALPHA_RISE);
    }
    let t = (release_elapsed / LONG_PRESS_RING_FADE).clamp(0.0, 1.0);
    if t >= 1.0 {
        0.0
    } else {
        1.0 - t * t
    }
}

/// Outward drift of the ring while it fades after release, in pixels.
pub fn ring_release_drift(release_elapsed: f64) -> f64 {
    RING_RELEASE_DRIFT * ease_out_cubic(release_elapsed / LONG_PRESS_RING_FADE)
}

/// The pill must be at least this expanded before the style tooltip appears,
/// so the tooltip never floats above a still-collapsing pill.
pub const STYLE_TOOLTIP_EXPAND_T: f64 = 0.3;

/// Visibility rule for the dictation style tooltip, the style selector that
/// floats above the pill.
///
/// The tooltip is hover-revealed: the pointer on the pill shows it (so the
/// chevrons stay clickable mid-take) and the pointer leaving fades it out.
/// Paused keeps it hidden even on hover, leaving the pause/resume controls
/// free of it.
///
/// Hover alone cannot decide take-start: a take that begins under a parked
/// pointer would keep the tooltip open for the whole take. That timing lives
/// in [`StyleTooltipGate`], which forces the fade when a take starts and
/// re-arms hover-reveal once the pointer has actually left the pill.
pub fn style_tooltip_visible(
    assistant_active: bool,
    style_count: u32,
    paused: bool,
    hovered: bool,
    expand_t: f64,
) -> bool {
    !assistant_active && style_count > 1 && !paused && hovered && expand_t > STYLE_TOOLTIP_EXPAND_T
}

/// Spring target (0.0 or 1.0) for the style tooltip, combining the pure
/// visibility rule with the take-start gate.
pub fn style_tooltip_target(
    gate: &StyleTooltipGate,
    assistant_active: bool,
    style_count: u32,
    paused: bool,
    hovered: bool,
    expand_t: f64,
) -> f64 {
    // The gate must be evaluated first: is_suppressed() is what releases the
    // latch on pointer-leave, so hiding it behind the pure rule's
    // short-circuit would leave the latch set whenever the tooltip is
    // ineligible for any other reason (single style, assistant panel,
    // collapsed pill) and the tooltip would stay hidden on the next hover
    // entry in the same take.
    if !gate.is_suppressed(hovered)
        && style_tooltip_visible(assistant_active, style_count, paused, hovered, expand_t)
    {
        1.0
    } else {
        0.0
    }
}

/// Reset every piece of flash-banner state back to "no toast showing".
///
/// The three pills dismiss a toast from several places: the display timeout,
/// an explicit DismissToast, and clicking either the accept or the reject
/// button. Centralising the reset keeps the six fields from drifting apart
/// per platform, since forgetting one leaves a stale action wired to
/// whichever toast appears next.
pub fn clear_flash_state(
    flash_visible: &Cell<bool>,
    flash_timer: &Cell<f64>,
    flash_action: &RefCell<Option<String>>,
    flash_action_label: &RefCell<Option<String>>,
    flash_reject_action: &RefCell<Option<String>>,
    flash_reject_action_label: &RefCell<Option<String>>,
) {
    flash_visible.set(false);
    flash_timer.set(0.0);
    *flash_action.borrow_mut() = None;
    *flash_action_label.borrow_mut() = None;
    *flash_reject_action.borrow_mut() = None;
    *flash_reject_action_label.borrow_mut() = None;
}

/// Spring target (0.0 or 1.0) for the flash banner (the native pill toast,
/// e.g. the retranscribing banner).
///
/// The banner and the style tooltip share the strip above the pill, so one
/// must yield. A banner without an action button is informational and yields
/// to a revealed tooltip: hovering the pill swaps the banner for the style
/// selector without cancelling the banner, which returns once the pointer
/// leaves and it has not expired. A banner with an action button (for
/// example the cancel-dictation confirm) keeps the strip; it is an
/// interactive prompt, so the tooltip stays suppressed beneath it.
pub fn flash_banner_target(flash_visible: bool, has_action: bool, tooltip_revealed: bool) -> f64 {
    if flash_visible && (has_action || !tooltip_revealed) {
        1.0
    } else {
        0.0
    }
}

/// Whether a toast's buttons should take clicks at the given banner opacity.
///
/// A toast may carry an accept button, a reject button, or both. Each is drawn
/// from its own label, so a toast with only a reject button still paints a
/// button and registers a click region for it; hit testing that looks at the
/// accept action alone leaves that button drawn but dead. Both flags matter, so
/// the decision is shared rather than re-derived per platform and drifting
/// again.
///
/// The banner is held inert until it has mostly faded in, so a click cannot
/// fire an action for a button the user has not seen yet. A toast with no
/// buttons at all is not clickable: there is nothing to hit, and claiming
/// input would swallow clicks meant for the pill behind it.
pub const fn flash_banner_is_clickable(has_action: bool, has_reject: bool, banner_t: f64) -> bool {
    (has_action || has_reject) && banner_t >= 0.5
}

/// Latch that forces the style tooltip to fade the moment a take starts,
/// even under a pointer that never leaves the pill.
///
/// The latch holds from take-start until the pointer actually leaves the
/// pill or the take ends, so the tooltip comes back on the next hover entry
/// and the chevrons stay reachable mid-take.
#[derive(Debug, Clone, Default)]
pub struct StyleTooltipGate {
    suppressed: Cell<bool>,
}

impl StyleTooltipGate {
    /// Phase-handler hook. Recording latches the fade (a resume from Paused
    /// re-latches: the tooltip must not pop back in on resume under a parked
    /// pointer); every other phase (Idle, Loading, Paused) releases it. Paused
    /// still hides the tooltip through [`style_tooltip_visible`] either way.
    pub fn set_take_running(&self, running: bool) {
        self.suppressed.set(running);
    }

    /// Tick hook: reports whether the tooltip stays hidden. The pointer
    /// leaving the pill releases the latch, so the next hover entry
    /// reveals the tooltip again.
    pub fn is_suppressed(&self, hovered: bool) -> bool {
        if !hovered {
            self.suppressed.set(false);
        }
        self.suppressed.get()
    }
}

/// Normalised progress of the arm-confirmation pulse, in `0..=1`.
///
/// `arm_pulse` is seconds since arming, or negative when no pulse is running;
/// a retired pulse reports 1.0 so renderers treat it as finished.
pub fn pulse_progress(arm_pulse: f64) -> f64 {
    if !pulse_is_running(arm_pulse) {
        return 1.0;
    }
    (arm_pulse / RING_PULSE_DURATION).clamp(0.0, 1.0)
}

/// Resamples a perimeter polyline into evenly-spaced points, appending
/// `(x, y, distance_along_path)` triples to `out`.
///
/// Per-segment shading needs uniform arc length: on the raw path the corner
/// arcs carry most of the vertices while a long straight edge is a single
/// segment, so a gradient evaluated per segment would band badly. Writing into
/// a caller-owned buffer keeps this allocation-free on the render path.
pub fn resample_perimeter(
    path: &[(f64, f64)],
    distances: &[f64],
    total_len: f64,
    step_px: f64,
    out: &mut Vec<(f64, f64, f64)>,
) {
    out.clear();
    if path.len() < 2 || total_len <= 0.0 {
        return;
    }

    let count = ((total_len / step_px.max(0.1)).round() as usize).max(24);
    let mut seg = 1usize;
    for i in 0..=count {
        let target = (i as f64 / count as f64) * total_len;
        while seg < distances.len() - 1 && distances[seg] < target {
            seg += 1;
        }
        let d0 = distances[seg - 1];
        let d1 = distances[seg];
        let k = if d1 > d0 {
            (target - d0) / (d1 - d0)
        } else {
            0.0
        };
        let (x0, y0) = path[seg - 1];
        let (x1, y1) = path[seg];
        out.push((x0 + (x1 - x0) * k, y0 + (y1 - y0) * k, target));
    }
}

/// One frame of ring bookkeeping, shared by all three platform renderers so
/// their timing cannot drift apart.
///
/// Inputs are the raw gesture facts; outputs are the animated values the
/// renderer reads. `held` means the ring should be lit — the long press is past
/// its delay, or a drag is underway.
#[derive(Debug, Clone, Copy)]
pub struct RingTick {
    pub held: bool,
    pub dragging: bool,
    pub progress: f64,
    pub delta_seconds: f64,
}

/// Mutable ring animation values advanced by [`advance_ring`].
///
/// [`Default`] is hand-written: two fields use non-zero sentinels, so a derived
/// all-zeroes default would mean "a pulse is running" and "the button was
/// released this instant", painting a phantom ring on the very first frame.
#[derive(Debug, Clone, Copy)]
pub struct RingAnim {
    pub alpha: f64,
    pub release_progress: f64,
    pub press_elapsed: f64,
    pub release_elapsed: f64,
    pub arm_t: f64,
    /// Seconds since arming; negative when no pulse is running.
    pub arm_pulse: f64,
}

impl Default for RingAnim {
    fn default() -> Self {
        Self {
            alpha: 0.0,
            release_progress: 0.0,
            press_elapsed: 0.0,
            // Seed the release timer past the end of the fade so a freshly
            // built pill starts fully faded out instead of mid-release.
            release_elapsed: LONG_PRESS_RING_FADE,
            arm_t: 0.0,
            // Negative means "no pulse in flight"; 0.0 would mean one just
            // started.
            arm_pulse: PULSE_IDLE,
        }
    }
}

/// Time for `arm_t` to ramp in once armed.
pub const ARM_RAMP_IN: f64 = 0.22;
/// Time for `arm_t` to ramp back out after the drag ends.
pub const ARM_RAMP_OUT: f64 = 0.18;

/// Sentinel for `arm_pulse` meaning "no confirmation pulse in flight".
///
/// Negative rather than zero because 0.0 is a real value: the frame the pulse
/// starts. Use [`pulse_armed`] and [`pulse_is_running`] rather than bare
/// comparisons, so the sentinel is named at every site.
pub const PULSE_IDLE: f64 = -1.0;

/// Starts the arm-confirmation pulse; assign the result to `arm_pulse`.
///
/// Free functions rather than `RingAnim` methods because the gesture layer
/// arms the pulse from a `Cell<f64>` several frames before any `RingAnim` is
/// materialised, so a method would be unreachable from the real call site.
pub fn pulse_armed() -> f64 {
    0.0
}

/// True while a confirmation pulse is running, given a raw `arm_pulse`.
pub fn pulse_is_running(arm_pulse: f64) -> bool {
    arm_pulse >= 0.0
}

/// Advances one frame of ring animation.
///
/// Call once per tick, before drawing. Starting a pulse is the caller's job
/// (assign [`pulse_armed()`] to `arm_pulse`) because only the gesture layer
/// knows the exact frame the long press completed.
pub fn advance_ring(anim: &mut RingAnim, tick: RingTick, hold_delay: f64) {
    let dt = tick.delta_seconds.max(0.0);

    if tick.held {
        anim.press_elapsed += dt;
        anim.release_elapsed = 0.0;
        // Remember how far the ramp filled so a release mid-ramp fades from
        // the level actually reached rather than snapping to a full ring.
        anim.release_progress = if tick.dragging { 1.0 } else { tick.progress };
    } else {
        anim.release_elapsed += dt;
        anim.press_elapsed = 0.0;
    }

    anim.alpha = ring_alpha(
        tick.held,
        anim.press_elapsed + hold_delay,
        anim.release_elapsed,
        hold_delay,
    );

    anim.arm_t = if tick.dragging {
        (anim.arm_t + dt / ARM_RAMP_IN).min(1.0)
    } else {
        (anim.arm_t - dt / ARM_RAMP_OUT).max(0.0)
    };

    if pulse_is_running(anim.arm_pulse) {
        anim.arm_pulse += dt;
        if anim.arm_pulse > RING_PULSE_DURATION {
            anim.arm_pulse = PULSE_IDLE;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_and_new_start_the_shared_controllers_idle() {
        for controller in [drag::DragController::default(), drag::DragController::new()] {
            assert_eq!(controller.phase(), drag::DragPhase::Idle);
            assert!(!controller.is_settling());
        }
        for hover in [hover::HoverIntent::default(), hover::HoverIntent::new()] {
            assert!(!hover.hovered());
        }
        for placement in [
            placement::SelectorPlacement::default(),
            placement::SelectorPlacement::new(),
        ] {
            assert_eq!(placement.side(), placement::SelectorSide::Above);
            assert_eq!(placement.blend(), 0.0);
            assert_eq!(placement.blend_velocity(), 0.0);
        }
        for deform in [
            deform::CrossingDeform::default(),
            deform::CrossingDeform::new(),
        ] {
            assert!(!deform.animating());
        }
    }

    #[test]
    fn perimeter_closes_back_to_start() {
        let pts =
            rounded_rectangle_perimeter(10.0, 20.0, 120.0, 32.0, 16.0, RoundedRectArcSteps::Auto);
        assert!(pts.len() > 8);
        let first = pts[0];
        let last = *pts.last().unwrap();
        // The final arc segment lands at the start point (within floating error).
        assert!((last.0 - first.0).abs() < 1e-6);
        assert!((last.1 - first.1).abs() < 1e-6);
    }

    #[test]
    fn zero_radius_produces_a_rectangle() {
        let pts =
            rounded_rectangle_perimeter(0.0, 0.0, 100.0, 50.0, 0.0, RoundedRectArcSteps::Exact(1));
        // With r=0 the "arcs" collapse to the corners: 4 edge endpoints +
        // 4 one-step corners + the closing start point = 9.
        assert_eq!(pts.len(), 9);
        let (_, total) = path_distances(&pts);
        assert!((total - 300.0).abs() < 1e-6);
    }

    #[test]
    fn auto_steps_follow_radius() {
        let small =
            rounded_rectangle_perimeter(0.0, 0.0, 100.0, 32.0, 8.0, RoundedRectArcSteps::Auto);
        let big =
            rounded_rectangle_perimeter(0.0, 0.0, 400.0, 200.0, 100.0, RoundedRectArcSteps::Auto);
        // Bigger radius -> more steps; the minimum is 6.
        assert!(big.len() > small.len());
        assert!(small.len() >= 6 * 4 + 5);
    }

    #[test]
    fn perimeter_total_length_matches_rectangle() {
        // A plain rectangle (r = 0) has a known perimeter 2*(w + h). The
        // collapsed corner arcs degenerate to the edge endpoints (so the path
        // legitimately repeats a vertex there), which is why we assert only the
        // total length rather than uniqueness of every point.
        let w = 120.0;
        let h = 32.0;
        let pts = rounded_rectangle_perimeter(0.0, 0.0, w, h, 0.0, RoundedRectArcSteps::Exact(1));
        let (_, total) = path_distances(&pts);
        assert!((total - 2.0 * (w + h)).abs() < 1e-6);
    }

    #[test]
    fn ring_alpha_is_pinned_while_held() {
        // Any point past the rise window while held is full opacity; the ring
        // must never fade underneath an active press.
        assert!(ring_alpha(true, 0.12 + RING_ALPHA_RISE, 0.0, 0.12) > 0.99);
        assert!(ring_alpha(true, 5.0, 0.0, 0.12) > 0.99);
    }

    #[test]
    fn ring_alpha_fades_monotonically_after_release() {
        let mut prev = ring_alpha(false, 0.0, 0.0, 0.12);
        assert!((prev - 1.0).abs() < 1e-9);
        for i in 1..=25 {
            let next = ring_alpha(false, 0.0, LONG_PRESS_RING_FADE * i as f64 / 25.0, 0.12);
            assert!(next < prev, "alpha rose during the fade");
            prev = next;
        }
    }

    #[test]
    fn ring_alpha_never_goes_below_zero() {
        assert_eq!(ring_alpha(false, 0.0, LONG_PRESS_RING_FADE, 0.12), 0.0);
        assert_eq!(ring_alpha(false, 0.0, 100.0, 0.12), 0.0);
    }

    #[test]
    fn pulse_progress_reports_a_retired_pulse_as_finished() {
        assert_eq!(pulse_progress(-1.0), 1.0);
        assert_eq!(pulse_progress(0.0), 0.0);
        assert_eq!(pulse_progress(RING_PULSE_DURATION), 1.0);
        // Saturates rather than overshooting.
        assert_eq!(pulse_progress(RING_PULSE_DURATION * 3.0), 1.0);
    }

    // ── New ring model ────────────────────────────────────────────────

    const HOLD_DELAY: f64 = 0.12;
    const DURATION: f64 = 0.45;

    #[test]
    fn hold_progress_credits_a_lead_in_immediately() {
        // Nothing before the hold delay, so a click paints no ring.
        assert_eq!(hold_progress(0.0, HOLD_DELAY, DURATION), 0.0);
        assert_eq!(hold_progress(HOLD_DELAY, HOLD_DELAY, DURATION), 0.0);
        // Just past it, the lead-in is already visible.
        let p = hold_progress(HOLD_DELAY + 0.001, HOLD_DELAY, DURATION);
        assert!(p >= RING_LEAD_IN, "expected lead-in credit, got {p}");
    }

    #[test]
    fn hold_progress_completes_exactly_at_duration() {
        assert!((hold_progress(DURATION, HOLD_DELAY, DURATION) - 1.0).abs() < 1e-9);
        assert!((hold_progress(DURATION * 4.0, HOLD_DELAY, DURATION) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn hold_progress_is_monotonic() {
        let mut prev = 0.0;
        for i in 0..=100 {
            let t = DURATION * i as f64 / 100.0;
            let p = hold_progress(t, HOLD_DELAY, DURATION);
            assert!(p >= prev - 1e-12, "regressed at t={t}: {p} < {prev}");
            prev = p;
        }
    }

    #[test]
    fn hold_progress_decelerates_into_completion() {
        // Smootherstep: the last slice of time must advance less than a slice
        // taken mid-ramp, otherwise the ring arrives at full speed.
        let mid =
            hold_progress(0.30, HOLD_DELAY, DURATION) - hold_progress(0.29, HOLD_DELAY, DURATION);
        let end =
            hold_progress(0.45, HOLD_DELAY, DURATION) - hold_progress(0.44, HOLD_DELAY, DURATION);
        assert!(end < mid, "expected deceleration: end {end} >= mid {mid}");
    }

    /// The bug the seal exists to fix: on a closed ring, distance 0 and
    /// distance `total_len` are the same physical point, so an unsealed comet
    /// envelope leaves a hard brightness step there.
    #[test]
    fn envelope_seals_the_seam_at_completion() {
        let total = 1000.0;
        let head = total;
        let before = ring_envelope(total, head, 1.0, total);
        let after = ring_envelope(0.0, head, 1.0, total);
        assert!(
            (before - after).abs() < 1e-9,
            "seam step at completion: {before} vs {after}",
        );
        assert!((before - 1.0).abs() < 1e-9, "sealed ring must be uniform");
    }

    #[test]
    fn envelope_seam_step_shrinks_monotonically_into_completion() {
        // Measured from the point the seal has actually engaged. Just after
        // `RING_SEAL_FROM` the tail is still growing, which nudges the step up
        // by ~0.01 before the seal takes over; that bump is invisible because
        // the ring is still obviously a comet there. What must hold is that
        // once the seal is doing the work the step only ever falls, to zero.
        let total = 1000.0;
        let start = 0.78;
        let mut prev = f64::INFINITY;
        for i in 0..=40 {
            let p = start + (1.0 - start) * i as f64 / 40.0;
            let head = total * p;
            let step =
                (ring_envelope(head, head, p, total) - ring_envelope(0.0, head, p, total)).abs();
            assert!(step <= prev + 1e-9, "seam step grew at p={p}");
            prev = step;
        }
        assert!(prev < 1e-9, "seam never closed, final step {prev}");
    }

    #[test]
    fn sealing_strictly_reduces_the_seam_step() {
        // Guards the seal itself: without it the envelope keeps a large step
        // at the seam no matter how long the tail grows.
        let total = 1000.0;
        let head = total;
        let unsealed_tail = ring_tail_len(1.0, total);
        let u = ((head - 0.0) / unsealed_tail).clamp(0.0, 1.0);
        let unsealed = (1.0 - u).powf(1.7).max(RING_TRAIL_FLOOR);
        let unsealed_step = (1.0 - unsealed).abs();
        assert!(
            unsealed_step > 0.5,
            "expected a large raw seam step, got {unsealed_step}",
        );
        let sealed_step =
            (ring_envelope(head, head, 1.0, total) - ring_envelope(0.0, head, 1.0, total)).abs();
        assert!(sealed_step < 1e-9, "seal failed to close the seam");
    }

    #[test]
    fn envelope_is_brightest_at_the_head_while_filling() {
        let total = 1000.0;
        let p = 0.5;
        let head = total * p;
        let at_head = ring_envelope(head, head, p, total);
        let behind = ring_envelope(head - 100.0, head, p, total);
        assert!(
            at_head > behind,
            "head {at_head} not brighter than {behind}"
        );
    }

    #[test]
    fn envelope_never_falls_below_the_trail_floor() {
        let total = 1000.0;
        let p = 0.6;
        let head = total * p;
        for i in 0..=100 {
            let d = total * i as f64 / 100.0;
            let e = ring_envelope(d, head, p, total);
            assert!(
                (0.0..=1.0 + 1e-9).contains(&e),
                "envelope out of range: {e}"
            );
        }
    }

    #[test]
    fn glimmer_is_continuous_across_the_seam() {
        // A whole number of cycles must meet itself at the seam.
        assert_eq!(RING_GLIMMER_CYCLES.fract(), 0.0);
        let total = 1000.0;
        for &phase in &[0.0, 1.0, 2.5, 4.2] {
            let a = ring_glimmer(0.0, total, phase, 1.0);
            let b = ring_glimmer(total, total, phase, 1.0);
            assert!(
                (a - b).abs() < 1e-9,
                "glimmer seam mismatch at phase {phase}"
            );
        }
    }

    #[test]
    fn glimmer_stays_within_unit_range() {
        let total = 1000.0;
        for i in 0..200 {
            let d = total * i as f64 / 200.0;
            let g = ring_glimmer(d, total, 1.7, 0.8);
            assert!((0.0..=1.0).contains(&g), "glimmer out of range: {g}");
        }
    }

    #[test]
    fn head_is_fully_gone_before_completion() {
        assert!(ring_head_fade(1.0, 0.0).abs() < 1e-9);
        assert!(
            ring_head_fade(0.98, 0.0) < 0.01,
            "head still visible near completion",
        );
        // And it is bright early on.
        assert!(ring_head_fade(0.4, 0.0) > 0.5);
    }

    #[test]
    fn head_fade_is_monotonic_after_it_starts_dissolving() {
        let mut prev = f64::INFINITY;
        for i in 0..=50 {
            let p = RING_HEAD_FADE_FROM + (1.0 - RING_HEAD_FADE_FROM) * i as f64 / 50.0;
            let f = ring_head_fade(p, 0.0);
            assert!(f <= prev + 1e-9, "head brightened at p={p}");
            prev = f;
        }
    }

    #[test]
    fn head_blooms_outward_as_it_dissolves() {
        let early = ring_head_radius(0.5);
        let late = ring_head_radius(1.0);
        assert!(late > early, "head must expand while fading");
        assert!((early - RING_HEAD_RADIUS).abs() < 1e-9);
    }

    #[test]
    fn ring_head_index_lands_within_one_segment_of_head_len() {
        let path =
            rounded_rectangle_perimeter(0.0, 0.0, 120.0, 32.0, 16.0, RoundedRectArcSteps::Auto);
        let (distances, total) = path_distances(&path);
        let mut pts = Vec::new();
        resample_perimeter(&path, &distances, total, RING_SEGMENT_PX, &mut pts);
        for p in [0.1, 0.3, 0.5, 0.8, 1.0] {
            let head_len = total * p;
            let idx = ring_head_index(head_len, total, pts.len());
            assert!(
                (pts[idx].2 - head_len).abs() <= RING_SEGMENT_PX + 1e-9,
                "head point {idx} is {}px from head_len {head_len}",
                (pts[idx].2 - head_len).abs(),
            );
        }
    }

    #[test]
    fn ring_head_index_is_bounded_and_monotonic() {
        // Clamps into the valid range, including the seam point at full ring.
        assert_eq!(ring_head_index(0.0, 100.0, 10), 1);
        assert_eq!(ring_head_index(100.0, 100.0, 10), 9);
        let mut prev = 0usize;
        for i in 0..=20 {
            let idx = ring_head_index(100.0 * i as f64 / 20.0, 100.0, 10);
            assert!(idx >= prev, "head index regressed at {i}");
            prev = idx;
        }
    }

    #[test]
    fn ring_head_index_handles_degenerate_input() {
        assert_eq!(ring_head_index(50.0, 100.0, 0), 0);
        assert_eq!(ring_head_index(50.0, 100.0, 1), 0);
        // A zero path length must not produce NaN.
        assert_eq!(ring_head_index(0.0, 0.0, 10), 1);
        assert_eq!(ring_head_index(5.0, 0.0, 10), 1);
    }

    #[test]
    fn ring_head_disc_fractions_and_falloff() {
        let steps = RING_HEAD_STEPS;
        // Discs are numbered 1..=steps from the inside out, so walking `k`
        // upward walks outward from the head centre: the radius grows with
        // every step while the falloff dims, which is the same statement as
        // "brightness increases inward".
        let mut prev_radius = 0.0;
        let mut prev_falloff = f64::INFINITY;
        for k in 1..=steps {
            let (radius_frac, falloff) = ring_head_disc(k, steps);
            assert!(
                (0.0..=1.0).contains(&radius_frac),
                "radius out of range: {radius_frac}"
            );
            assert!(
                (0.0..=1.0).contains(&falloff),
                "falloff out of range: {falloff}"
            );
            assert!(
                radius_frac > prev_radius,
                "disc radius must grow outward at k={k}"
            );
            assert!(falloff < prev_falloff, "falloff must dim outward at k={k}");
            prev_radius = radius_frac;
            prev_falloff = falloff;
        }
        // The outermost disc spans the whole head radius, so the stack covers
        // the head exactly rather than stopping short of the rim.
        assert_eq!(ring_head_disc(steps, steps).0, 1.0);
        // Innermost disc is unattenuated; the outermost carries the exponent.
        assert_eq!(ring_head_disc(1, steps).1, 1.0);
        let (_, outer) = ring_head_disc(steps, steps);
        assert!((outer - (1.0 / steps as f64).powf(RING_HEAD_FALLOFF_EXP)).abs() < 1e-12);
    }

    #[test]
    fn ring_head_disc_clamps_its_inputs() {
        assert_eq!(ring_head_disc(0, 4), ring_head_disc(1, 4));
        assert_eq!(ring_head_disc(9, 4), ring_head_disc(4, 4));
        // Zero steps collapses to a single full-radius, full-alpha disc.
        assert_eq!(ring_head_disc(1, 0), (1.0, 1.0));
    }

    /// These are all `const`, so an `assert!(CONST)` in a `#[test]` is folded
    /// away at compile time and the test passes whatever the constants say —
    /// `clippy::assertions_on_constants` is right about that. `const _` blocks
    /// are evaluated during compilation, so an inequality that stops holding
    /// fails the build instead of a test nobody would have read anyway.
    const _: () = {
        // Roughly one 8-bit alpha step (1/255 ≈ 0.0039): below it a disc would
        // contribute less than a single alpha step and is not worth painting.
        assert!(RING_HEAD_FADE_CUTOFF > 0.0);
        assert!(RING_HEAD_FADE_CUTOFF <= 1.0 / 255.0 * 1.5);
        // The comet's per-segment cutoff is deliberately the coarser of the two
        // -- hundreds of segments per frame versus a handful of discs -- but
        // must still stay within a few 8-bit alpha steps.
        assert!(RING_SEGMENT_ALPHA_CUTOFF > RING_HEAD_FADE_CUTOFF);
        assert!(RING_SEGMENT_ALPHA_CUTOFF <= 1.0 / 255.0 * 4.0);
        // The path-length guard must stay far below any real pixel distance.
        assert!(RING_PATH_LEN_EPSILON > 0.0 && RING_PATH_LEN_EPSILON < 1e-3);
    };

    /// A resampled perimeter of the size the pills actually draw.
    fn sample_ring() -> (Vec<(f64, f64, f64)>, f64) {
        let path =
            rounded_rectangle_perimeter(0.0, 0.0, 120.0, 32.0, 16.0, RoundedRectArcSteps::Auto);
        let (distances, total) = path_distances(&path);
        let mut points = Vec::new();
        resample_perimeter(&path, &distances, total, RING_SEGMENT_PX, &mut points);
        (points, total)
    }

    #[test]
    fn ring_layers_reports_nothing_to_paint_for_degenerate_frames() {
        let (points, total) = sample_ring();
        // Fewer than two points, a faded-out ring and a comet that has not
        // set off all mean "draw nothing" — the renderers rely on this to
        // avoid indexing an empty buffer.
        assert!(RingLayers::new(&points[..1], total * 0.5, total, 0.5, 0.0, 1.0).is_none());
        assert!(RingLayers::new(&[], total * 0.5, total, 0.5, 0.0, 1.0).is_none());
        assert!(RingLayers::new(&points, total * 0.5, total, 0.5, 0.0, 0.0).is_none());
        assert!(RingLayers::new(&points, 0.0, total, 0.0, 0.0, 1.0).is_none());
        assert!(RingLayers::new(&points, total * 0.5, total, 0.5, 0.0, 1.0).is_some());
    }

    #[test]
    fn ring_layers_places_the_head_on_the_shared_index() {
        let (points, total) = sample_ring();
        for p in [0.05, 0.4, 1.0] {
            let head_len = total * p;
            let layers = RingLayers::new(&points, head_len, total, p, 0.0, 1.0).unwrap();
            // Same placement the shadow arc slices to, so the halo can never
            // stop short of (or run past) the head it sits under.
            assert_eq!(
                layers.head_index,
                ring_head_index(head_len, total, points.len())
            );
            let (hx, hy, _) = points[layers.head_index];
            assert_eq!((layers.head_x, layers.head_y), (hx, hy));
            assert!(layers.head_index < points.len());
        }
    }

    #[test]
    fn ring_layers_shadow_passes_carry_the_ring_alpha() {
        let (points, total) = sample_ring();
        let ring_alpha = 0.4;
        let layers = RingLayers::new(&points, total * 0.5, total, 0.5, 0.0, ring_alpha).unwrap();
        let passes: Vec<(f64, f64)> = layers.shadow_passes().collect();
        assert_eq!(passes.len(), RING_SHADOW_LAYERS.len());
        for (&(want_w, want_a), &(got_w, got_a)) in RING_SHADOW_LAYERS.iter().zip(passes.iter()) {
            assert_eq!(got_w, want_w);
            // Applied exactly once — a renderer multiplying by `alpha` again
            // would darken the halo quadratically as the ring fades.
            assert!((got_a - want_a * ring_alpha).abs() < 1e-12);
        }
    }

    #[test]
    fn ring_layers_discs_are_painted_outermost_first() {
        let (points, total) = sample_ring();
        let layers = RingLayers::new(&points, total * 0.3, total, 0.3, 0.0, 1.0).unwrap();
        for discs in [
            layers.head_discs().collect::<Vec<_>>(),
            layers.underlay_discs().collect::<Vec<_>>(),
        ] {
            assert_eq!(discs.len(), RING_HEAD_STEPS);
            // Widest and dimmest first, so each brighter disc lands on top.
            for pair in discs.windows(2) {
                assert!(pair[1].radius < pair[0].radius, "discs must shrink inward");
                assert!(pair[1].alpha > pair[0].alpha, "discs must brighten inward");
            }
            assert!((discs[0].radius - ring_head_radius(0.3)).abs() < 1e-12);
            for d in &discs {
                assert_eq!((d.cx, d.cy), (layers.head_x, layers.head_y));
                assert!((0.0..=1.0).contains(&d.alpha));
            }
        }
    }

    #[test]
    fn ring_layers_underlay_tracks_the_head_it_sits_under() {
        let (points, total) = sample_ring();
        let layers = RingLayers::new(&points, total * 0.3, total, 0.3, 0.0, 1.0).unwrap();
        let head: Vec<_> = layers.head_discs().collect();
        let under: Vec<_> = layers.underlay_discs().collect();
        assert_eq!(head.len(), under.len());
        for (h, u) in head.iter().zip(under.iter()) {
            // Same geometry, so the dark disc is never visible around the rim
            // of the silver one it is meant to back.
            assert_eq!(h.radius, u.radius);
            assert!(u.alpha < h.alpha, "underlay must stay dimmer than the head");
        }
    }

    #[test]
    fn ring_layers_drops_disc_stacks_once_the_head_dissolves() {
        let (points, total) = sample_ring();
        // At completion the head is gone; nothing bright (or dark) may be
        // left parked at the seam.
        let done = RingLayers::new(&points, total, total, 1.0, 0.0, 1.0).unwrap();
        assert_eq!(done.head_discs().count(), 0);
        assert_eq!(done.underlay_discs().count(), 0);
        // Same story once the ring has nearly faded out after release.
        let faint = RingLayers::new(&points, total * 0.3, total, 0.3, 0.0, 0.001).unwrap();
        assert_eq!(faint.head_discs().count(), 0);
        assert_eq!(faint.underlay_discs().count(), 0);
        // But the shadow arc still exists while any ring is visible.
        assert_eq!(faint.shadow_passes().count(), RING_SHADOW_LAYERS.len());
    }

    #[test]
    fn shadow_layers_fall_off_outward() {
        // Widths grow and alphas shrink monotonically, so the passes sum to a
        // halo that is strongest at the ring and fades outward.
        let mut prev_w = 0.0;
        let mut prev_a = f64::INFINITY;
        let mut total = 0.0;
        for &(w, a) in RING_SHADOW_LAYERS {
            assert!(w > prev_w, "layer widths must grow");
            assert!(a < prev_a, "layer alphas must shrink");
            assert!((0.0..=1.0).contains(&a), "layer alpha out of range: {a}");
            prev_w = w;
            prev_a = a;
            total += a;
        }
        // Combined alpha stays low so dark backdrops remain unaffected.
        assert!(total < 0.3, "combined shadow alpha too strong: {total}");
    }

    #[test]
    fn inflate_starts_midway_through_the_hold() {
        assert_eq!(inflate_target(0.0, true, false), 0.0);
        assert_eq!(inflate_target(INFLATE_PRE_AT, true, false), 0.0);
        let mid = inflate_target(0.8, true, false);
        assert!(
            mid > 0.0 && mid < 1.0,
            "expected partial pre-inflate, got {mid}"
        );
        // Arming completes it.
        assert_eq!(inflate_target(1.0, true, true), 1.0);
        // Not held: fully deflated.
        assert_eq!(inflate_target(0.9, false, false), 0.0);
    }

    #[test]
    fn pre_inflate_never_exceeds_its_cap() {
        let full = inflate_target(1.0, true, false);
        assert!((full - INFLATE_PRE_AMOUNT).abs() < 1e-9);
    }

    #[test]
    fn press_dip_decays_and_yields_to_inflate() {
        let at_press = press_dip(0.0, 0.0);
        assert!((at_press - PRESS_DIP).abs() < 1e-9);
        assert!(press_dip(0.2, 0.0) < at_press);
        // Once the pill inflates the dip is suppressed.
        assert_eq!(press_dip(0.0, 1.0), 0.0);
    }

    #[test]
    fn ring_alpha_rises_fast_and_exits_faster_than_it_enters() {
        // Reaches near-full within the rise window.
        let risen = ring_alpha(true, HOLD_DELAY + RING_ALPHA_RISE, 0.0, HOLD_DELAY);
        assert!(
            risen > 0.99,
            "alpha should be up by the rise window: {risen}"
        );
        // Release is an accelerating curve: the first half sheds less than the
        // second, i.e. it lingers then drops.
        let half = ring_alpha(false, 0.0, LONG_PRESS_RING_FADE * 0.5, HOLD_DELAY);
        assert!(
            (half - 0.75).abs() < 1e-9,
            "expected quadratic exit, got {half}"
        );
        assert_eq!(
            ring_alpha(false, 0.0, LONG_PRESS_RING_FADE, HOLD_DELAY),
            0.0
        );
    }

    #[test]
    fn ring_alpha_is_monotonic_while_fading() {
        let mut prev = 1.0;
        for i in 0..=40 {
            let t = LONG_PRESS_RING_FADE * i as f64 / 40.0;
            let a = ring_alpha(false, 0.0, t, HOLD_DELAY);
            assert!(a <= prev + 1e-9, "alpha rose during fade at t={t}");
            prev = a;
        }
        assert_eq!(prev, 0.0);
    }

    #[test]
    fn release_drift_is_bounded() {
        assert_eq!(ring_release_drift(0.0), 0.0);
        let full = ring_release_drift(LONG_PRESS_RING_FADE);
        assert!((full - RING_RELEASE_DRIFT).abs() < 1e-9);
        // Saturates rather than running away.
        assert!((ring_release_drift(10.0) - RING_RELEASE_DRIFT).abs() < 1e-9);
    }

    #[test]
    fn resample_produces_evenly_spaced_points() {
        let path =
            rounded_rectangle_perimeter(0.0, 0.0, 120.0, 32.0, 16.0, RoundedRectArcSteps::Auto);
        let (distances, total) = path_distances(&path);
        let mut out = Vec::new();
        resample_perimeter(&path, &distances, total, RING_SEGMENT_PX, &mut out);

        assert!(out.len() > 24);
        // First and last land on the seam.
        assert!(out[0].2.abs() < 1e-9);
        assert!((out.last().unwrap().2 - total).abs() < 1e-9);

        // Spacing is uniform to within a hair.
        let expected = total / (out.len() - 1) as f64;
        for w in out.windows(2) {
            let gap = w[1].2 - w[0].2;
            assert!((gap - expected).abs() < 1e-9, "uneven spacing: {gap}");
            // Points stay on the path, so the chord never exceeds the arc.
            let chord = ((w[1].0 - w[0].0).powi(2) + (w[1].1 - w[0].1).powi(2)).sqrt();
            assert!(chord <= gap + 1e-9);
        }
    }

    #[test]
    fn resample_reuses_the_caller_buffer() {
        let path =
            rounded_rectangle_perimeter(0.0, 0.0, 120.0, 32.0, 16.0, RoundedRectArcSteps::Auto);
        let (distances, total) = path_distances(&path);
        let mut out = Vec::new();
        resample_perimeter(&path, &distances, total, RING_SEGMENT_PX, &mut out);
        let first_len = out.len();
        let cap = out.capacity();
        resample_perimeter(&path, &distances, total, RING_SEGMENT_PX, &mut out);
        assert_eq!(out.len(), first_len, "buffer must be cleared, not appended");
        assert_eq!(out.capacity(), cap, "second pass must not reallocate");
    }

    #[test]
    fn resample_tolerates_degenerate_input() {
        let mut out = Vec::new();
        resample_perimeter(&[], &[], 0.0, RING_SEGMENT_PX, &mut out);
        assert!(out.is_empty());
        resample_perimeter(&[(0.0, 0.0)], &[0.0], 0.0, RING_SEGMENT_PX, &mut out);
        assert!(out.is_empty());
    }

    #[test]
    fn easings_are_well_behaved_at_their_endpoints() {
        for f in [
            smootherstep as fn(f64) -> f64,
            ease_out_cubic as fn(f64) -> f64,
            ease_out_expo as fn(f64) -> f64,
        ] {
            assert!(f(0.0).abs() < 1e-9);
            assert!((f(1.0) - 1.0).abs() < 1e-9);
            // Clamped outside the unit interval.
            assert!(f(-5.0).abs() < 1e-9);
            assert!((f(5.0) - 1.0).abs() < 1e-9);
        }
    }

    #[test]
    fn advance_ring_pins_alpha_while_held_and_fades_after() {
        let mut a = RingAnim {
            release_elapsed: LONG_PRESS_RING_FADE,
            ..Default::default()
        };
        let hd = 0.12;
        // Held: alpha rises to full.
        for _ in 0..20 {
            advance_ring(
                &mut a,
                RingTick {
                    held: true,
                    dragging: false,
                    progress: 0.5,
                    delta_seconds: 0.016,
                },
                hd,
            );
        }
        assert!(
            a.alpha > 0.99,
            "alpha should be pinned high while held: {}",
            a.alpha
        );
        assert!((a.release_progress - 0.5).abs() < 1e-9);

        // Released: fades to zero and stays there.
        for _ in 0..60 {
            advance_ring(
                &mut a,
                RingTick {
                    held: false,
                    dragging: false,
                    progress: 0.0,
                    delta_seconds: 0.016,
                },
                hd,
            );
        }
        assert_eq!(a.alpha, 0.0);
    }

    #[test]
    fn advance_ring_records_the_level_reached_at_release() {
        let mut a = RingAnim::default();
        let hd = 0.12;
        advance_ring(
            &mut a,
            RingTick {
                held: true,
                dragging: false,
                progress: 0.37,
                delta_seconds: 0.016,
            },
            hd,
        );
        advance_ring(
            &mut a,
            RingTick {
                held: false,
                dragging: false,
                progress: 0.0,
                delta_seconds: 0.016,
            },
            hd,
        );
        assert!(
            (a.release_progress - 0.37).abs() < 1e-9,
            "must fade from the level reached"
        );
    }

    #[test]
    fn dragging_pins_release_progress_to_a_full_ring() {
        let mut a = RingAnim::default();
        advance_ring(
            &mut a,
            RingTick {
                held: true,
                dragging: true,
                progress: 0.2,
                delta_seconds: 0.016,
            },
            0.12,
        );
        assert_eq!(a.release_progress, 1.0);
    }

    #[test]
    fn arm_ramps_in_while_dragging_and_out_after() {
        let mut a = RingAnim::default();
        let hd = 0.12;
        for _ in 0..(ARM_RAMP_IN / 0.016) as usize + 2 {
            advance_ring(
                &mut a,
                RingTick {
                    held: true,
                    dragging: true,
                    progress: 1.0,
                    delta_seconds: 0.016,
                },
                hd,
            );
        }
        assert_eq!(a.arm_t, 1.0);
        for _ in 0..(ARM_RAMP_OUT / 0.016) as usize + 2 {
            advance_ring(
                &mut a,
                RingTick {
                    held: false,
                    dragging: false,
                    progress: 0.0,
                    delta_seconds: 0.016,
                },
                hd,
            );
        }
        assert_eq!(a.arm_t, 0.0);
    }

    /// Regression: `RingAnim` uses non-zero sentinels, so a derived all-zeroes
    /// `Default` would mean "a pulse is running" and "the button was released
    /// this instant" — painting a phantom ring on the very first frame.
    #[test]
    fn default_starts_idle_and_faded_out() {
        let a = RingAnim::default();
        assert!(
            !pulse_is_running(a.arm_pulse),
            "a fresh anim must not be mid-pulse",
        );
        assert_eq!(a.arm_pulse, PULSE_IDLE);
        // Seeded past the end of the fade, so the ring starts invisible.
        assert_eq!(a.release_elapsed, LONG_PRESS_RING_FADE);
        assert_eq!(ring_alpha(false, 0.0, a.release_elapsed, 0.12), 0.0);
    }

    #[test]
    fn arm_pulse_runs_once_and_retires() {
        let mut a = RingAnim::default();
        assert!(!pulse_is_running(a.arm_pulse));

        a.arm_pulse = pulse_armed();
        assert!(pulse_is_running(a.arm_pulse));
        assert_eq!(pulse_progress(a.arm_pulse), 0.0);

        let mut ticks = 0;
        while pulse_is_running(a.arm_pulse) && ticks < 1000 {
            advance_ring(
                &mut a,
                RingTick {
                    held: true,
                    dragging: true,
                    progress: 1.0,
                    delta_seconds: 0.016,
                },
                0.12,
            );
            ticks += 1;
        }
        assert!(ticks < 1000, "pulse never retired");
        assert!(!pulse_is_running(a.arm_pulse));
        // A retired pulse reports a finished ramp, so renderers skip it.
        assert_eq!(pulse_progress(a.arm_pulse), 1.0);
    }

    #[test]
    fn advance_ring_tolerates_a_negative_delta() {
        let mut a = RingAnim::default();
        advance_ring(
            &mut a,
            RingTick {
                held: true,
                dragging: false,
                progress: 0.5,
                delta_seconds: -1.0,
            },
            0.12,
        );
        assert!(a.press_elapsed >= 0.0);
        assert!((0.0..=1.0).contains(&a.alpha));
    }

    #[test]
    fn eligible_action_emits_feedback() {
        assert!(can_emit_interaction_feedback(true, false));
    }

    #[test]
    fn loading_action_is_inert() {
        assert!(!can_emit_interaction_feedback(true, true));
    }

    #[test]
    fn unavailable_action_is_inert() {
        assert!(!can_emit_interaction_feedback(false, false));
        assert!(!can_emit_interaction_feedback(false, true));
    }

    #[test]
    fn style_tooltip_follows_hover_mid_take_so_the_chevrons_stay_clickable() {
        // A running take must not pin the tooltip open, but the pointer on
        // the pill still reveals it mid-take so a chevron click switches style.
        assert!(style_tooltip_visible(false, 3, false, true, 1.0));
        // The pin was the bug: recording with the pointer elsewhere keeps
        // the tooltip faded out.
        assert!(!style_tooltip_visible(false, 3, false, false, 1.0));
    }

    #[test]
    fn style_tooltip_stays_hidden_while_paused() {
        // Paused keeps the tooltip hidden even on hover, as it was before
        // the rule was shared.
        assert!(!style_tooltip_visible(false, 3, true, true, 1.0));
        assert!(!style_tooltip_visible(false, 3, true, false, 1.0));
    }

    #[test]
    fn style_tooltip_is_hover_revealed_when_idle_or_processing() {
        assert!(style_tooltip_visible(false, 3, false, true, 1.0));
        // Processing the finished take keeps the hover reveal.
        assert!(style_tooltip_visible(false, 3, false, true, 0.5));
        assert!(!style_tooltip_visible(false, 3, false, false, 1.0));
    }

    #[test]
    fn style_tooltip_stays_hidden_when_it_has_nothing_to_switch() {
        // One active style leaves nothing to cycle, and the assistant panel
        // owns the window; a collapsing pill must not float a tooltip either.
        assert!(!style_tooltip_visible(false, 1, false, true, 1.0));
        assert!(!style_tooltip_visible(true, 3, false, true, 1.0));
        assert!(!style_tooltip_visible(false, 3, false, true, 0.1));
    }

    #[test]
    fn style_tooltip_fades_when_a_take_starts_under_a_parked_pointer() {
        // The repro the pure rule could not decide on its own: the pointer
        // never leaves the pill, yet the tooltip must fade when the take
        // starts.
        let gate = StyleTooltipGate::default();
        assert_eq!(style_tooltip_target(&gate, false, 3, false, true, 1.0), 1.0);
        gate.set_take_running(true);
        assert_eq!(style_tooltip_target(&gate, false, 3, false, true, 1.0), 0.0);
    }

    #[test]
    fn style_tooltip_returns_after_the_pointer_leaves_and_re_enters() {
        // Mid-take hover re-entry reveals the tooltip again, keeping the
        // chevrons clickable while recording.
        let gate = StyleTooltipGate::default();
        gate.set_take_running(true);
        assert_eq!(style_tooltip_target(&gate, false, 3, false, true, 1.0), 0.0);
        // Pointer leaves the pill: the latch releases.
        assert!(!gate.is_suppressed(false));
        assert_eq!(style_tooltip_target(&gate, false, 3, false, true, 1.0), 1.0);
    }

    #[test]
    fn style_tooltip_latch_releases_when_the_take_ends() {
        // A pointer parked on the pill through the whole take gets the
        // tooltip back once the take ends (Idle or Loading).
        let gate = StyleTooltipGate::default();
        gate.set_take_running(true);
        assert_eq!(style_tooltip_target(&gate, false, 3, false, true, 1.0), 0.0);
        gate.set_take_running(false);
        assert_eq!(style_tooltip_target(&gate, false, 3, false, true, 1.0), 1.0);
        // Hover never dropped, so a later take must re-latch cleanly.
        gate.set_take_running(true);
        assert_eq!(style_tooltip_target(&gate, false, 3, false, true, 1.0), 0.0);
    }

    /// Regression: the latch must release even when the pure rule is false
    /// when the pointer leaves. Evaluating the gate only behind
    /// style_tooltip_visible() skipped is_suppressed() whenever the tooltip
    /// was ineligible for another reason (single style, assistant panel,
    /// collapsed pill), so the tooltip stayed hidden on the next hover entry
    /// in the same take.
    #[test]
    fn style_tooltip_latch_releases_while_the_rule_is_false_for_other_reasons() {
        let gate = StyleTooltipGate::default();
        gate.set_take_running(true);
        // Pointer leaves while only one style is active: the rule is false,
        // but the leave must still release the latch.
        assert_eq!(
            style_tooltip_target(&gate, false, 1, false, false, 1.0),
            0.0
        );
        // A second style becomes active and the pointer re-enters mid-take.
        assert_eq!(style_tooltip_target(&gate, false, 3, false, true, 1.0), 1.0);
    }

    #[test]
    fn clear_flash_state_resets_every_flash_field() {
        let visible = Cell::new(true);
        let timer = Cell::new(4.5);
        let action = RefCell::new(Some("undo".to_string()));
        let action_label = RefCell::new(Some("Undo".to_string()));
        let reject = RefCell::new(Some("dismiss".to_string()));
        let reject_label = RefCell::new(Some("Dismiss".to_string()));

        clear_flash_state(
            &visible,
            &timer,
            &action,
            &action_label,
            &reject,
            &reject_label,
        );

        assert!(!visible.get());
        assert_eq!(timer.get(), 0.0);
        assert!(action.borrow().is_none());
        assert!(action_label.borrow().is_none());
        assert!(reject.borrow().is_none());
        assert!(reject_label.borrow().is_none());
    }

    #[test]
    fn flash_banner_yields_the_strip_to_a_revealed_tooltip() {
        // The retranscribing banner has no action button: hovering the pill
        // must swap it for the style selector instead of sitting on top of it.
        assert_eq!(flash_banner_target(true, false, true), 0.0);
        // Pointer leaves before the banner expires: it returns.
        assert_eq!(flash_banner_target(true, false, false), 1.0);
    }

    #[test]
    fn flash_banner_with_an_action_keeps_the_strip() {
        // An interactive banner (cancel-dictation confirm) must not vanish
        // the moment the pill is hovered; the tooltip waits beneath it.
        assert_eq!(flash_banner_target(true, true, true), 1.0);
        assert_eq!(flash_banner_target(true, true, false), 1.0);
    }

    /// A toast can offer a reject button with no accept button. The draw code
    /// paints and registers the reject button from the reject label alone, so
    /// hit testing has to accept that toast as interactive too. macOS gated
    /// the hit test on `flash_action` alone, so the drawn reject button sat
    /// there and could not be clicked.
    #[test]
    fn a_reject_only_toast_is_clickable() {
        assert!(
            flash_banner_is_clickable(false, true, 1.0),
            "a toast with only a reject button draws that button, so it must be hit-testable"
        );
    }

    #[test]
    fn an_accept_only_toast_is_clickable() {
        assert!(flash_banner_is_clickable(true, false, 1.0));
        assert!(flash_banner_is_clickable(true, true, 1.0));
    }

    #[test]
    fn a_toast_with_no_buttons_is_not_clickable() {
        // An informational banner (retranscribing) draws no buttons, so it must
        // not claim input: the click would fall through to the pill behind it.
        assert!(!flash_banner_is_clickable(false, false, 1.0));
    }

    #[test]
    fn a_toast_is_only_clickable_once_it_has_mostly_faded_in() {
        // Both platforms hold the buttons inert until the banner is mostly
        // drawn, so a click during the scale-in does not fire an action for a
        // button the user has not seen yet.
        assert!(!flash_banner_is_clickable(true, true, 0.49));
        assert!(flash_banner_is_clickable(true, true, 0.5));
        assert!(flash_banner_is_clickable(false, true, 0.5));
    }

    #[test]
    fn flash_banner_stays_hidden_when_not_visible() {
        assert_eq!(flash_banner_target(false, false, false), 0.0);
        assert_eq!(flash_banner_target(false, true, true), 0.0);
    }

    #[test]
    fn hidden_pill_stays_hidden_while_recording() {
        assert!(!should_show_pill(PillVisibility::Hidden, true, false));
        assert!(!should_show_pill(PillVisibility::Hidden, false, false));
    }

    #[test]
    fn hidden_pill_still_shows_when_it_owns_the_surface() {
        assert!(should_show_pill(PillVisibility::Hidden, false, true));
        assert!(should_show_pill(PillVisibility::Hidden, true, true));
    }

    #[test]
    fn while_active_shows_only_when_busy() {
        assert!(!should_show_pill(PillVisibility::WhileActive, false, false));
        assert!(should_show_pill(PillVisibility::WhileActive, true, false));
        assert!(should_show_pill(PillVisibility::WhileActive, false, true));
    }

    #[test]
    fn persistent_always_shows() {
        assert!(should_show_pill(PillVisibility::Persistent, false, false));
        assert!(should_show_pill(PillVisibility::Persistent, true, false));
    }

    #[test]
    fn style_tooltip_stays_hidden_while_paused_even_after_re_entry() {
        // Paused hides the tooltip regardless of the latch, and a resume
        // re-latches so the tooltip does not pop in under a parked pointer.
        let gate = StyleTooltipGate::default();
        gate.set_take_running(true);
        gate.is_suppressed(false);
        assert_eq!(style_tooltip_target(&gate, false, 3, true, true, 1.0), 0.0);
        gate.set_take_running(true);
        assert_eq!(style_tooltip_target(&gate, false, 3, false, true, 1.0), 0.0);
    }

    #[test]
    fn a_button_fully_inside_the_band_is_untouched() {
        assert_eq!(
            clip_span_to_band(120.0, 44.0, 100.0, 200.0),
            Some((120.0, 44.0))
        );
    }

    #[test]
    fn a_button_sliding_off_the_top_keeps_only_the_visible_strip() {
        // 20 of the 44 points scrolled above the panel, so only the lower 24
        // may take a click.
        assert_eq!(
            clip_span_to_band(80.0, 44.0, 100.0, 200.0),
            Some((100.0, 24.0))
        );
    }

    #[test]
    fn a_button_sliding_off_the_bottom_keeps_only_the_visible_strip() {
        assert_eq!(
            clip_span_to_band(280.0, 44.0, 100.0, 200.0),
            Some((280.0, 20.0))
        );
    }

    #[test]
    fn a_button_with_its_centre_inside_still_loses_its_hidden_half() {
        // This is the case the centre test got wrong: the top half is off the
        // panel, painted over by the chrome, and must not be clickable.
        let (top, height) =
            clip_span_to_band(90.0, 44.0, 100.0, 200.0).expect("the lower half is still on screen");
        assert_eq!(top, 100.0);
        assert_eq!(height, 34.0);
    }

    #[test]
    fn a_button_with_its_centre_outside_keeps_the_sliver_that_shows() {
        // The mirror case: the centre test dropped this one even though a
        // visible sliver is still on the panel.
        assert_eq!(
            clip_span_to_band(70.0, 44.0, 100.0, 200.0),
            Some((100.0, 14.0))
        );
    }

    #[test]
    fn a_button_scrolled_clear_of_the_band_is_dropped() {
        assert_eq!(clip_span_to_band(20.0, 44.0, 100.0, 200.0), None);
        assert_eq!(clip_span_to_band(400.0, 44.0, 100.0, 200.0), None);
    }

    #[test]
    fn an_unscaled_transform_leaves_the_rectangle_where_it_was() {
        assert_eq!(
            scaled_click_rect(300.0, 40.0, 60.0, 22.0, 200.0, 51.0, 1.0),
            (300.0, 40.0, 60.0, 22.0)
        );
    }

    #[test]
    fn a_scaled_button_is_registered_where_it_is_painted() {
        // The toast banner is drawn from half size up, about its centre, so the
        // button on the banner's right edge is painted 50 points further left
        // and half as wide while the banner is half size. A rectangle left at 300
        // covers the empty space to the right of the button the user can see.
        let (x, y, w, h) = scaled_click_rect(300.0, 40.0, 60.0, 22.0, 200.0, 51.0, 0.5);
        assert_eq!((x, y, w, h), (250.0, 45.5, 30.0, 11.0));
    }

    #[test]
    fn scaling_a_button_gives_the_rectangle_the_transform_paints() {
        // The property the call sites rely on: the rectangle this returns, put
        // back through the same transform, is the rectangle the draw code laid
        // out. A rectangle left unscaled does not survive that round trip at any
        // step of the animation, which is the whole defect.
        let (x, y, w, h) = (300.0, 40.0, 60.0, 22.0);
        let (cx, cy) = (200.0, 51.0);
        for step in 0..=10 {
            let scale = 0.5 + 0.5 * f64::from(step) / 10.0;
            let (rx, ry, rw, rh) = scaled_click_rect(x, y, w, h, cx, cy, scale);
            for (corner_x, corner_y) in [(rx, ry), (rx + rw, ry + rh)] {
                let painted_x = cx + (corner_x - cx) / scale;
                let painted_y = cy + (corner_y - cy) / scale;
                let expected_x = if corner_x == rx { x } else { x + w };
                let expected_y = if corner_y == ry { y } else { y + h };
                assert!(
                    (painted_x - expected_x).abs() < 1e-9 && (painted_y - expected_y).abs() < 1e-9,
                    "at scale {scale} the painted corner came back at ({painted_x}, {painted_y}) \
                     instead of ({expected_x}, {expected_y})"
                );
            }
        }
    }

    #[test]
    fn a_button_touching_a_band_edge_is_dropped() {
        // Zero visible height is nothing to click.
        assert_eq!(clip_span_to_band(56.0, 44.0, 100.0, 200.0), None);
        assert_eq!(clip_span_to_band(300.0, 44.0, 100.0, 200.0), None);
    }

    #[test]
    fn review_preview_bounding_preserves_short_text() {
        let text = "This is a brief transcribed sentence.";
        let (preview, truncated) = bound_review_preview_text(text);
        assert!(!truncated);
        assert_eq!(preview, text);
    }

    #[test]
    fn review_preview_bounding_truncates_huge_transcripts_cleanly() {
        let word = "transcription ";
        let huge_text = word.repeat(10_000); // ~140,000 characters
        let (preview, truncated) = bound_review_preview_text(&huge_text);

        assert!(truncated);
        // In characters: the budget is a character budget, and a byte assertion
        // would pass for a preview that kept a fraction of it.
        assert!(preview.chars().count() <= MAX_REVIEW_PREVIEW_CHARS + 60);
        assert!(preview.contains("Full transcript preserved"));
        // The range the function read is the budget's, not the transcript's:
        // an offset proportional to the input is what made every rendered frame
        // cost time proportional to the whole transcript.
        let end =
            review_preview_scan_end(&huge_text).expect("a transcript of this size is over budget");
        assert!(
            end < MAX_REVIEW_PREVIEW_CHARS * 8,
            "the scan read {end} bytes of a {} byte transcript",
            huge_text.len()
        );
    }

    #[test]
    fn review_preview_bounding_respects_utf8_multibyte_boundaries() {
        let emoji_text = "🎙️✨⚡🦀".repeat(1000);
        let (preview, truncated) = bound_review_preview_text(&emoji_text);
        assert!(truncated);
        assert!(preview.chars().count() <= MAX_REVIEW_PREVIEW_CHARS + 60);
    }

    #[test]
    fn review_preview_bounding_spends_the_budget_in_characters_not_bytes() {
        // The budget is documented in characters, so a multibyte transcript has
        // to get all of it. Measuring `str::len` spent 3000 *bytes* instead,
        // which for this text is about 700 characters: a CJK or emoji transcript
        // lost two thirds of the preview it was allowed.
        let text = "🎙️✨⚡🦀".repeat(1000); // 4_000 characters, ~17_000 bytes
        assert!(
            text.len() > MAX_REVIEW_PREVIEW_CHARS * 4,
            "the fixture must be over budget in both units to be meaningful"
        );
        let (preview, truncated) = bound_review_preview_text(&text);
        assert!(truncated);

        let shown = preview
            .strip_suffix("\n… [Full transcript preserved for insert]")
            .expect("the truncation notice is appended to a bounded preview");
        assert!(
            shown.chars().count() >= MAX_REVIEW_PREVIEW_CHARS - 4,
            "preview kept {} characters of a {MAX_REVIEW_PREVIEW_CHARS} character budget",
            shown.chars().count()
        );
    }

    #[test]
    fn review_preview_bounding_leaves_multibyte_text_at_the_budget_intact() {
        // A transcript exactly on the budget must not be truncated at all, which
        // a byte comparison got wrong in the other direction: 3000 CJK
        // characters are 9000 bytes, so the byte check truncated text that
        // fitted the documented limit.
        let text = "あ".repeat(MAX_REVIEW_PREVIEW_CHARS);
        assert!(text.len() > MAX_REVIEW_PREVIEW_CHARS);
        let (preview, truncated) = bound_review_preview_text(&text);
        assert!(
            !truncated,
            "text exactly on the character budget was truncated"
        );
        assert_eq!(preview, text);
    }

    #[test]
    fn review_preview_bounding_keeps_the_budget_when_whitespace_is_sparse() {
        // The trim back to a word boundary searched the whole 3000-character
        // window for the last whitespace, so a transcript that mentions a word
        // once near the top and then runs on kept 2 characters of a
        // 3000-character budget. Long unbroken runs — a URL, a hash, a CJK
        // sentence — are exactly where the budget exists to bound layout, so
        // the trim may only give back a character or two, never the window.
        let text = format!("{} {}", "Hi", "あ".repeat(MAX_REVIEW_PREVIEW_CHARS * 2));
        let (preview, truncated) = bound_review_preview_text(&text);
        assert!(truncated);
        let shown = preview
            .strip_suffix("\n… [Full transcript preserved for insert]")
            .expect("the truncation notice is appended to a bounded preview");
        // The floor, not the trim window, is the point: 64 characters back is
        // the worst a bounded trim can give up. Asserting it against
        // `MAX_REVIEW_PREVIEW_CHARS - REVIEW_PREVIEW_TRIM_WINDOW` made the
        // comparison hold for any budget — shrink the budget to 600 and the
        // fixture still kept 600 characters against a floor of 536. The
        // numbers are written out so moving either constant has to move this
        // test deliberately.
        assert!(
            shown.chars().count() >= 3000 - 64,
            "preview kept {} characters of a 3000 character budget",
            shown.chars().count()
        );
        // This fixture has no whitespace anywhere near the cut, so the trim
        // cannot fire at all and the preview keeps the budget to the character.
        // That is the strongest form of the claim and it pins the budget's
        // size, not just the trim's reach.
        assert_eq!(
            shown.chars().count(),
            3000,
            "a transcript with no whitespace near the cut must keep the whole budget"
        );
    }

    #[test]
    fn review_preview_budget_is_3000_characters() {
        // `MAX_REVIEW_PREVIEW_CHARS` is public and every test that mentions it
        // compares against it, so a change to its value silently changed the
        // meaning of all of them: 3000 -> 600 left every assertion passing while
        // the preview quietly shrank to a fifth of its budget. The budget is a
        // documented promise about layout cost, so it is pinned against the
        // literal 3000 here, and separately from the trim window.
        let at_budget = "a".repeat(3000);
        let (whole, truncated) = bound_review_preview_text(&at_budget);
        assert!(
            !truncated,
            "3000 characters fit the budget, so nothing should be trimmed"
        );
        assert_eq!(whole.chars().count(), 3000);

        // One character over: the preview is trimmed, and what survives the
        // trim is exactly the budget.
        let over = "a".repeat(3001);
        let (preview, truncated) = bound_review_preview_text(&over);
        assert!(truncated);
        let shown = preview
            .strip_suffix("\n… [Full transcript preserved for insert]")
            .expect("the truncation notice is appended to a bounded preview");
        assert_eq!(shown.chars().count(), 3000);

        // The budget is in characters, not bytes: 3000 CJK characters are 9000
        // bytes and must still fit whole.
        let cjk = "あ".repeat(3000);
        assert!(cjk.len() > 3000);
        let (preview, truncated) = bound_review_preview_text(&cjk);
        assert!(
            !truncated,
            "3000 characters are 9000 bytes but still on budget"
        );
        assert_eq!(preview.chars().count(), 3000);
    }

    #[test]
    fn review_preview_bounding_reads_the_same_range_at_every_length() {
        // The preview is bounded on the render path, once per drawn frame, so
        // `chars().count()` walking the entire transcript made every frame linear
        // in the full text size.
        //
        // What is asserted here is the range the function reads, not how long it
        // takes: a stopwatch around a sub-microsecond call is a test that fails
        // on a contended runner and under a sanitizer, and the range is the thing
        // that actually bounds the work. It is a property of the budget and not
        // of the input's length, so the same two fixtures must produce the same
        // offset and the same preview whether one is barely over budget and the
        // other is ten million characters.
        let barely_over = "word ".repeat(MAX_REVIEW_PREVIEW_CHARS / 5 + 2);
        let huge = "word ".repeat(2_000_000); // 10M characters
        assert!(
            barely_over.chars().count() > MAX_REVIEW_PREVIEW_CHARS,
            "the baseline must itself be over budget or it would return early"
        );

        let small_end = review_preview_scan_end(&barely_over);
        let huge_end = review_preview_scan_end(&huge);
        assert!(
            small_end.is_some() && huge_end.is_some(),
            "both fixtures must be over the budget"
        );
        assert_eq!(
            small_end, huge_end,
            "the scan stopped at a different offset for a longer transcript, so its \
             cost still scales with the input"
        );

        let (small_preview, small_truncated) = bound_review_preview_text(&barely_over);
        let (huge_preview, huge_truncated) = bound_review_preview_text(&huge);
        assert!(small_truncated && huge_truncated);
        assert_eq!(
            small_preview.chars().count(),
            huge_preview.chars().count(),
            "a ten-million character transcript produced a different preview length than a \
             barely-over-budget one"
        );
    }

    // ── Idle/drag label crossfade ──────────────────────────────────────
    //
    // `label_crossfade_alpha` and `label_slide_y` are called by all three pill
    // renderers on every drawn frame and had no test at all: three mutations to
    // `label_crossfade_alpha` — dropping `(1.0 - drag_t)` from the idle arm,
    // swapping the two arms, and dropping `expand_t` from the idle arm — left
    // the suite green. The last is a visible regression by itself, so these
    // tests pin the contract rather than the arithmetic.

    /// The cutoff is the width of the crossfade, so its value is the thing the
    /// handoff depends on. Pinned as a number: 0.01 left both labels drawn for
    /// 96% of the transition, and 0.275 (exactly half the peak) would blink a
    /// blank frame at `drag_t == 0.5` because the renderers gate on `>`.
    #[test]
    fn label_alpha_cutoff_sits_just_under_half_the_peak() {
        assert!(
            (LABEL_ALPHA_CUTOFF - 0.2475).abs() < 1e-12,
            "LABEL_ALPHA_CUTOFF is {LABEL_ALPHA_CUTOFF}"
        );
        let half_peak = LABEL_BASE_ALPHA * 0.5;
        assert!(
            LABEL_ALPHA_CUTOFF < half_peak,
            "at or above half the peak, both arms fall under the cutoff together at \
             drag_t == 0.5 and the pill draws no label for a frame"
        );
    }

    #[test]
    fn label_crossfade_hands_over_around_the_midpoint_without_a_blank_frame() {
        // Both alphas above the cutoff at once is the smudge the cutoff exists
        // to prevent; neither above it is a blank frame. At 45% of peak the
        // overlap is one frame wide and it straddles the midpoint.
        let mut overlap_frames = Vec::new();
        let mut blank_frames = Vec::new();
        let mut both_drawn = 0;
        let mut neither_drawn = 0;
        for step in 0..=1000 {
            let drag_t = step as f64 / 1000.0;
            let (idle, drag) = label_crossfade_alpha(drag_t, 1.0);
            let idle_drawn = idle > LABEL_ALPHA_CUTOFF;
            let drag_drawn = drag > LABEL_ALPHA_CUTOFF;
            match (idle_drawn, drag_drawn) {
                (true, true) => both_drawn += 1,
                (false, false) => neither_drawn += 1,
                _ => {}
            }
            if idle_drawn && drag_drawn {
                overlap_frames.push(drag_t);
            }
            if !idle_drawn && !drag_drawn {
                blank_frames.push(drag_t);
            }
        }

        assert!(
            blank_frames.is_empty(),
            "no label is drawn for drag_t in {blank_frames:?}: the pill blinks"
        );
        // The window is open at both ends and the grid has 1001 samples, so
        // (0.45, 0.55) holds 99 of them.
        assert_eq!(
            overlap_frames.len(),
            99,
            "both labels are drawn across {both_drawn}/1000 of the transition"
        );
        // The first and last overlapping samples bracket the window, which is
        // open: the edges fall at 0.45 and 0.55 in `drag_t`.
        let (lo, hi) = (overlap_frames[0], overlap_frames[overlap_frames.len() - 1]);
        assert!(
            (0.4505..0.452).contains(&lo) && (0.548..0.5495).contains(&hi),
            "the overlap window runs from {lo} to {hi}, not from 0.45 to 0.55"
        );
        // The edges are the cutoff as a fraction of the peak, which is what
        // makes this a property of the constant rather than a magic number.
        let fraction = LABEL_ALPHA_CUTOFF / LABEL_BASE_ALPHA;
        assert!(
            (fraction - 0.45).abs() < 1e-12,
            "the cutoff is {fraction} of the peak, so the window edges are not 0.45 and 0.55"
        );

        // Over 96% of the transition the two labels were both above a 0.01
        // cutoff. One tenth is the replacement, and the window must stay
        // centred so the handoff does not drift toward either label.
        assert_eq!(neither_drawn, 0);
    }

    #[test]
    fn label_crossfade_endpoints_pick_exactly_one_label() {
        // Fully idle: the idle label at full peak, the drag label not drawn.
        let (idle, drag) = label_crossfade_alpha(0.0, 1.0);
        assert!(
            (idle - LABEL_BASE_ALPHA).abs() < 1e-12,
            "the idle label must reach full peak when idle, got {idle}"
        );
        assert!(
            drag <= LABEL_ALPHA_CUTOFF,
            "the drag label must not be drawn while idle, got {drag}"
        );

        // Fully dragging: the mirror image. This is the assertion a swapped
        // pair of arms fails first.
        let (idle, drag) = label_crossfade_alpha(1.0, 1.0);
        assert!(
            idle <= LABEL_ALPHA_CUTOFF,
            "the idle label must not be drawn while dragging, got {idle}"
        );
        assert!(
            (drag - LABEL_BASE_ALPHA).abs() < 1e-12,
            "the drag label must reach full peak while dragging, got {drag}"
        );
    }

    #[test]
    fn a_collapsed_pill_draws_no_label_at_any_drag_progress() {
        // `expand_t == 0` is a collapsed pill. Every renderer skips the label
        // painter below `expand_t > 0.5`, so the multiplier is the last line of
        // defence — and losing it painted "Click to dictate" on a pill with
        // nowhere to put it.
        for step in 0..=100 {
            let drag_t = step as f64 / 100.0;
            let (idle, drag) = label_crossfade_alpha(drag_t, 0.0);
            assert!(
                idle <= LABEL_ALPHA_CUTOFF,
                "drag_t {drag_t}: a collapsed pill drew the idle label at {idle}"
            );
            assert!(
                drag <= LABEL_ALPHA_CUTOFF,
                "drag_t {drag_t}: a collapsed pill drew the drag label at {drag}"
            );
        }
    }

    #[test]
    fn label_crossfade_alpha_scales_with_expansion_and_clamps_its_inputs() {
        // Half-expanded is half as opaque, which is what keeps the label from
        // arriving at full strength on a pill that is still growing.
        for step in 0..=100 {
            let drag_t = step as f64 / 100.0;
            for expand_t in [0.25, 0.5, 0.75, 1.0] {
                let (idle, drag) = label_crossfade_alpha(drag_t, expand_t);
                let peak = LABEL_BASE_ALPHA * expand_t;
                assert!(
                    (idle + drag - peak).abs() < 1e-12,
                    "alphas must sum to {peak}"
                );
                assert!(
                    idle <= peak + 1e-12 && drag <= peak + 1e-12,
                    "neither arm may exceed the peak for expand_t {expand_t}"
                );
            }
        }

        // Out-of-range progress is clamped, not propagated: a spring that
        // overshoots past 1.0 must not paint a label brighter than peak, and a
        // value below 0 must not paint a negative alpha, which every backend
        // treats as opaque.
        for (raw, clamped) in [(-5.0, 0.0), (-0.001, 0.0), (1.001, 1.0), (7.0, 1.0)] {
            assert_eq!(
                label_crossfade_alpha(raw, 1.0),
                label_crossfade_alpha(clamped, 1.0),
                "drag_t {raw} was not clamped to {clamped}"
            );
        }
        for (raw, clamped) in [(-1.0, 0.0), (2.0, 1.0)] {
            assert_eq!(
                label_crossfade_alpha(0.5, raw),
                label_crossfade_alpha(0.5, clamped),
                "expand_t {raw} was not clamped to {clamped}"
            );
        }
        let (idle, drag) = label_crossfade_alpha(-3.0, -3.0);
        assert!((idle).abs() < 1e-12 && (drag).abs() < 1e-12);
    }

    #[test]
    fn label_slide_y_ends_where_the_labels_belong_and_never_parts_them_further() {
        // At rest the idle label sits on the base line and the drag label is
        // parked one offset below it, ready to slide up into place. Fully
        // dragging, they have swapped: the idle label is one offset above the
        // base and the drag label is on it.
        let (idle_y, drag_y) = label_slide_y(100.0, 0.0);
        assert!(
            (idle_y - 100.0).abs() < 1e-12,
            "idle label rest y is {idle_y}"
        );
        assert!(
            (drag_y - 102.0).abs() < 1e-12,
            "the drag label parks one offset below base, got {drag_y}"
        );

        let (idle_y, drag_y) = label_slide_y(100.0, 1.0);
        assert!(
            (idle_y - 98.0).abs() < 1e-12,
            "the idle label ends one offset above base, got {idle_y}"
        );
        assert!(
            (drag_y - 100.0).abs() < 1e-12,
            "drag label rest y is {drag_y}"
        );

        // The slide is what would separate two overlapping labels, and it is
        // fixed at `LABEL_SLIDE_OFFSET` for the whole transition — 2px on 12px
        // glyphs. That is why the cutoff, not the offset, carries the handoff:
        // pinned here so a larger offset cannot arrive unnoticed.
        for step in 0..=100 {
            let drag_t = step as f64 / 100.0;
            let (idle_y, drag_y) = label_slide_y(100.0, drag_t);
            assert!(
                (drag_y - idle_y - LABEL_SLIDE_OFFSET).abs() < 1e-12,
                "at drag_t {drag_t} the labels are parted by {}px, not {LABEL_SLIDE_OFFSET}px",
                drag_y - idle_y
            );
        }

        // base_y is a baseline the renderers computed from font extents, so it
        // has to pass through untouched at the midpoint rather than be pulled
        // toward either label.
        for drag_t in [0.0, 0.5, 1.0] {
            let (idle_y, drag_y) = label_slide_y(-17.5, drag_t);
            assert!(
                idle_y < -17.5 + 1e-12 && drag_y > -17.5 - 1e-12,
                "a negative baseline must still bracket base_y, got {idle_y} and {drag_y}"
            );
        }

        for (raw, clamped) in [(-5.0, 0.0), (1.001, 1.0), (7.0, 1.0)] {
            assert_eq!(
                label_slide_y(100.0, raw),
                label_slide_y(100.0, clamped),
                "drag_t {raw} was not clamped to {clamped}"
            );
        }
    }

    #[test]
    fn label_crossfade_alphas_and_slide_agree_about_when_each_label_is_visible() {
        // The two functions are called back to back by all three renderers with
        // the same `drag_t`, and the renderers gate drawing on the alphas. So
        // the visible range of each label is the same window, and it has to be
        // the one the cutoff intends: nothing drawn, then one label, then both
        // for about a frame, then the other label, then nothing.
        let visible = |drag_t: f64| -> (bool, bool) {
            let (idle, drag) = label_crossfade_alpha(drag_t, 1.0);
            (idle > LABEL_ALPHA_CUTOFF, drag > LABEL_ALPHA_CUTOFF)
        };

        assert_eq!(visible(0.0), (true, false));
        assert_eq!(visible(0.4), (true, false));
        assert_eq!(visible(0.5), (true, true), "the midpoint must not blink");
        assert_eq!(visible(0.6), (false, true));
        assert_eq!(visible(1.0), (false, true));

        // The slide never lifts a suppressed label back over the bar, so the
        // alpha gate and the geometry gate cannot disagree about which strings
        // are on screen at the same time.
        for step in 0..=200 {
            let drag_t = step as f64 / 200.0;
            let (idle_drawn, drag_drawn) = visible(drag_t);
            let (idle_y, drag_y) = label_slide_y(100.0, drag_t);
            assert!(
                idle_y.is_finite() && drag_y.is_finite(),
                "drag_t {drag_t} produced a non-finite baseline"
            );
            if idle_drawn && drag_drawn {
                // Both drawn: they are 2px apart, which is the overlap the
                // cutoff keeps to a single frame.
                assert!((drag_y - idle_y - LABEL_SLIDE_OFFSET).abs() < 1e-12);
            }
        }
    }
}
