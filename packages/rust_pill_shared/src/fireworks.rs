//! The celebration animation, shared by the three pill renderers.
//!
//! Each pill drew the same firework: rockets launched on a fixed schedule, rose
//! under gravity leaving a trail, burst at the end of their fuse, and the sparks
//! then fell and faded. The arithmetic for all of that was copied into each
//! renderer's frame tick -- and once into each renderer's `state.rs` for the
//! rocket and spark records themselves -- so a change to the gravity constant had
//! three places to be made and two chances to be forgotten. This module owns the
//! values a rocket carries and the update that moves them; the pills keep the
//! `Cell`s and only say where the burst starts.
//!
//! Nothing here knows about a window, a device context or a canvas. The caller
//! passes the origin in its own coordinates and gets the rockets back to draw,
//! which is the only part that is genuinely per platform.

use std::cell::{Cell, RefCell};

/// Which part of its flight a rocket is in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RocketPhase {
    /// Under power, trailing smoke, fuse burning down.
    Rising,
    /// Burst; the sparks are falling and the trail is fading.
    Exploding,
}

/// One ember of a burst.
#[derive(Debug, Clone, PartialEq)]
pub struct Spark {
    pub x: f64,
    pub y: f64,
    pub vx: f64,
    pub vy: f64,
    /// 1.0 at the burst, and the spark is gone when this reaches zero.
    pub life: f64,
}

/// One rocket, from launch to the fade of its last spark.
#[derive(Debug, Clone, PartialEq)]
pub struct Rocket {
    pub x: f64,
    pub y: f64,
    pub vx: f64,
    pub vy: f64,
    pub trail: Vec<(f64, f64)>,
    /// Seconds left before the burst.
    pub fuse: f64,
    pub phase: RocketPhase,
    pub num_sparks: usize,
    /// Which launch in the schedule this came from; it offsets the burst pattern
    /// so two rockets in the air at once do not burst into identical fans.
    pub launch_index: usize,
    pub sparks: Vec<Spark>,
    pub trail_alpha: f64,
    pub color: (f64, f64, f64),
}

/// One entry of the launch schedule.
#[derive(Debug, Clone, Copy)]
pub struct FireworkLaunch {
    /// Seconds into the animation at which this rocket leaves the pill.
    pub time: f64,
    /// Direction of travel, measured from straight up.
    pub angle_deg: f64,
    pub speed: f64,
    pub fuse: f64,
    pub num_sparks: usize,
}

pub const FIREWORKS_TOTAL_DURATION: f64 = 7.0;
pub const FIREWORKS_GRAVITY: f64 = 40.0;
pub const FIREWORKS_SPARK_BASE_SPEED: f64 = 85.0;
pub const FIREWORKS_SPARK_LIFE: f64 = 1.1;
pub const FIREWORKS_SPARK_DRAG: f64 = 1.2;
pub const FIREWORKS_TRAIL_MAX: usize = 15;
pub const FIREWORKS_TRAIL_FADE_RATE: f64 = 2.0;

/// Drawing sizes. They live here rather than with each renderer's drawing code
/// because the three pills draw the same firework, and a rocket that was 1.8
/// points wide on Windows and not on macOS would be the only difference between
/// them.
pub const FIREWORKS_ROCKET_LINE_WIDTH: f64 = 1.8;
pub const FIREWORKS_SPARK_LINE_WIDTH: f64 = 1.2;
pub const FIREWORKS_HEAD_SIZE: f64 = 4.0;

pub const FIREWORK_COLORS: &[(f64, f64, f64)] = &[
    (1.0, 0.4, 0.3),  // coral red
    (0.3, 0.8, 1.0),  // sky blue
    (1.0, 0.85, 0.2), // gold
    (0.4, 1.0, 0.5),  // green
    (1.0, 0.5, 0.9),  // pink
    (0.5, 0.6, 1.0),  // periwinkle
    (1.0, 0.65, 0.2), // orange
];

