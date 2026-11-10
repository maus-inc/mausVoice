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
pub const SAVED_POSITION_ARG: &str = "--saved-position=";

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
/// lives on, both in the pill's own top-left space. `monitor` is used as the
/// display identity because it is the rect the pill measured itself against;
/// the desktop does not re-derive it, which keeps restore and save using the
/// same numbers.
///
/// A payload that does not describe a usable window is ignored rather than
/// stored, so a corrupt event cannot replace a good record with nothing.
pub fn store_published_position(
    app: &tauri::AppHandle,
    rect: &serde_json::Value,
    monitor: &serde_json::Value,
) {
    let Some(window_rect) = read_rect(rect) else {
        return;
    };
    let Some(work_area) = read_rect(monitor) else {
        return;
    };
    let Some(parked) = ParkedWindow::new(
        window_rect.x,
        window_rect.y,
        window_rect.width,
        window_rect.height,
        MonitorRect {
            x: work_area.x,
            y: work_area.y,
            width: work_area.width,
            height: work_area.height,
        },
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
    // The clear runs its own command, so this write is the one that could land
    // after the wipe and put a position the user just erased back on screen at
    // the next launch. Take the same gate every other native write takes.
    let written = tauri::async_runtime::block_on(async {
        let _guard = crate::db::local_data_write_gate::lock_local_data_write(None).await?;
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

/// Forget the stored position, which is what "Reset Pill Position" means.
///
/// Runs on the same path that tells the pill to re-home, so a reset that the
/// user confirms is not undone by the next launch.
pub fn clear_saved_position(app: &tauri::AppHandle) {
    let Some(database) = app.try_state::<OptionKeyDatabase>() else {
        return;
    };
    let pool = database.pool();
    let cleared = tauri::async_runtime::block_on(async {
        let _guard = crate::db::local_data_write_gate::lock_local_data_write(None).await?;
        pill_position_queries::clear_pill_position(pool).await
    });
    if let Err(err) = cleared {
        // Nothing is stored if local data is being cleared right now, which is
        // the outcome this wanted. Only a real database error is worth a warning.
        if crate::db::local_data_write_gate::current_write_generation().is_none() {
            log::debug!("Skipped clearing the pill position because local data is being cleared");
        } else {
            log::warn!("Could not clear the pill's stored position: {err}");
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
        let parked = ParkedWindow::new(
            window_rect.x,
            window_rect.y,
            window_rect.width,
            window_rect.height,
            MonitorRect {
                x: work_area.x,
                y: work_area.y,
                width: work_area.width,
                height: work_area.height,
            },
        )
        .expect("usable window");
        let encoded = parked.encode().expect("encoded");
        let decoded = ParkedWindow::decode(&encoded).expect("decoded");
        assert_eq!(decoded, parked);
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
            MonitorRect {
                x: 0.0,
                y: 0.0,
                width: 1920.0,
                height: 1080.0,
            },
        )
        .expect("valid")
        .encode()
        .expect("encoded");
        assert!(ParkedWindow::decode(&good).is_some());
        assert_eq!(
            format!("{SAVED_POSITION_ARG}{good}"),
            format!("--saved-position={good}")
        );
        assert!(ParkedWindow::decode("not a record").is_none());
    }
}
