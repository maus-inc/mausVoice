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
use std::sync::Mutex;

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
    // Set when the re-check under the lock drops this report. The declaration can
    // be retired by the pill's answer while this call resumes, so the flag is what
    // keeps the drop out of the warning path rather than the latch being read twice.
    let erased_while_waiting = std::cell::Cell::new(false);
    let written = tauri::async_runtime::block_on(async {
        // A clear can reopen the gate for the frontend's completion step while
        // the pill is still holding the pre-clear position. Nothing from that
        // window may be stored, so the generation must be live before the write.
        let generation = crate::db::local_data_write_gate::current_write_generation()
            .ok_or_else(|| sqlx::Error::Protocol("local data is being cleared".to_string()))?;
        let _guard =
            crate::db::local_data_write_gate::lock_local_data_write(Some(generation)).await?;
        // The check above runs before the lock, so a reset can declare and delete
        // the row in between. Re-check under the lock, the same way the clear sets
        // its declaration before taking it: whichever side wins the lock, the
        // report that resumes after the erase drops instead of recreating the row.
        if erase_is_undeclared() {
            erased_while_waiting.set(true);
            return Err(sqlx::Error::Protocol(
                "the record was erased while this report waited".to_string(),
            ));
        }
        pill_position_queries::upsert_pill_position(pool, &encoded, saved_at).await
    });
    if let Err(err) = written {
        // A refused gate means the user is clearing local data right now, which
        // is a correct outcome, not a fault. Only a real database error is worth
        // a warning.
        if crate::db::local_data_write_gate::current_write_generation().is_none() {
            log::debug!("Dropped a pill position because local data is being cleared");
        } else if erased_while_waiting.get() {
            log::debug!("Dropped a pill position published before the record was erased");
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
///
/// ## Why the declarations are kept under one lock
///
/// A declaration id and the fact that a declaration is outstanding have to move
/// together. Held as two atomics they did not: a failed clear could pass its
/// compare-and-exchange and then be overtaken -- a second clear declares between
/// the comparison and the flag store, and the first clear's `false` lands on top
/// of the second's declaration, leaving a clear in flight with nothing protecting
/// it. A reviewer caught exactly that window.
///
/// Merging the two into one compare-and-exchange closes the window but not the
/// class: a single bit cannot say *which* clear is outstanding, so one clear
/// withdrawing its own declaration would still drop the protection another clear
/// was holding. The declarations are therefore a list under a mutex, each one
/// withdrawing exactly its own entry and a report clearing the list, because the
/// report answers every clear that was owed one.
///
/// The save path reads a mirror flag rather than taking the lock. Writes to the
/// mirror happen only while the list is locked, so it is always a value the list
/// held, and it is cleared only once nothing is outstanding.
static ERASE: Mutex<EraseState> = Mutex::new(EraseState {
    next_id: 0,
    outstanding: Vec::new(),
});

/// What is under [`ERASE`].
struct EraseState {
    /// The id of the last declaration; only ever moves forward, so an id is
    /// never reused.
    next_id: u64,
    /// Declarations that no report has answered yet.
    outstanding: Vec<u64>,
}

/// The mirror [`erase_is_undeclared`] reads, written only while [`ERASE`] is held.
static ERASE_DECLARED: AtomicBool = AtomicBool::new(false);

/// The lock, made poison-proof: a panic while holding it cannot leave the list
/// inconsistent, because every mutation is a single assignment on a `Vec<u64>`
/// and nothing here can panic mid-update.
fn erase_state() -> std::sync::MutexGuard<'static, EraseState> {
    ERASE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Declare that the record is about to be erased, returning the id of this
/// declaration so a failed clear can withdraw exactly this one.
fn mark_position_erased() -> u64 {
    let mut state = erase_state();
    state.next_id += 1;
    let id = state.next_id;
    state.outstanding.push(id);
    ERASE_DECLARED.store(true, Ordering::Release);
    id
}

/// The order clears reach the pill in.
///
/// Declaring and delivering are two steps, and a clear that took the write gate
/// second can reach the pill first. The pill applies clears in arrival order, so
/// that inversion is what makes an acknowledged id an unreliable statement about
/// the ids below it: the lower clear can still be in the desktop when the higher
/// one is answered. Holding this for the whole declare-and-deliver pair makes
/// arrival order match declaration order, which is the premise that makes an
/// answered id a statement about every id below it.
///
/// A `std::sync::Mutex` would deadlock the main thread that awaits
/// `clear_saved_position`, so this is the async one.
static CLEAR_DELIVERY: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Hold the delivery order for one clear. The guard is released when the caller
/// has either handed the message to the pill or withdrawn the declaration, so a
/// failed clear cannot wedge every later one.
pub(crate) async fn lock_clear_delivery() -> tokio::sync::MutexGuard<'static, ()> {
    CLEAR_DELIVERY.lock().await
}

/// Withdraw a declaration whose clear failed, and only that one.
///
/// Without this the declaration outlives the clear that never happened. The reset
/// wrappers return before telling the pill to forget, so no report ever arrives to
/// spend the declaration, and every drag after the failed reset is silently
/// dropped -- the pill looks parked with a record that was never written.
///
/// Withdrawing is per declaration, not per flag: another clear may be in flight,
/// and taking its protection back would let the publish it is waiting on restore
/// the record it is clearing. A declaration a report has already answered is no
/// longer in the list, so its late withdrawal does nothing.
///
/// A clear whose pill message could not be sent withdraws here too, because that
/// pill will never answer: the declaration would close the latch for the rest of
/// the process and drop every later save.
pub(crate) fn withdraw_erase(generation: u64) {
    let mut state = erase_state();
    state.outstanding.retain(|id| *id != generation);
    if state.outstanding.is_empty() {
        ERASE_DECLARED.store(false, Ordering::Release);
    }
}

/// Withdraw every declaration, for the case where no report can ever arrive.
///
/// A `send` that succeeds proves the bytes reached the pipe, not that the pill
/// applied them: the process can exit before it reads the frame, and a
/// replacement pill in the same desktop process sends reports that answer no
/// earlier declaration. Every outstanding declaration is therefore unspendable
/// once that reader stops, and each one left behind closes the latch for the rest
/// of the process and drops every later drag. Called from the reader loop, which
/// is the one place that observes the pill going away on every platform whose
/// pill is a child process.
pub(crate) fn withdraw_all_erases() {
    let mut state = erase_state();
    state.outstanding.clear();
    ERASE_DECLARED.store(false, Ordering::Release);
}

/// Account for a report the pill published, returning whether it describes a
/// record that should be stored.
///
/// Called for every `PositionChanged`. `ack` is the id of the newest clear the
/// pill has applied, echoed on every report, and it retires every declaration at
/// or below it: the pill applies clears in order, so an answer for `ack` means
/// every clear up to `ack` is applied and no later one is. A report that names no
/// clear retires nothing.
///
/// Retiring *every* outstanding declaration, which is what this used to do, is the
/// race a reviewer caught. A reset's answer can sit in the pipe while a later clear
/// is declared, and an answer that retired that later clear's declaration opened
/// the latch to a save the pill had published before the clear: the row the user
/// just cleared came back on the next launch.
///
/// The save path is untouched: a report that says a position is saved is always
/// storable, so a drop the user makes after a clear still stores.
pub(crate) fn note_report(has_saved_position: bool, ack: Option<u64>) -> bool {
    if let Some(ack) = ack {
        let mut state = erase_state();
        // An id at or below this answer is applied, because delivery is ordered by
        // [`lock_clear_delivery`] and the pill applies clears in arrival order.
        // That ordering is the whole proof: without it, a clear declared second
        // can reach the pill first, and its answer would retire a declaration
        // whose clear the pill has not seen.
        state.outstanding.retain(|id| *id > ack);
        if state.outstanding.is_empty() {
            ERASE_DECLARED.store(false, Ordering::Release);
        }
    }
    has_saved_position
}

/// Whether a save may still land, given what the queue has delivered so far.
///
/// True only while an erase is declared and unanswered: in that window the pill
/// has not yet reached the report that proves it knows the record is gone, so a
/// save sitting in the queue ahead of that report describes the position before
/// the erase. Once the report arrives this is false for the rest of the process,
/// which is what makes the very next drag storable.
fn erase_is_undeclared() -> bool {
    ERASE_DECLARED.load(Ordering::Acquire)
}

/// Forget the stored position, which is what "Reset Pill Position" means.
///
/// Runs on the same path that tells the pill to re-home, so a reset that the
/// user confirms is not undone by the next launch.
///
/// Returns the declaration id when the record is gone, so the caller can hand it
/// to the pill and have the pill's answer retire exactly this declaration. `None`
/// when the record could not be cleared; a reset that reports success while the row
/// survives moves the window and then restores the old spot next launch, so the
/// caller has to be able to tell the difference.
pub async fn clear_saved_position(app: &tauri::AppHandle) -> Option<u64> {
    // Set before the delete, not after: a publish queued behind this call has to
    // find the latch already closed when it runs.
    let declaration = mark_position_erased();
    let Some(database) = app.try_state::<OptionKeyDatabase>() else {
        // Nothing was erased, so nothing may stay declared: no report is coming to
        // spend it.
        withdraw_erase(declaration);
        return None;
    };
    let pool = database.pool();
    // Awaited rather than `block_on`, because the reset command runs on the main
    // thread and the write gate is held for the whole of a local-data clear.
    // Blocking there would freeze the UI for the length of the clear.
    let cleared = async {
        let _guard = crate::db::local_data_write_gate::lock_local_data_write(None).await?;
        pill_position_queries::clear_pill_position(pool).await
    }
    .await;
    match cleared {
        Ok(()) => Some(declaration),
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
            // The clear failed, so the record is still there and the pill was never
            // told to forget -- but in both arms the declaration must go, because
            // the outcome is the same one way or the other: nothing erased, nothing
            // to retract, and no answer coming.
            withdraw_erase(declaration);
            None
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
    let parked = ParkedWindow::decode(&record)?;
    // Re-encoded from the decoded window rather than forwarded verbatim. The
    // stored text is not bounded by anything the pill controls: a row carrying a
    // field this build does not know about still decodes, because serde ignores
    // unknown fields, and forwarding it would put arbitrary length on a command
    // line with an OS limit. Exceeding that limit makes the spawn fail, and the
    // symptom is the pill never appearing -- a bad record taking the whole overlay
    // with it. Re-encoding keeps every field the reader uses and drops the rest, so
    // the argument is the size of a window by construction.
    let normalized = parked.encode()?;
    Some(format!("{SAVED_POSITION_ARG}{normalized}"))
}

/// Tell a running pill to stop treating its current spot as saved.
///
/// The clear finishes by reopening writes and reloading the window, which
/// immediately asks the pill for its geometry so the composer can anchor to it.
/// Without this the pill answers with the position it was at before the wipe and
/// the row is written straight back.
///
/// Telling the pill is half of it. The pill publishes `PositionChanged` from the
/// frame that ran *before* the wipe, and nothing about that message is stale once
/// it reaches the store: the write gate has reopened, so it would be stored, and
/// the next launch would restore the position the user just cleared. The other
/// half is the erase declaration, the same one a reset takes, because the queue
/// state is the same in both cases -- a publish may already be in flight. The
/// declaration is spent by the pill's answer to `ForgetPosition`, which is ordered
/// ahead of anything the user does next, so the drop they make afterwards still
/// stores normally.
///
/// Ordered declaration-first: a publish that runs between these two lines must
/// already find the latch closed.
///
/// A pill that is not running has nothing in memory to forget, and the row it
/// would have restored from is already gone. That case completes; a delivery that
/// failed while a pill is still running does not.
pub async fn forget_running_pill_position(app: &tauri::AppHandle) -> ForgetOutcome {
    // The same ordering the reset paths hold: this declares and delivers too, and
    // a forget that overtook an earlier reset would make the reset's acknowledged
    // id a claim about a clear the pill has not seen.
    let _delivery = lock_clear_delivery().await;
    let declaration = mark_position_erased();
    if !crate::platform::overlay::pill_is_running(app) {
        // Nothing holds the position in memory, so nothing can replay it. The
        // reader that would deliver a report has already stopped, and its exit
        // withdrew every declaration, so opening the latch here changes nothing.
        withdraw_erase(declaration);
        return ForgetOutcome::NoPill;
    }
    match crate::platform::overlay::notify_forget_position(app, Some(declaration)) {
        Ok(()) => ForgetOutcome::Delivered(declaration),
        Err(err) => {
            // The declaration stays outstanding on purpose. A pill that is still
            // running may have a saved-position report buffered on its stdout
            // that describes the position this clear just deleted, and the latch
            // is what stops that report being stored. Withdrawing it here is how
            // the row came back. The reader's exit withdraws it if no answer ever
            // arrives, so the latch cannot close for the rest of the process.
            log::error!("A running pill did not receive the cleared position: {err}");
            ForgetOutcome::DeliveryFailed
        }
    }
}

/// What a forget attempt did, so a caller can tell an absent pill from a
/// delivery that failed while a pill was still running.
///
/// The two used to be one `Option`, and the caller treated both as "nothing to
/// do". They are not the same: an absent pill has no memory to forget, while a
/// failed delivery leaves a running pill holding the pre-clear position with a
/// report already on its way. Marking the wipe ready in the second case lets
/// that report recreate the row the clear just deleted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ForgetOutcome {
    /// The pill was told. Its answer retires this declaration.
    Delivered(u64),
    /// No pill is running, so there is nothing in memory to forget.
    NoPill,
    /// A pill is running but the forget did not reach it.
    DeliveryFailed,
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
    use std::future::Future;

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

    /// The latch is process-wide, so the tests that drive it take turns.
    static LATCH: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn latch() -> std::sync::MutexGuard<'static, ()> {
        let guard = LATCH
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut state = erase_state();
        state.outstanding.clear();
        ERASE_DECLARED.store(false, Ordering::Release);
        drop(state);
        guard
    }

    /// The window a reviewer found: a failed clear must not take a second
    /// clear's declaration with it. Held as two atomics, the first clear could
    /// pass its comparison and then store `false` over the declaration the second
    /// clear had just made, leaving that clear in flight with nothing protecting
    /// it. There is no gap to pause in now, because the ownership test and the
    /// clear are the same compare-and-exchange; this drives the interleaving that
    /// used to break it.
    #[test]
    fn a_withdrawing_clear_does_not_clear_a_later_declaration() {
        let _turn = latch();
        let first = mark_position_erased();
        // The second clear declares before the first one's failure returns.
        let second = mark_position_erased();
        assert_ne!(first, second, "two declarations are separable");
        assert!(erase_is_undeclared());

        withdraw_erase(first);
        assert!(
            erase_is_undeclared(),
            "the failed clear withdrew the other clear's protection, so a queued \
             report could restore the record it is clearing"
        );

        withdraw_erase(second);
        assert!(
            !erase_is_undeclared(),
            "the clear that owns the declaration has to be able to take it back"
        );
    }

    /// The declaration is spent by the pill's answer, and only by that: the drop
    /// the user makes afterwards has to store normally, which is why this is a
    /// count and not a discard-the-next-publish flag.
    #[test]
    fn a_report_spends_the_declaration_and_the_next_drop_stores() {
        let _turn = latch();
        assert!(note_report(true, None), "an ordinary save always stores");
        let declaration = mark_position_erased();
        assert!(erase_is_undeclared());
        assert!(
            !note_report(false, Some(declaration)),
            "a report with no position is not storable"
        );
        assert!(
            !erase_is_undeclared(),
            "the answer to a clear is what spends the declaration"
        );
        assert!(
            note_report(true, None),
            "the drop after the answer has to store, or the pill looks parked \
             with an empty table"
        );
    }

    /// The window a reviewer found, driven end to end. A reset is declared first,
    /// its answer is delayed in the pipe, and a clear is declared after it. The
    /// reset's answer names only the reset, so it must leave the clear's
    /// declaration standing; otherwise a save published before the clear passes the
    /// latch and puts the cleared row back on the next launch.
    #[test]
    fn an_earlier_answers_ack_does_not_spend_a_later_declaration() {
        let _turn = latch();
        let reset = mark_position_erased();
        let clear = mark_position_erased();
        assert!(reset < clear, "the clear is declared after the reset");
        // The reset's answer arrives now, naming only the reset.
        assert!(!note_report(false, Some(reset)));
        assert!(
            erase_is_undeclared(),
            "the reset's answer opened the latch for a save published before the \
             clear, so the cleared row would come back on the next launch"
        );
        // The clear's own answer is what opens it again.
        assert!(!note_report(false, Some(clear)));
        assert!(!erase_is_undeclared());
        assert!(note_report(true, None), "the next drop stores");
    }

    /// The inversion a reviewer found, and the guarantee that closes it.
    ///
    /// Reset A declares id 1 and pauses before the write gate. Reset B declares
    /// id 2 and reaches the pill first. B's answer names 2, and A's clear has not
    /// reached the pill at all, so retiring every id at or below 2 would open the
    /// latch to a save the pill published before A's clear. Ordering the delivery
    /// is what prevents that inversion, so the property asserted here is the lock
    /// itself: a second clear cannot deliver until the first has.
    #[tokio::test]
    async fn clear_delivery_is_serialised_in_declaration_order() {
        let first = lock_clear_delivery().await;
        let order = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let recorded = order.clone();
        let second = tokio::spawn(async move {
            let _held = lock_clear_delivery().await;
            recorded.lock().unwrap().push(2u8);
        });
        order.lock().unwrap().push(1);
        // `yield_now` only offers the scheduler a turn; it does not promise the
        // contender runs before the guard is dropped, and a test that never polls
        // the contender would pass even with an independent lock. Poll the second
        // acquisition while the first guard is held and require it to stay
        // pending, so the lock is proven to be the one thing blocking it.
        {
            let mut acquisition = Box::pin(lock_clear_delivery());
            let waker = std::task::Waker::noop();
            let mut cx = std::task::Context::from_waker(waker);
            assert!(
                acquisition.as_mut().poll(&mut cx).is_pending(),
                "the second clear acquired the lock while the first held it, so \
                 two clears can reach the pill at once"
            );
            assert_eq!(
                *order.lock().unwrap(),
                vec![1u8],
                "the second clear delivered before the first, so its answer can \
                 retire a declaration the pill has not applied"
            );
        }
        drop(first);
        second.await.unwrap();
        assert_eq!(*order.lock().unwrap(), vec![1u8, 2u8]);
    }

    /// A report from a replacement pill answers no declaration the old one was
    /// handed, so a retired id must not open the latch for a new declaration.
    #[test]
    fn a_report_after_the_reader_stopped_does_not_spend_a_new_declaration() {
        let _turn = latch();
        let old = mark_position_erased();
        withdraw_all_erases();
        assert!(!erase_is_undeclared());
        let fresh = mark_position_erased();
        assert!(fresh > old, "ids only move forward");
        // A report carrying the retired id answers nothing that is outstanding.
        assert!(!note_report(false, Some(old)));
        assert!(
            erase_is_undeclared(),
            "a retired id opened the latch for a declaration it never answered"
        );
        assert!(!note_report(false, Some(fresh)));
        assert!(!erase_is_undeclared());
    }

    /// An ordinary reset -- one that was not asked for by a clear -- reports no
    /// position too, and must not spend a declaration that is not there or disturb
    /// one that is.
    #[test]
    fn a_report_with_nothing_declared_changes_nothing() {
        let _turn = latch();
        assert!(!note_report(false, None));
        assert!(!erase_is_undeclared());
        assert!(!note_report(false, None));
        assert!(note_report(true, None));
    }

    /// The invariant the list buys: a clear's withdrawal takes back its own
    /// declaration and nothing else, so when every clear has withdrawn, none is
    /// left standing. Held as two atomics, a withdraw that passed its comparison
    /// could store `false` *after* a concurrent clear declared, and that clear
    /// would then be unprotected.
    #[test]
    fn concurrent_clears_never_leave_a_declaration_behind() {
        let _turn = latch();
        for _ in 0..200 {
            let threads: Vec<_> = (0..8)
                .map(|_| {
                    std::thread::spawn(|| {
                        for _ in 0..50 {
                            let id = mark_position_erased();
                            // A declaration is visible to the save path no later
                            // than the declaration call returns, and no assertion
                            // is made on it here: another clear may legitimately
                            // answer it in between, which is the point of the design.
                            // Half the clears succeed, half fail and withdraw.
                            if id % 2 == 0 {
                                withdraw_erase(id);
                            } else {
                                note_report(false, Some(id));
                            }
                        }
                    })
                })
                .collect();
            for thread in threads {
                thread.join().expect("worker");
            }
            // Every clear above either withdrew its declaration or answered it, so
            // nothing may still be declared.
            assert!(
                !erase_is_undeclared(),
                "a declaration outlived every clear that could own it"
            );
            note_report(false, None);
        }
    }

    /// Ids only move forward, so a rollback can never be mistaken for a later
    /// declaration that happens to reuse the id.
    #[test]
    fn declaration_ids_are_never_reused() {
        let _turn = latch();
        let mut previous = 0;
        for _ in 0..64 {
            let id = mark_position_erased();
            assert!(id > previous, "{id} did not advance past {previous}");
            previous = id;
            withdraw_erase(id);
        }
        assert!(!erase_is_undeclared());
    }
}
