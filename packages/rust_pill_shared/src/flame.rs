//! The flame effect, shared by the three pill renderers.
//!
//! A flame is a handful of tongues of varying height and width that sway at
//! different speeds. Windows and macOS each carried an identical copy of that
//! update, including the same multiplicative hash used to give each tongue its own
//! size and rhythm. GTK seeds its tongues from a different formula on purpose --
//! it derives them from their index, so they are evenly spread instead of hashed --
//! and that difference lives at its call site, where it can be read, rather than
//! hidden behind a flag here.

use std::cell::{Cell, RefCell};

/// One tongue of the flame.
#[derive(Debug, Clone, PartialEq)]
pub struct FlameTongue {
    /// Where it sits across the flame's width, 0.0 to 1.0.
    pub t: f64,
    pub height: f64,
    pub width: f64,
    /// Sway phase in radians.
    pub phase: f64,
    /// Sway speed in radians per second.
    pub speed: f64,
}

pub const FLAME_TOTAL_DURATION: f64 = 5.0;
pub const FLAME_TONGUE_COUNT: usize = 5;
pub const FLAME_MIN_HEIGHT: f64 = 90.0;
pub const FLAME_MAX_HEIGHT: f64 = 150.0;
pub const FLAME_MIN_WIDTH: f64 = 36.0;
pub const FLAME_MAX_WIDTH: f64 = 60.0;
pub const FLAME_SWAY: f64 = 6.0;
pub const FLAME_SPEED_BASE: f64 = 4.5;

/// The flame's whole mutable state, as the caller's own cells.
pub struct Flame<'a> {
    pub active: &'a Cell<bool>,
    pub elapsed: &'a Cell<f64>,
    pub tongues: &'a RefCell<Vec<FlameTongue>>,
}

/// Seed tongue `i` from a multiplicative hash.
///
/// Deterministic, so a flame looks the same every time it is lit, and spread out,
/// so five tongues do not end up the same height. The multiplier is Knuth's.
pub fn hashed_tongue(i: usize) -> FlameTongue {
    let t = if FLAME_TONGUE_COUNT > 1 {
        i as f64 / (FLAME_TONGUE_COUNT - 1) as f64
    } else {
        0.5
    };
    let hash = (i as u64).wrapping_mul(2_654_435_761);
    let h_t = (hash % 1000) as f64 / 1000.0;
    let w_t = ((hash >> 10) % 1000) as f64 / 1000.0;
    let phase = ((hash >> 20) % 1000) as f64 / 1000.0 * std::f64::consts::TAU;
    let speed_var = ((hash >> 30) % 1000) as f64 / 1000.0;

    FlameTongue {
        t,
        height: FLAME_MIN_HEIGHT + (FLAME_MAX_HEIGHT - FLAME_MIN_HEIGHT) * h_t,
        width: FLAME_MIN_WIDTH + (FLAME_MAX_WIDTH - FLAME_MIN_WIDTH) * w_t,
        phase,
        speed: FLAME_SPEED_BASE * (0.8 + 0.4 * speed_var),
    }
}

