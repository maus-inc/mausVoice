//! Keeping the pill's parked position across app launches.
//!
//! The pill crates own what a parked position *means* (`rust_pill_shared`'s
//! `restore` module owns the record and the display arithmetic). This module
//! owns the two process boundaries around it:
//!
//! - Inbound, the pill publishes its geometry as `PositionChanged`. The desktop
//!   turns that into a record and stores it, so the position is durable the
//!   moment the user lets go of the pill rather than at shutdown, which the app
//!   does not always reach.
//! - Outbound, the desktop reads the record before it spawns the pill and hands
//!   it over as an argument. The pill then has its position before its first
//!   frame, so a restore is not a visible jump from the default corner.
//!
//! Every failure here is logged and degraded, never surfaced. A pill that
//! cannot read its stored position starts in the default corner, which is
//! exactly what every launch did before the position was stored.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::Manager;

use rust_pill_shared::edge::MonitorRect;
use rust_pill_shared::restore::ParkedWindow;

use crate::db::pill_position_queries;
use crate::state::OptionKeyDatabase;

/// Command line argument that carries the stored record into a pill process.
///
/// The pills are separate binaries that speak a line protocol on stdin, and
/// that protocol is only read after the window exists. An argument is the one
/// channel available before the first frame.
///
/// Re-exported rather than redefined: the writer here and the parser in each
/// pill have to agree on the literal, and two copies of it would only be
/// noticed when a saved position silently stopped restoring.
pub use rust_pill_shared::restore::SAVED_POSITION_ARG;

/// Read the stored record, if any, ready to hand to a pill process.
///
/// Called before the pill spawns, so it runs on the startup path. A locked or
/// missing database returns `None` and the pill starts in the default corner.
pub fn read_saved_position_record(app: &tauri::AppHandle) -> Option<String> {
    let database = app.try_state::<OptionKeyDatabase>()?;
    let pool = database.pool();
    match tauri::async_runtime::block_on(pill_position_queries::fetch_pill_position(pool)) {
        Ok(record) => record,
        Err(err) => {
            log::warn!("Could not read the pill's stored position: {err}");
            None
        }
    }
}

/// Store the geometry the pill just published.
///
/// `rect` is the pill window and `monitor` is the work area of the display it
/// lives on, both in the pill's own top-left space. The desktop does not
/// re-derive either, which keeps restore and save using the same numbers.
///
/// `display_id` is the pill's stable token for that display. It is optional
/// because a platform may not be able to name a display at all, and because a
/// pill that has not republished since this build started will not send one
/// until its next save. A record without a token still restores correctly by
/// geometry; a record with one also survives the display being unplugged and
/// replugged, or coming back at a different resolution.
///
/// A payload that does not describe a usable window is ignored rather than
/// stored, so a corrupt event cannot replace a good record with nothing.
pub fn store_published_position(
    app: &tauri::AppHandle,
    rect: &serde_json::Value,
    monitor: &serde_json::Value,
    display_id: Option<u64>,
) {
    let Some(window_rect) = read_rect(rect) else {
        return;
    };
    let Some(work_area) = read_rect(monitor) else {
        return;
    };
    let Some(parked) = ParkedWindow::new_named(
        window_rect.x,
        window_rect.y,
        window_rect.width,
        window_rect.height,
        MonitorRect::without_id(work_area.x, work_area.y, work_area.width, work_area.height),
        display_id,
    ) else {
        log::debug!("Ignoring a pill geometry that does not describe a usable window");
        return;
    };
    let Some(encoded) = parked.encode() else {
        log::warn!("Could not encode the pill's position for storage");
        return;
    };
    let Some(database) = app.try_state::<OptionKeyDatabase>() else {
        return;
    };
    let pool = database.pool();
    let saved_at = chrono::Utc::now().timestamp();
    // A publish that was already in flight when the record was erased describes a
    // position the user has since cleared. The gate below only refuses writes while
    // a clear is running, and this one arrives after it, so it has to be dropped on
    // its own terms -- but only while the pill has not yet answered the clear. A
    // save that arrives after that answer is the user's next drag, and dropping it
    // would leave the pill parked with nothing stored.
    if erase_is_undeclared() {
        log::debug!("Dropped a pill position published before the record was erased");
        return;
    }
    // The clear runs its own command, so this write is the one that could land
    // after the wipe and put a position the user just erased back on screen at
    // the next launch. Take the same gate every other native write takes.
    let written = tauri::async_runtime::block_on(async {
        // A clear can reopen the gate for the frontend's completion step while
        // the pill is still holding the pre-clear position. Nothing from that
        // window may be stored, so the generation must be live before the write.
        let generation = crate::db::local_data_write_gate::current_write_generation()
            .ok_or_else(|| sqlx::Error::Protocol("local data is being cleared".to_string()))?;
        let _guard =
            crate::db::local_data_write_gate::lock_local_data_write(Some(generation)).await?;
        pill_position_queries::upsert_pill_position(pool, &encoded, saved_at).await
    });
    if let Err(err) = written {
        // A refused gate means the user is clearing local data right now, which
        // is a correct outcome, not a fault. Only a real database error is worth
        // a warning.
        if crate::db::local_data_write_gate::current_write_generation().is_none() {
            log::debug!("Dropped a pill position because local data is being cleared");
        } else {
            log::warn!("Could not store the pill's position: {err}");
        }
    }
}