/// The launch schedule: one rocket every third of a second, fanning out.
pub const FIREWORK_LAUNCHES: &[FireworkLaunch] = &[
    FireworkLaunch {
        time: 0.0,
        angle_deg: -18.0,
        speed: 120.0,
        fuse: 0.9,
        num_sparks: 18,
    },
    FireworkLaunch {
        time: 0.3,
        angle_deg: 22.0,
        speed: 135.0,
        fuse: 1.0,
        num_sparks: 22,
    },
    FireworkLaunch {
        time: 0.6,
        angle_deg: -2.0,
        speed: 150.0,
        fuse: 1.1,
        num_sparks: 26,
    },
    FireworkLaunch {
        time: 1.0,
        angle_deg: 35.0,
        speed: 115.0,
        fuse: 0.85,
        num_sparks: 16,
    },
    FireworkLaunch {
        time: 1.4,
        angle_deg: -40.0,
        speed: 125.0,
        fuse: 0.95,
        num_sparks: 20,
    },
];

/// The animation's whole mutable state, as the caller's own cells.
///
/// Borrowed rather than owned so a tick writes straight through: the alternative
/// -- a value built at the call site, ticked, and copied back -- is the same eight
/// lines of glue in three renderers, which is what this module exists to remove.
pub struct Fireworks<'a> {
    pub active: &'a Cell<bool>,
    pub elapsed: &'a Cell<f64>,
    pub next_launch: &'a Cell<usize>,
    pub rockets: &'a RefCell<Vec<Rocket>>,
}

/// Wrap one rocket's launch, positioned and turned into a rising rocket.
fn rocket_from(launch: &FireworkLaunch, index: usize, origin: (f64, f64)) -> Rocket {
    let angle_rad = launch.angle_deg.to_radians();
    let color = FIREWORK_COLORS[index % FIREWORK_COLORS.len()];
    Rocket {
        x: origin.0,
        y: origin.1,
        vx: launch.speed * angle_rad.sin(),
        vy: -launch.speed * angle_rad.cos(),
        trail: vec![(origin.0, origin.1)],
        fuse: launch.fuse,
        phase: RocketPhase::Rising,
        num_sparks: launch.num_sparks,
        launch_index: index,
        sparks: Vec::new(),
        trail_alpha: 1.0,
        color,
    }
}

