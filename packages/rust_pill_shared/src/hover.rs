//! Hover-intent controller shared by the three pill renderers.
//!
//! A cursor merely crossing the pill is not intent: expansion, tooltips, and
//! the hover IPC fire only after the pointer dwells on the pill briefly at
//! low speed, and they linger through a short grace once it leaves, so fast
//! pass-throughs and edge dither never flicker the pill.
//!
//! While the button is held the pill stays hovered no matter what the hit
//! test says. A press can only begin on the pill body, so the pill is by
//! definition still under the pointer; and a drag routinely outruns the
//! window, so trusting the hit test would collapse the pill mid-gesture.
//! `pointer_down` — not `dragging` — is the correct gate: moving past the
//! cancel threshold before the hold completes clears the gesture flags while
//! the button is still down, so keying off those flags would drop the pin in
//! exactly the "drag across without releasing" case this prevents.
//!
//! Platforms feed one frame per sample: the raw hit test, the pointer
//! position, the time in seconds on a monotonic clock, and whether the button
//! is held. The controller answers with the hovered flag plus entered/exited
//! edges; the edges are the only thing that may send the hover IPC, so every
//! platform reports each transition exactly once.

/// Dwell time on the pill that arms hover, in seconds. The pointer must sit
/// on the pill at low speed for this long before expansion and tooltips fire.
const ARM_DWELL: f64 = 0.09;
/// Grace after the pointer leaves before hover exits, in seconds. Re-entering
/// inside the grace cancels the exit without any edge firing.
const EXIT_GRACE: f64 = 0.10;
/// Pointer speeds above this restart the dwell timer, in px/s. Crossing a
/// ~200 px pill faster than a quarter second never arms hover.
const MAX_ARM_SPEED: f64 = 800.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Idle,
    Arming,
    Hovered,
    Cooling,
}

/// One hover sample to [`HoverIntent::advance`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HoverFrame {
    /// Raw hit test of the pointer against the pill (and its tooltip/panel).
    pub probed: bool,
    /// Pointer position in the platform's sample space.
    pub pointer_x: f64,
    pub pointer_y: f64,
    /// Sample time in seconds on the platform's monotonic clock.
    pub now: f64,
    /// True while the button is held. Pins hover regardless of the hit test.
    pub pointer_down: bool,
}

/// One hover sample out of [`HoverIntent::advance`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HoverOutput {
    pub hovered: bool,
    /// True on the single frame hover turns on. Send the hover IPC on it.
    pub entered: bool,
    /// True on the single frame hover turns off. Send the hover IPC on it.
    pub exited: bool,
}

/// Shared hover-intent state machine. See the module docs for the feeding
/// contract.
#[derive(Debug, Clone)]
pub struct HoverIntent {
    phase: Phase,
    hovered: bool,
    last_x: f64,
    last_y: f64,
    last_t: f64,
    seeded: bool,
    state_t: f64,
}

impl Default for HoverIntent {
    fn default() -> Self {
        Self::new()
    }
}

impl HoverIntent {
    pub fn new() -> Self {
        Self {
            phase: Phase::Idle,
            hovered: false,
            last_x: 0.0,
            last_y: 0.0,
            last_t: 0.0,
            seeded: false,
            state_t: 0.0,
        }
    }

    pub fn hovered(&self) -> bool {
        self.hovered
    }

    /// Force back to unhovered, for decisive exits the grace must not delay
    /// (leaving the tracking area). Returns the previous hovered flag so the
    /// caller can send the exit edge exactly when one is owed.
    pub fn reset(&mut self) -> bool {
        let was = self.hovered;
        self.phase = Phase::Idle;
        self.hovered = false;
        was
    }