/// Set right after a clear or a reset, so a `PositionChanged` that was already
/// queued before it cannot put the row back.
///
/// The write gate covers a clear *in progress*, which is not the whole window.
/// The pill publishes `has_saved_position: true` from the frame that ran before
/// the clear; the desktop handles it some milliseconds later, after the clear has
/// finished and reopened the gate. Nothing about that message is stale as far as
/// the gate is concerned, so it passes the generation check and re-inserts the row
/// the user just erased -- and the next launch restores it.
///
/// The pill is told to forget, and its own state does clear, but the message it
/// already sent is still in the queue: the instruction cannot retract a value that
/// is in flight. This latch is the retraction.
///
/// ## Why this counts rather than drops
///
/// The obvious design is a one-shot flag that discards the next publish. It is
/// wrong, and a reviewer caught it: a clear that had nothing in flight leaves the
/// flag set, so the *next genuine save* -- the drop the user makes right after
/// resetting -- is thrown away. The pill then looks parked while the database is
/// empty, and the next launch opens at the default spot.
///
/// The root cause is that a stale publish and a genuine one are indistinguishable
/// once they reach this module. What distinguishes them is the pill's own report,
/// which is what `note_report` sees. A clear is owed one report that says the
/// record is gone: the pill always answers a `ForgetPosition` with
/// `has_saved_position: false`, and that answer is ordered before any drag that
/// follows it. So the erase is *declared*, and the declaration is spent by the
/// report that declares it -- never by a save.
static ERASE_UNDECLARED: AtomicBool = AtomicBool::new(false);

fn mark_position_erased() {
    ERASE_UNDECLARED.store(true, Ordering::Release);
}

/// Account for a report the pill published, returning whether it describes a
/// record that should be stored.
///
/// Called for every `PositionChanged`, whether or not it carries a position: the
/// erase is declared by the report that says there is no position, so the reports
/// that carry nothing are exactly the ones that have to be read.
pub(crate) fn note_report(has_saved_position: bool) -> bool {
    if has_saved_position {
        return true;
    }
    // A report with no position is either the answer to a clear -- which spends
    // the declaration -- or an ordinary reset, which leaves it alone. Spent by a
    // `swap` so two clears cannot leave one declaration behind for a later save.
    ERASE_UNDECLARED.swap(false, Ordering::AcqRel);
    false
}

/// Whether a save may still land, given what the queue has delivered so far.
///
/// False only while an erase is declared and unanswered: in that window the pill
/// has not yet reached the report that proves it knows the record is gone, so a
/// save sitting in the queue ahead of that report describes the position before
/// the erase. Once the declaration is spent this is true for the rest of the
/// process, which is what makes the very next drag storable.
fn erase_is_undeclared() -> bool {
    ERASE_UNDECLARED.load(Ordering::Acquire)
}

/// Forget the stored position, which is what "Reset Pill Position" means.
///
/// Runs on the same path that tells the pill to re-home, so a reset that the
/// user confirms is not undone by the next launch.
///
/// Returns whether the record is gone. A reset that reports success while the row
/// survives moves the window and then restores the old spot next launch, so the
/// caller has to be able to tell the difference.
pub fn clear_saved_position(app: &tauri::AppHandle) -> bool {
    // Set before the delete, not after: a publish queued behind this call has to
    // find the latch already closed when it runs.
    mark_position_erased();
    let Some(database) = app.try_state::<OptionKeyDatabase>() else {
        return false;
    };
    let pool = database.pool();
    let cleared = tauri::async_runtime::block_on(async {
        let _guard = crate::db::local_data_write_gate::lock_local_data_write(None).await?;
        pill_position_queries::clear_pill_position(pool).await
    });
    match cleared {
        Ok(()) => true,
        Err(err) => {
            // Nothing is stored if local data is being cleared right now, which is
            // the outcome this wanted. Only a real database error is worth a warning.
            if crate::db::local_data_write_gate::current_write_generation().is_none() {
                log::debug!(
                    "Skipped clearing the pill position because local data is being cleared"
                );
            } else {
                log::warn!("Could not clear the pill's stored position: {err}");
            }
            false
        }
    }
}