impl Fireworks<'_> {
    /// Advance the animation by `dt` seconds.
    ///
    /// `origin` is where the rockets leave from, in the caller's drawing space:
    /// just above the pill, which is the one thing the three pills must supply
    /// themselves.
    ///
    /// A tick while the animation is not active does nothing and leaves the
    /// elapsed clock alone, so a celebration that has not started cannot be
    /// advanced by an idle frame -- and one that has finished stays finished
    /// until the caller starts it again.
    pub fn tick(&self, dt: f64, origin: (f64, f64)) {
        if !self.active.get() {
            return;
        }

        let elapsed = self.elapsed.get() + dt;
        self.elapsed.set(elapsed);

        let mut next = self.next_launch.get();
        let mut rockets = self.rockets.borrow_mut();

        while next < FIREWORK_LAUNCHES.len() && elapsed >= FIREWORK_LAUNCHES[next].time {
            let rocket = rocket_from(&FIREWORK_LAUNCHES[next], next, origin);
            rockets.push(rocket);
            next += 1;
        }
        self.next_launch.set(next);

        for rocket in rockets.iter_mut() {
            match rocket.phase {
                RocketPhase::Rising => {
                    rocket.vy += FIREWORKS_GRAVITY * dt;
                    rocket.x += rocket.vx * dt;
                    rocket.y += rocket.vy * dt;
                    rocket.trail.push((rocket.x, rocket.y));
                    if rocket.trail.len() > FIREWORKS_TRAIL_MAX {
                        rocket.trail.remove(0);
                    }
                    rocket.fuse -= dt;
                    if rocket.fuse <= 0.0 {
                        rocket.phase = RocketPhase::Exploding;
                        let offset = rocket.launch_index as f64 * 0.7;
                        for i in 0..rocket.num_sparks {
                            let n = rocket.num_sparks.max(1) as f64;
                            let angle = std::f64::consts::TAU * i as f64 / n + offset;
                            let speed_t = ((i * 7 + 3) % rocket.num_sparks.max(1)) as f64 / n;
                            let speed = FIREWORKS_SPARK_BASE_SPEED * (0.6 + 0.8 * speed_t);
                            rocket.sparks.push(Spark {
                                x: rocket.x,
                                y: rocket.y,
                                vx: speed * angle.cos(),
                                vy: speed * angle.sin(),
                                life: 1.0,
                            });
                        }
                    }
                }
                RocketPhase::Exploding => {
                    for spark in rocket.sparks.iter_mut() {
                        let drag = (-FIREWORKS_SPARK_DRAG * dt).exp();
                        spark.vx *= drag;
                        spark.vy *= drag;
                        // Sparks fall slower than the rocket rose: at the rocket's
                        // gravity they dive out of the burst instead of drifting
                        // away from it, and the effect reads as a spray rather
                        // than a firework.
                        spark.vy += FIREWORKS_GRAVITY * 0.3 * dt;
                        spark.x += spark.vx * dt;
                        spark.y += spark.vy * dt;
                        spark.life -= dt / FIREWORKS_SPARK_LIFE;
                    }
                    rocket.trail_alpha -= FIREWORKS_TRAIL_FADE_RATE * dt;
                    if rocket.trail_alpha < 0.0 {
                        rocket.trail_alpha = 0.0;
                    }
                }
            }
        }

        // A rising rocket is kept however far it has gone -- its fuse is what ends
        // it. An exploding one is kept only while it still has something to draw:
        // sparks alive or a trail still fading.
        rockets.retain(|r| match r.phase {
            RocketPhase::Rising => true,
            RocketPhase::Exploding => r.trail_alpha > 0.01 || r.sparks.iter().any(|s| s.life > 0.0),
        });

        if elapsed >= FIREWORKS_TOTAL_DURATION && rockets.is_empty() {
            self.active.set(false);
        }
    }

    /// Start the animation over.
    ///
    /// Separate from `tick` because the three renderers each opened the animation
    /// by clearing the same four values in the same order; forgetting one of them
    /// makes the second celebration start mid-air with the first one's rockets.
    ///
    /// `reduced_motion` keeps the celebration static. Rockets fly under gravity,
    /// which is exactly the motion the setting asks to suppress, and the other
    /// pill animations already honor it. The celebration still lands: the caller
    /// raises the message banner for the same duration, so the user gets the
    /// feedback without the flight.
    pub fn restart(&self, reduced_motion: bool) {
        self.elapsed.set(0.0);
        self.next_launch.set(0);
        self.rockets.borrow_mut().clear();
        self.active.set(!reduced_motion);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Harness {
        active: Cell<bool>,
        elapsed: Cell<f64>,
        next_launch: Cell<usize>,
        rockets: RefCell<Vec<Rocket>>,
    }

    impl Harness {
        fn new() -> Self {
            Self {
                active: Cell::new(true),
                elapsed: Cell::new(0.0),
                next_launch: Cell::new(0),
                rockets: RefCell::new(Vec::new()),
            }
        }

        fn fw(&self) -> Fireworks<'_> {
            Fireworks {
                active: &self.active,
                elapsed: &self.elapsed,
                next_launch: &self.next_launch,
                rockets: &self.rockets,
            }
        }
    }

    /// A tick while inactive must not move the clock: an idle frame that advanced
    /// it would make the first celebration start part-way through.
    #[test]
    fn an_inactive_tick_does_nothing() {
        let h = Harness::new();
        h.active.set(false);
        h.fw().tick(0.5, (0.0, 0.0));
        assert_eq!(h.elapsed.get(), 0.0);
        assert!(h.rockets.borrow().is_empty());
    }

    /// Rockets leave on schedule, and a burst produces the number of sparks the
    /// launch asked for.
    #[test]
    fn rockets_launch_on_schedule_and_burst() {
        let h = Harness::new();
        h.fw().tick(1.0 / 60.0, (10.0, 20.0));
        assert_eq!(
            h.rockets.borrow().len(),
            1,
            "the first rocket did not leave"
        );
        {
            let rockets = h.rockets.borrow();
            let first = &rockets[0];
            assert_eq!(first.phase, RocketPhase::Rising);
            // It has already flown for this frame, so the origin is the first point
            // of its trail rather than its current position.
            assert_eq!(first.trail[0], (10.0, 20.0));
        }

        // Past the first fuse: it has burst, kept all its sparks, and another
        // rocket has since joined it.
        h.fw().tick(1.0, (10.0, 20.0));
        let rockets = h.rockets.borrow();
        let burst = rockets
            .iter()
            .find(|r| r.phase == RocketPhase::Exploding)
            .expect("nothing burst after its fuse elapsed");
        assert_eq!(burst.sparks.len(), FIREWORK_LAUNCHES[0].num_sparks);
        assert!(rockets.len() > 1, "later launches did not follow the first");
    }

    /// The burst fans out rather than firing every spark the same way.
    #[test]
    fn a_burst_fans_out() {
        let h = Harness::new();
        h.fw().tick(1.2, (0.0, 0.0));
        let rockets = h.rockets.borrow();
        let burst = rockets
            .iter()
            .find(|r| r.phase == RocketPhase::Exploding)
            .expect("no burst to inspect");
        let distinct: std::collections::HashSet<(u64, u64)> = burst
            .sparks
            .iter()
            .map(|s| (s.vx.to_bits(), s.vy.to_bits()))
            .collect();
        assert_eq!(
            distinct.len(),
            burst.sparks.len(),
            "two sparks got the same velocity, so the fan has a doubled arm"
        );
    }

    /// The animation ends by itself, and only after the whole duration.
    #[test]
    fn the_animation_ends_when_it_is_over() {
        let h = Harness::new();
        // Still running a second in.
        for _ in 0..60 {
            h.fw().tick(1.0 / 60.0, (0.0, 0.0));
        }
        assert!(h.active.get(), "stopped before it finished");

        // Well past the duration with everything spent.
        h.fw().tick(FIREWORKS_TOTAL_DURATION, (0.0, 0.0));
        for _ in 0..200 {
            h.fw().tick(0.05, (0.0, 0.0));
        }
        assert!(!h.active.get(), "the animation never finished");
        assert!(h.rockets.borrow().is_empty(), "spent rockets were kept");
    }

    /// Restarting clears every field, so a second celebration does not inherit
    /// the first one's clock or rockets.
    #[test]
    fn a_restart_forgets_the_previous_run() {
        let h = Harness::new();
        h.fw().tick(1.2, (0.0, 0.0));
        assert!(h.elapsed.get() > 1.0);
        assert!(!h.rockets.borrow().is_empty());

        h.active.set(false);
        h.fw().restart(false);
        assert!(h.active.get());
        assert_eq!(h.elapsed.get(), 0.0);
        assert_eq!(h.next_launch.get(), 0);
        assert!(h.rockets.borrow().is_empty());
    }

    /// Reduced motion keeps the celebration still: `restart` clears the same
    /// state but never activates the flight, so no rocket is launched and no
    /// frame moves one. The caller raises the banner for the same duration, so
    /// the feedback still lands.
    #[test]
    fn reduced_motion_keeps_the_celebration_still() {
        let h = Harness::new();
        h.active.set(false);
        h.fw().restart(true);
        assert!(!h.active.get(), "reduced motion must not start the flight");
        for _ in 0..120 {
            h.fw().tick(1.0 / 60.0, (0.0, 0.0));
        }
        assert!(
            h.rockets.borrow().is_empty(),
            "a rocket flew under reduced motion"
        );
        assert_eq!(h.elapsed.get(), 0.0, "the clock advanced with no animation");
    }

    /// Gravity acts on a rising rocket: it slows, then falls back.
    #[test]
    fn a_rising_rocket_is_pulled_down() {
        let h = Harness::new();
        h.fw().tick(1.0 / 60.0, (0.0, 0.0));
        let before = h.rockets.borrow()[0].vy;
        h.fw().tick(1.0 / 60.0, (0.0, 0.0));
        let after = h.rockets.borrow()[0].vy;
        assert!(after > before, "gravity pulled the wrong way");
        let expected = FIREWORKS_GRAVITY / 60.0;
        assert!(
            (after - before - expected).abs() < 0.5,
            "one frame added {} to vy, not the {} a sixtieth of a second owes",
            after - before,
            expected
        );
    }
}