    /// Feed one sample and return the hover state for it. Non-finite
    /// coordinates reuse the last sample; a clock that jumps backwards
    /// counts as no time passing, never a rewind.
    pub fn advance(&mut self, frame: &HoverFrame) -> HoverOutput {
        let now = if frame.now.is_finite() {
            frame.now.max(self.last_t)
        } else {
            self.last_t
        };
        let px = if frame.pointer_x.is_finite() {
            frame.pointer_x
        } else {
            self.last_x
        };
        let py = if frame.pointer_y.is_finite() {
            frame.pointer_y
        } else {
            self.last_y
        };
        let dt = now - self.last_t;
        let speed = if self.seeded && dt > 0.0 {
            ((px - self.last_x).powi(2) + (py - self.last_y).powi(2)).sqrt() / dt
        } else {
            0.0
        };
        self.last_x = px;
        self.last_y = py;
        self.last_t = now;
        self.seeded = true;

        if frame.pointer_down {
            self.phase = Phase::Hovered;
            if !self.hovered {
                self.hovered = true;
                return HoverOutput {
                    hovered: true,
                    entered: true,
                    exited: false,
                };
            }
            return HoverOutput {
                hovered: true,
                entered: false,
                exited: false,
            };
        }

        match self.phase {
            Phase::Idle => {
                if frame.probed {
                    self.phase = Phase::Arming;
                    self.state_t = now;
                }
                HoverOutput {
                    hovered: false,
                    entered: false,
                    exited: false,
                }
            }
            Phase::Arming => {
                if !frame.probed {
                    self.phase = Phase::Idle;
                } else if speed > MAX_ARM_SPEED {
                    // Still crossing, not dwelling: restart the dwell timer.
                    self.state_t = now;
                } else if now - self.state_t >= ARM_DWELL {
                    self.phase = Phase::Hovered;
                    self.hovered = true;
                    return HoverOutput {
                        hovered: true,
                        entered: true,
                        exited: false,
                    };
                }
                HoverOutput {
                    hovered: false,
                    entered: false,
                    exited: false,
                }
            }
            Phase::Hovered => {
                if !frame.probed {
                    self.phase = Phase::Cooling;
                    self.state_t = now;
                }
                HoverOutput {
                    hovered: true,
                    entered: false,
                    exited: false,
                }
            }
            Phase::Cooling => {
                if frame.probed {
                    self.phase = Phase::Hovered;
                } else if now - self.state_t >= EXIT_GRACE {
                    self.phase = Phase::Idle;
                    self.hovered = false;
                    return HoverOutput {
                        hovered: false,
                        entered: false,
                        exited: true,
                    };
                }
                HoverOutput {
                    hovered: self.hovered,
                    entered: false,
                    exited: false,
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(probed: bool, x: f64, now: f64) -> HoverFrame {
        HoverFrame {
            probed,
            pointer_x: x,
            pointer_y: 0.0,
            now,
            pointer_down: false,
        }
    }

    fn down_frame(probed: bool, x: f64, now: f64) -> HoverFrame {
        HoverFrame {
            probed,
            pointer_x: x,
            pointer_y: 0.0,
            now,
            pointer_down: true,
        }
    }

    #[test]
    fn enters_after_dwell_not_before() {
        let mut hover = HoverIntent::new();
        let out = hover.advance(&frame(true, 100.0, 0.0));
        assert!(!out.hovered && !out.entered);
        let out = hover.advance(&frame(true, 100.0, 0.05));
        assert!(!out.hovered && !out.entered);
        let out = hover.advance(&frame(true, 100.0, 0.10));
        assert!(out.hovered && out.entered && !out.exited);
        // The entered edge fires on exactly one frame.
        let out = hover.advance(&frame(true, 100.0, 0.15));
        assert!(out.hovered && !out.entered && !out.exited);
    }

    #[test]
    fn fast_pass_never_arms() {
        // 200 px per 16 ms frame is 12,500 px/s: a crossing, not a dwell.
        let mut hover = HoverIntent::new();
        for i in 0..20 {
            let out = hover.advance(&frame(true, i as f64 * 200.0, i as f64 / 60.0));
            assert!(!out.hovered, "armed on frame {i} of a fast pass");
        }
    }

    #[test]
    fn slow_drift_arms() {
        // 5 px per frame is ~300 px/s: slow enough to count as dwelling.
        let mut hover = HoverIntent::new();
        let mut armed = false;
        for i in 0..20 {
            let out = hover.advance(&frame(true, 100.0 + i as f64 * 5.0, i as f64 / 60.0));
            armed |= out.entered;
        }
        assert!(armed, "slow drift never armed hover");
        assert!(hover.hovered());
    }

    #[test]
    fn leaving_before_dwell_cancels() {
        let mut hover = HoverIntent::new();
        hover.advance(&frame(true, 100.0, 0.0));
        hover.advance(&frame(true, 100.0, 0.05));
        let out = hover.advance(&frame(false, 100.0, 0.06));
        assert!(!out.hovered && !out.entered && !out.exited);
        // And the cancelled arm does not predispose the next entry.
        let out = hover.advance(&frame(true, 100.0, 0.07));
        assert!(!out.hovered && !out.entered);
    }

    #[test]
    fn exit_waits_out_grace() {
        let mut hover = HoverIntent::new();
        hover.advance(&frame(true, 100.0, 0.0));
        hover.advance(&frame(true, 100.0, 0.10));
        assert!(hover.hovered());
        let out = hover.advance(&frame(false, 100.0, 0.11));
        assert!(out.hovered && !out.exited);
        let out = hover.advance(&frame(false, 100.0, 0.15));
        assert!(out.hovered && !out.exited);
        let out = hover.advance(&frame(false, 100.0, 0.22));
        assert!(!out.hovered && out.exited);
        // The exited edge fires on exactly one frame.
        let out = hover.advance(&frame(false, 100.0, 0.30));
        assert!(!out.hovered && !out.exited);
    }

    #[test]
    fn reenter_during_grace_cancels_exit() {
        let mut hover = HoverIntent::new();
        hover.advance(&frame(true, 100.0, 0.0));
        hover.advance(&frame(true, 100.0, 0.10));
        hover.advance(&frame(false, 100.0, 0.11));
        let out = hover.advance(&frame(true, 100.0, 0.15));
        assert!(out.hovered && !out.entered && !out.exited);
        // Leaving again restarts the grace from zero.
        hover.advance(&frame(false, 100.0, 0.16));
        let out = hover.advance(&frame(false, 100.0, 0.20));
        assert!(out.hovered && !out.exited);
    }

    #[test]
    fn pin_holds_while_down_regardless_of_probe() {
        // Ports resolve_hover's contract: the held button owns the pointer.
        let mut hover = HoverIntent::new();
        let out = hover.advance(&down_frame(false, 500.0, 0.0));
        assert!(out.hovered && out.entered);
        // The window outruns the cursor mid-drag; the hit test misses but the
        // pill must not collapse.
        for i in 1..10 {
            let out = hover.advance(&down_frame(false, 500.0 + i as f64 * 50.0, i as f64 / 60.0));
            assert!(out.hovered && !out.exited);
        }
    }

    #[test]
    fn release_outside_exits_after_grace() {
        let mut hover = HoverIntent::new();
        hover.advance(&down_frame(false, 500.0, 0.0));
        let out = hover.advance(&frame(false, 500.0, 0.05));
        assert!(out.hovered && !out.exited);
        let out = hover.advance(&frame(false, 500.0, 0.20));
        assert!(!out.hovered && out.exited);
    }

    #[test]
    fn release_inside_stays_hovered() {
        let mut hover = HoverIntent::new();
        hover.advance(&down_frame(false, 500.0, 0.0));
        let out = hover.advance(&frame(true, 100.0, 0.05));
        assert!(out.hovered && !out.entered && !out.exited);
    }

    #[test]
    fn reset_forces_an_immediate_exit() {
        let mut hover = HoverIntent::new();
        hover.advance(&frame(true, 100.0, 0.0));
        hover.advance(&frame(true, 100.0, 0.10));
        assert!(hover.reset());
        assert!(!hover.hovered());
        // Idle again: the next entry must dwell from scratch.
        let out = hover.advance(&frame(true, 100.0, 0.11));
        assert!(!out.hovered && !out.entered);
        assert!(!hover.reset());
    }

    #[test]
    fn non_finite_input_never_poison_the_state() {
        let mut hover = HoverIntent::new();
        hover.advance(&frame(true, 100.0, 0.0));
        hover.advance(&frame(true, 100.0, 0.10));
        assert!(hover.hovered());
        let out = hover.advance(&HoverFrame {
            probed: true,
            pointer_x: f64::NAN,
            pointer_y: f64::INFINITY,
            now: f64::NAN,
            pointer_down: false,
        });
        assert!(out.hovered && !out.entered && !out.exited);
        let out = hover.advance(&frame(false, 100.0, 0.11));
        assert!(out.hovered && !out.exited);
    }

    #[test]
    fn backwards_time_counts_as_no_time_passing() {
        let mut hover = HoverIntent::new();
        hover.advance(&frame(true, 100.0, 1.0));
        // The clock jumps back; the dwell must neither arm early nor rewind.
        let out = hover.advance(&frame(true, 100.0, 0.5));
        assert!(!out.hovered);
        let out = hover.advance(&frame(true, 100.0, 1.0 + ARM_DWELL + 0.01));
        assert!(out.hovered && out.entered);
    }
}
