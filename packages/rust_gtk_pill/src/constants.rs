//! GTK pill layout. Values the three pills agree on live in
//! `rust_pill_shared::layout`; this file keeps the GTK-only overrides.

pub(crate) use rust_pill_shared::layout::*;
pub(crate) use rust_pill_shared::transcript_viewport::*;
pub(crate) use rust_pill_shared::{DRAG_INFLATE_SCALE, DRAG_INFLATE_STIFFNESS};

// GTK paints a shorter, tighter tooltip than the two native pills.
pub(crate) const TOOLTIP_HEIGHT: f64 = 24.0;
pub(crate) const TOOLTIP_RADIUS: f64 = 8.0;
/// Distance the tooltip slides upward as it fades in.
pub(crate) const TOOLTIP_ENTRY_SLIDE: f64 = 4.0;
/// Animation progress at which the tooltip counts as on screen.
///
/// Drawing, hit testing and the Wayland input region all use this one value.
/// They previously disagreed (draw at 0.01, input at 0.1), so for that sliver
/// of the fade-in the tooltip was painted but could not be clicked.
pub(crate) const TOOLTIP_VISIBLE_T: f64 = 0.01;

pub(crate) const SPRING_DT: f64 = 0.016;
pub(crate) const CANCEL_FLASH_DURATION: f64 = 0.4;

/// Character budget for the review editor. Bounds an accidental giant paste
/// before it reaches the buffer, since every later change copies the whole
/// buffer into `entry_text`.
pub(crate) const MAX_REVIEW_EDITOR_CHARS: usize = 100_000;