impl Flame<'_> {
    /// Advance the flame by `dt` seconds.
    ///
    /// `seed` is asked for each tongue the first time the flame is drawn, and is
    /// not consulted again while tongues exist: reseeding every frame would make
    /// the flame flicker rather than sway.
    pub fn tick(&self, dt: f64, seed: impl Fn(usize) -> FlameTongue) {
        if !self.active.get() {
            return;
        }
        let elapsed = self.elapsed.get() + dt;
        self.elapsed.set(elapsed);

        let mut tongues = self.tongues.borrow_mut();

        if tongues.is_empty() {
            for i in 0..FLAME_TONGUE_COUNT {
                tongues.push(seed(i));
            }
        }

        for tongue in tongues.iter_mut() {
            tongue.phase += tongue.speed * dt;
        }

        if elapsed >= FLAME_TOTAL_DURATION {
            self.active.set(false);
            // Cleared so the next lighting seeds fresh tongues rather than
            // resuming a flame that had already burned out.
            tongues.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Harness {
        active: Cell<bool>,
        elapsed: Cell<f64>,
        tongues: RefCell<Vec<FlameTongue>>,
    }

    impl Harness {
        fn new() -> Self {
            Self {
                active: Cell::new(true),
                elapsed: Cell::new(0.0),
                tongues: RefCell::new(Vec::new()),
            }
        }
        fn flame(&self) -> Flame<'_> {
            Flame {
                active: &self.active,
                elapsed: &self.elapsed,
                tongues: &self.tongues,
            }
        }
    }

    /// An inactive flame is left exactly as it is.
    #[test]
    fn an_inactive_flame_does_nothing() {
        let h = Harness::new();
        h.active.set(false);
        h.flame().tick(0.1, hashed_tongue);
        assert_eq!(h.elapsed.get(), 0.0);
        assert!(h.tongues.borrow().is_empty());
    }

    /// Tongues are seeded once, and then only sway.
    #[test]
    fn tongues_are_seeded_once_and_then_sway() {
        let h = Harness::new();
        h.flame().tick(0.1, hashed_tongue);
        assert_eq!(h.tongues.borrow().len(), FLAME_TONGUE_COUNT);
        let phases: Vec<f64> = h.tongues.borrow().iter().map(|t| t.phase).collect();
        let speeds: Vec<f64> = h.tongues.borrow().iter().map(|t| t.speed).collect();

        h.flame().tick(0.1, hashed_tongue);
        let after: Vec<f64> = h.tongues.borrow().iter().map(|t| t.phase).collect();
        for (i, (now, before)) in after.iter().zip(phases.iter()).enumerate() {
            let expected = before + speeds[i] * 0.1;
            assert!(
                (now - expected).abs() < 1e-9,
                "tongue {i} moved by {} instead of its own speed",
                now - before
            );
        }
    }

    /// The hash gives the five tongues different heights: a flame whose tongues
    /// were all one size would be a block, not a flame.
    #[test]
    fn hashed_tongues_vary() {
        let tongues: Vec<FlameTongue> = (0..FLAME_TONGUE_COUNT).map(hashed_tongue).collect();
        let heights: std::collections::HashSet<u64> =
            tongues.iter().map(|t| t.height.to_bits()).collect();
        assert_eq!(
            heights.len(),
            FLAME_TONGUE_COUNT,
            "two tongues are the same height"
        );
        for tongue in &tongues {
            assert!((FLAME_MIN_HEIGHT..=FLAME_MAX_HEIGHT).contains(&tongue.height));
            assert!((FLAME_MIN_WIDTH..=FLAME_MAX_WIDTH).contains(&tongue.width));
            assert!((0.0..std::f64::consts::TAU).contains(&tongue.phase));
        }
        // Deterministic: seeding twice gives the same flame.
        assert_eq!(hashed_tongue(2), hashed_tongue(2));
    }

    /// It goes out on its own, and the tongues are cleared so relighting starts
    /// fresh.
    #[test]
    fn the_flame_goes_out_and_clears_itself() {
        let h = Harness::new();
        h.flame().tick(0.1, hashed_tongue);
        h.flame().tick(FLAME_TOTAL_DURATION, hashed_tongue);
        assert!(!h.active.get(), "the flame never went out");
        assert!(h.tongues.borrow().is_empty(), "burnt tongues were kept");
    }

    /// GTK seeds its own way, and the module must not care: the count and the
    /// sway still follow the shared rules.
    #[test]
    fn a_custom_seed_is_honoured() {
        let h = Harness::new();
        h.flame().tick(0.1, |i| FlameTongue {
            t: i as f64,
            height: FLAME_MIN_HEIGHT,
            width: FLAME_MIN_WIDTH,
            phase: 0.0,
            speed: 1.0,
        });
        let tongues = h.tongues.borrow();
        assert_eq!(tongues.len(), FLAME_TONGUE_COUNT);
        assert_eq!(tongues[3].t, 3.0, "the caller's seed was not used");
    }
}