/// The argument a pill process needs to restore its own position.
///
/// `None` when nothing is stored or the row is unreadable, which leaves the
/// pill on its default placement.
pub fn saved_position_argument(app: &tauri::AppHandle) -> Option<String> {
    let record = read_saved_position_record(app)?;
    // Validate before crossing the boundary: a record this build's own reader
    // would reject must not be handed over as if it were usable.
    ParkedWindow::decode(&record)?;
    Some(format!("{SAVED_POSITION_ARG}{record}"))
}

/// Tell a running pill to stop treating its current spot as saved.
///
/// The clear finishes by reopening writes and reloading the window, which
/// immediately asks the pill for its geometry so the composer can anchor to it.
/// Without this the pill answers with the position it was at before the wipe and
/// the row is written straight back.
///
/// Best effort: a pill that is not running has nothing in memory to forget, and
/// the row it would have restored from is already gone.
pub fn forget_running_pill_position(app: &tauri::AppHandle) {
    if let Err(err) = crate::platform::overlay::notify_forget_position(app) {
        log::debug!("No running pill to forget the cleared position: {err}");
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct GeometryRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

fn read_rect(value: &serde_json::Value) -> Option<GeometryRect> {
    let number = |key: &str| value.get(key).and_then(|field| field.as_f64());
    let rect = GeometryRect {
        x: number("x")?,
        y: number("y")?,
        width: number("width")?,
        height: number("height")?,
    };
    let usable = rect.x.is_finite()
        && rect.y.is_finite()
        && rect.width.is_finite()
        && rect.height.is_finite()
        && rect.width > 0.0
        && rect.height > 0.0;
    usable.then_some(rect)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The save path reads exactly the fields the pill writes on the wire, so
    /// this pins that a real `PositionChanged` payload becomes a record.
    #[test]
    fn a_published_geometry_becomes_a_parseable_record() {
        let rect = json!({ "x": 500.0, "y": 300.0, "width": 200.0, "height": 60.0 });
        let monitor = json!({ "x": 0.0, "y": 0.0, "width": 1920.0, "height": 1040.0 });
        let window_rect = read_rect(&rect).expect("rect");
        let work_area = read_rect(&monitor).expect("monitor");
        let parked = ParkedWindow::new_named(
            window_rect.x,
            window_rect.y,
            window_rect.width,
            window_rect.height,
            MonitorRect::without_id(work_area.x, work_area.y, work_area.width, work_area.height),
            Some(4242),
        )
        .expect("usable window");
        let encoded = parked.encode().expect("encoded");
        let decoded = ParkedWindow::decode(&encoded).expect("decoded");
        assert_eq!(decoded, parked);
        assert_eq!(
            decoded.display_id,
            Some(4242),
            "the display's identity has to reach the database, or a replugged \
             monitor cannot be recognised"
        );
    }

    /// A payload missing a field, carrying a string where a number belongs, or
    /// describing an empty window must be ignored rather than stored.
    #[test]
    fn an_unusable_geometry_is_rejected() {
        assert!(read_rect(&json!({ "x": 1.0, "y": 2.0, "width": 3.0 })).is_none());
        assert!(read_rect(&json!({ "x": "1", "y": 2.0, "width": 3.0, "height": 4.0 })).is_none());
        assert!(read_rect(&json!({ "x": 1.0, "y": 2.0, "width": 0.0, "height": 4.0 })).is_none());
        assert!(read_rect(&json!({ "x": 1.0, "y": 2.0, "width": 3.0, "height": -4.0 })).is_none());
        assert!(read_rect(&json!(null)).is_none());
    }

    /// The argument is only produced for a record this build can read, so the
    /// pill never has to defend against its own host handing over nonsense.
    #[test]
    fn the_argument_is_only_built_from_a_record_that_decodes() {
        let good = ParkedWindow::new(
            10.0,
            20.0,
            200.0,
            60.0,
            MonitorRect::without_id(0.0, 0.0, 1920.0, 1080.0),
        )
        .expect("valid")
        .encode()
        .expect("encoded");
        assert!(ParkedWindow::decode(&good).is_some());
        assert_eq!(
            format!("{SAVED_POSITION_ARG}{good}"),
            format!("{}{good}", rust_pill_shared::restore::SAVED_POSITION_ARG)
        );
        assert!(ParkedWindow::decode("not a record").is_none());
    }
}
