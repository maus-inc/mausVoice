use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::LazyLock;

use sqlx::Error;
use tokio::sync::{Mutex, MutexGuard, Notify};

static LOCAL_DATA_WRITE_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
static LOCAL_DATA_REMOTE_SEND_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
static LOCAL_DATA_REMOTE_OPERATION_COUNT: AtomicUsize = AtomicUsize::new(0);
static LOCAL_DATA_REMOTE_OPERATION_NOTIFY: LazyLock<Notify> = LazyLock::new(Notify::new);
static LOCAL_DATA_CLEAR_IN_PROGRESS: AtomicBool = AtomicBool::new(false);
static LOCAL_DATA_CLEAR_ACTIVE: AtomicBool = AtomicBool::new(false);
static LOCAL_DATA_CLEAR_READY: AtomicBool = AtomicBool::new(false);
static LOCAL_DATA_WRITE_GENERATION: AtomicU64 = AtomicU64::new(0);

pub(crate) type LocalDataWriteGuard = MutexGuard<'static, ()>;
pub(crate) type LocalDataRemoteSendGuard = MutexGuard<'static, ()>;

fn gate_error() -> Error {
    Error::Protocol("Local data is being cleared".to_string())
}

fn clear_not_ready_error() -> Error {
    Error::Protocol("Local data clear is not ready to complete".to_string())
}

/// Capture a token for work that may outlive the current call stack, such as a
/// remote connection. The token is invalidated as soon as a clear starts.
pub(crate) fn current_write_generation() -> Option<u64> {
    if LOCAL_DATA_CLEAR_IN_PROGRESS.load(Ordering::Acquire) {
        return None;
    }

    let generation = LOCAL_DATA_WRITE_GENERATION.load(Ordering::Acquire);
    if LOCAL_DATA_CLEAR_IN_PROGRESS.load(Ordering::Acquire)
        || LOCAL_DATA_WRITE_GENERATION.load(Ordering::Acquire) != generation
    {
        return None;
    }

    Some(generation)
}

pub(crate) fn is_write_generation_current(generation: u64) -> bool {
    if LOCAL_DATA_CLEAR_IN_PROGRESS.load(Ordering::Acquire) {
        return false;
    }

    LOCAL_DATA_WRITE_GENERATION.load(Ordering::Acquire) == generation
        && !LOCAL_DATA_CLEAR_IN_PROGRESS.load(Ordering::Acquire)
        && LOCAL_DATA_WRITE_GENERATION.load(Ordering::Acquire) == generation
}

fn is_remote_operation_current(generation: u64) -> bool {
    !LOCAL_DATA_CLEAR_ACTIVE.load(Ordering::Acquire) && is_write_generation_current(generation)
}

/// Reserve an asynchronous remote operation without holding the global local
/// write mutex across network I/O. A clear cancels these leases and drains them
/// before deleting local data; short database mutations still take the ordinary
/// write guard with the captured generation.
pub(crate) fn begin_local_data_remote_operation() -> Result<LocalDataRemoteOperationGuard, Error> {
    let generation = current_write_generation().ok_or_else(gate_error)?;
    if LOCAL_DATA_CLEAR_ACTIVE.load(Ordering::Acquire) {
        return Err(gate_error());
    }

    LOCAL_DATA_REMOTE_OPERATION_COUNT.fetch_add(1, Ordering::AcqRel);
    if !is_remote_operation_current(generation) {
        release_remote_operation();
        return Err(gate_error());
    }

    Ok(LocalDataRemoteOperationGuard { generation })
}

fn release_remote_operation() {
    let previous = LOCAL_DATA_REMOTE_OPERATION_COUNT.fetch_sub(1, Ordering::AcqRel);
    debug_assert!(previous > 0, "remote operation lease count underflowed");
    if previous == 1 {
        LOCAL_DATA_REMOTE_OPERATION_NOTIFY.notify_waiters();
    }
}

async fn wait_for_remote_operations_to_finish() {
    loop {
        let notified = LOCAL_DATA_REMOTE_OPERATION_NOTIFY.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if LOCAL_DATA_REMOTE_OPERATION_COUNT.load(Ordering::Acquire) == 0 {
            return;
        }
        notified.await;
    }
}

/// Restore the native write barrier before opening the database on startup
/// when a previous process left the durable clear marker behind.
pub(crate) fn recover_pending_local_data_clear() {
    let was_already_blocked = LOCAL_DATA_CLEAR_IN_PROGRESS.swap(true, Ordering::AcqRel);
    if !was_already_blocked {
        LOCAL_DATA_WRITE_GENERATION.fetch_add(1, Ordering::AcqRel);
    }
    LOCAL_DATA_CLEAR_READY.store(false, Ordering::Release);
}

/// Serialize a short native mutation or event handoff with the local-data
/// clear. Pass a captured generation for asynchronous work so a task started
/// before the clear cannot resume and write after the clear finishes.
pub(crate) async fn lock_local_data_write(
    expected_generation: Option<u64>,
) -> Result<LocalDataWriteGuard, Error> {
    let generation = expected_generation
        .or_else(current_write_generation)
        .ok_or_else(gate_error)?;
    if LOCAL_DATA_CLEAR_ACTIVE.load(Ordering::Acquire) || !is_write_generation_current(generation) {
        return Err(gate_error());
    }

    let guard = LOCAL_DATA_WRITE_LOCK.lock().await;
    if LOCAL_DATA_CLEAR_ACTIVE.load(Ordering::Acquire) || !is_write_generation_current(generation) {
        return Err(gate_error());
    }

    Ok(guard)
}

/// Serialize startup database path migration and SQL migrations with every
/// native write. When a durable clear marker is pending, the regular writer
/// gate stays closed; this narrow recovery lease only lets startup finish the
/// migration needed to open the database so the clear can be retried. No
/// renderer commands are registered until startup returns, and the held mutex
/// prevents any native writer from racing those migrations.
pub(crate) async fn lock_startup_database_migration(
    clear_recovery_pending: bool,
) -> Result<LocalDataWriteGuard, Error> {
    if !clear_recovery_pending {
        return lock_local_data_write(None).await;
    }

    if !LOCAL_DATA_CLEAR_IN_PROGRESS.load(Ordering::Acquire)
        || LOCAL_DATA_CLEAR_ACTIVE.load(Ordering::Acquire)
        || LOCAL_DATA_CLEAR_READY.load(Ordering::Acquire)
    {
        return Err(gate_error());
    }

    let guard = LOCAL_DATA_WRITE_LOCK.lock().await;
    if !LOCAL_DATA_CLEAR_IN_PROGRESS.load(Ordering::Acquire)
        || LOCAL_DATA_CLEAR_ACTIVE.load(Ordering::Acquire)
        || LOCAL_DATA_CLEAR_READY.load(Ordering::Acquire)
    {
        return Err(gate_error());
    }

    Ok(guard)
}

/// Serialize the clear with native writes and event handoffs. The gate closes
/// only after the write mutex is held, so no event can pass its generation check
/// and emit after the clear transition. A dropped guard deliberately leaves
/// writes blocked; only `complete_local_data_clear` may reopen the gate after
/// browser storage has also been cleared.
pub(crate) async fn begin_local_data_clear() -> Result<LocalDataClearGuard, Error> {
    LOCAL_DATA_CLEAR_ACTIVE
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| gate_error())?;
    // Stop new remote operations immediately. Existing native writes and event
    // handoffs still finish under the shared write mutex before the clear
    // generation changes, preserving their atomic handoff contract.
    LOCAL_DATA_REMOTE_OPERATION_NOTIFY.notify_waiters();

    let mut clear_guard = LocalDataClearGuard {
        lock: None,
        active: true,
    };
    clear_guard.lock = Some(LOCAL_DATA_WRITE_LOCK.lock().await);

    // The sender serializes only the brief socket write itself here, never the
    // connect/handshake/acknowledgement waits. Taking this lock before the
    // generation transition guarantees no new outgoing message can start after
    // the native clear barrier closes.
    let remote_send_guard = LOCAL_DATA_REMOTE_SEND_LOCK.lock().await;
    LOCAL_DATA_CLEAR_IN_PROGRESS.store(true, Ordering::Release);
    // Every attempt gets a fresh generation. In particular, a retry must also
    // invalidate work that captured a token during a failed completion window.
    LOCAL_DATA_WRITE_GENERATION.fetch_add(1, Ordering::AcqRel);
    // A retry must complete the native clear again before the frontend can
    // release a readiness marker left by an earlier successful native pass.
    LOCAL_DATA_CLEAR_READY.store(false, Ordering::Release);
    LOCAL_DATA_REMOTE_OPERATION_NOTIFY.notify_waiters();
    drop(remote_send_guard);

    // Remote operations hold a separate cancellation lease, not the global
    // database mutex. Their in-flight socket waits are cancelled above, and the
    // clear does not begin deleting data until every lease has drained.
    wait_for_remote_operations_to_finish().await;

    Ok(clear_guard)
}

/// Reopen native local-data writes after the frontend confirms that its
/// app-owned browser storage was cleared. A prior native clear failure cannot
/// call this because it never sets the ready marker.
pub(crate) async fn complete_local_data_clear() -> Result<(), Error> {
    complete_local_data_clear_with(|| Ok(())).await
}

/// Reopen the gate and retire a durable recovery marker while holding the write
/// mutex. If marker removal fails, restore the blocked state before releasing
/// the mutex so a restart or retry cannot allow writes into uncleared data.
pub(crate) async fn complete_local_data_clear_with(
    retire_recovery_marker: impl FnOnce() -> std::io::Result<()>,
) -> Result<(), Error> {
    if !LOCAL_DATA_CLEAR_IN_PROGRESS.load(Ordering::Acquire)
        || !LOCAL_DATA_CLEAR_READY.load(Ordering::Acquire)
    {
        return Err(clear_not_ready_error());
    }

    LOCAL_DATA_CLEAR_ACTIVE
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| gate_error())?;

    let mut clear_guard = LocalDataClearGuard {
        lock: None,
        active: true,
    };
    clear_guard.lock = Some(LOCAL_DATA_WRITE_LOCK.lock().await);

    if !LOCAL_DATA_CLEAR_IN_PROGRESS.load(Ordering::Acquire)
        || !LOCAL_DATA_CLEAR_READY.load(Ordering::Acquire)
    {
        return Err(clear_not_ready_error());
    }

    LOCAL_DATA_CLEAR_READY.store(false, Ordering::Release);
    // Keep the write mutex held until after the gate opens and the marker is
    // retired. New writers may observe the new generation but cannot enter.
    LOCAL_DATA_CLEAR_IN_PROGRESS.store(false, Ordering::Release);
    if let Err(error) = retire_recovery_marker() {
        LOCAL_DATA_CLEAR_IN_PROGRESS.store(true, Ordering::Release);
        return Err(Error::Io(error));
    }

    Ok(())
}

pub(crate) struct LocalDataRemoteOperationGuard {
    generation: u64,
}

impl LocalDataRemoteOperationGuard {
    pub(crate) fn generation(&self) -> u64 {
        self.generation
    }

    pub(crate) fn ensure_current(&self) -> Result<(), Error> {
        if is_remote_operation_current(self.generation) {
            Ok(())
        } else {
            Err(gate_error())
        }
    }

    /// Wait until a clear request invalidates this operation. `enable` registers
    /// the waiter before checking the atomics so a concurrent notification
    /// cannot be lost between the check and the await.
    pub(crate) async fn cancelled(&self) {
        loop {
            let notified = LOCAL_DATA_REMOTE_OPERATION_NOTIFY.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if !is_remote_operation_current(self.generation) {
                return;
            }
            notified.await;
        }
    }

    /// Serialize one bounded outgoing socket write with the clear barrier. The
    /// remote operation never holds this guard while connecting or waiting for
    /// a response, so ordinary local database writers remain independent.
    pub(crate) async fn lock_message_handoff(&self) -> Result<LocalDataRemoteSendGuard, Error> {
        let guard = tokio::select! {
            biased;
            _ = self.cancelled() => return Err(gate_error()),
            guard = LOCAL_DATA_REMOTE_SEND_LOCK.lock() => guard,
        };
        self.ensure_current()?;
        Ok(guard)
    }
}

impl Drop for LocalDataRemoteOperationGuard {
    fn drop(&mut self) {
        release_remote_operation();
    }
}

pub(crate) struct LocalDataClearGuard {
    lock: Option<LocalDataWriteGuard>,
    active: bool,
}

impl LocalDataClearGuard {
    /// Mark the native half successful. The gate stays closed until the
    /// frontend has removed localStorage and calls `complete_local_data_clear`.
    pub(crate) fn mark_ready_for_frontend_completion(&self) {
        debug_assert!(self.active);
        LOCAL_DATA_CLEAR_READY.store(true, Ordering::Release);
    }
}

impl Drop for LocalDataClearGuard {
    fn drop(&mut self) {
        // Release the mutex before allowing another clear attempt. Never reopen
        // writes here: an error can occur after the database has been wiped but
        // before audio or browser storage cleanup has finished.
        self.lock.take();
        if self.active {
            self.active = false;
            LOCAL_DATA_CLEAR_ACTIVE.store(false, Ordering::Release);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        begin_local_data_clear, begin_local_data_remote_operation, complete_local_data_clear,
        complete_local_data_clear_with, current_write_generation, is_write_generation_current,
        lock_local_data_write, lock_startup_database_migration,
    };
    use std::sync::LazyLock;
    use std::time::Duration;
    use tokio::sync::Mutex;

    static TEST_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

    #[tokio::test]
    async fn startup_clear_recovery_migration_lease_does_not_reopen_writes() {
        let _test_guard = TEST_LOCK.lock().await;
        super::recover_pending_local_data_clear();
        assert!(current_write_generation().is_none());
        assert!(lock_local_data_write(None).await.is_err());
        assert!(lock_startup_database_migration(false).await.is_err());

        let migration_guard = lock_startup_database_migration(true)
            .await
            .expect("startup can run migrations needed to open a pending clear");
        assert!(current_write_generation().is_none());
        assert!(lock_local_data_write(None).await.is_err());
        drop(migration_guard);
        assert!(current_write_generation().is_none());

        let retry_guard = begin_local_data_clear()
            .await
            .expect("the clear can run after startup migrations finish");
        retry_guard.mark_ready_for_frontend_completion();
        drop(retry_guard);
        complete_local_data_clear()
            .await
            .expect("a successful retry reopens writes");
    }

    #[tokio::test]
    async fn failed_clear_keeps_writes_blocked_until_retry_completes() {
        let _test_guard = TEST_LOCK.lock().await;
        let generation = current_write_generation().expect("gate starts open");
        let active_write = lock_local_data_write(Some(generation))
            .await
            .expect("start a native write");

        let clear = tokio::spawn(begin_local_data_clear());
        tokio::time::timeout(Duration::from_secs(1), async {
            while !super::LOCAL_DATA_CLEAR_ACTIVE.load(std::sync::atomic::Ordering::Acquire) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("clear request is queued behind the active write");
        assert!(!clear.is_finished());
        assert_eq!(
            current_write_generation(),
            Some(generation),
            "the generation stays current while an event handoff holds the write mutex"
        );
        assert!(is_write_generation_current(generation));

        // A remote event checks its generation and emits synchronously while
        // holding this lease. The clear cannot invalidate that generation until
        // it acquires the same mutex after the event handoff completes.
        let event_handoff_completed = is_write_generation_current(generation);
        drop(active_write);
        let failed_clear_guard = clear
            .await
            .expect("clear task does not panic")
            .expect("clear acquires the native write lock");
        assert!(event_handoff_completed);
        assert!(lock_local_data_write(Some(generation)).await.is_err());
        assert!(current_write_generation().is_none());
        drop(failed_clear_guard);

        // Failure releases the mutex so a retry can run, but it does not reopen
        // the write gate or revive generations captured before the clear.
        assert!(current_write_generation().is_none());
        let retry_guard = begin_local_data_clear()
            .await
            .expect("a failed clear can be retried");
        retry_guard.mark_ready_for_frontend_completion();
        drop(retry_guard);
        assert!(current_write_generation().is_none());

        complete_local_data_clear()
            .await
            .expect("frontend completion reopens a successful retry");
        let next_generation = current_write_generation().expect("clear reopens the gate");
        assert_ne!(generation, next_generation);
        assert!(lock_local_data_write(Some(generation)).await.is_err());
        assert!(lock_local_data_write(Some(next_generation)).await.is_ok());
    }

    #[tokio::test]
    async fn remote_operation_lease_does_not_hold_write_mutex_and_clear_drains_it() {
        let _test_guard = TEST_LOCK.lock().await;
        let generation = current_write_generation().expect("gate starts open");
        let remote_operation = begin_local_data_remote_operation()
            .expect("remote operation starts while writes are open");

        // A remote handshake can remain in flight without blocking unrelated
        // local mutations; only a short database mutation takes this mutex.
        let local_write = lock_local_data_write(Some(generation))
            .await
            .expect("remote operation does not hold the native write mutex");
        drop(local_write);

        let clear = tokio::spawn(begin_local_data_clear());
        tokio::time::timeout(Duration::from_secs(1), async {
            while is_write_generation_current(generation) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("clear invalidates the remote operation");
        tokio::time::timeout(Duration::from_secs(1), remote_operation.cancelled())
            .await
            .expect("remote operation receives clear cancellation");
        assert!(
            !clear.is_finished(),
            "clear waits until the active remote operation releases its lease"
        );

        drop(remote_operation);
        let clear_guard = clear
            .await
            .expect("clear task does not panic")
            .expect("clear drains the cancelled remote operation");
        clear_guard.mark_ready_for_frontend_completion();
        drop(clear_guard);
        complete_local_data_clear()
            .await
            .expect("successful clear reopens writes after remote work drains");
    }

    #[tokio::test]
    async fn startup_recovery_requires_a_successful_clear_before_reopening_writes() {
        let _test_guard = TEST_LOCK.lock().await;
        super::recover_pending_local_data_clear();
        assert!(current_write_generation().is_none());
        assert!(lock_local_data_write(None).await.is_err());

        let retry_guard = begin_local_data_clear()
            .await
            .expect("startup recovery can be retried");
        retry_guard.mark_ready_for_frontend_completion();
        drop(retry_guard);

        let mut generation_during_marker_retirement = None;
        let marker_error = complete_local_data_clear_with(|| {
            generation_during_marker_retirement = current_write_generation();
            Err(std::io::Error::other("marker removal failed"))
        })
        .await;
        assert!(marker_error.is_err());
        let stale_generation = generation_during_marker_retirement
            .expect("the test observes the brief completion window");
        assert!(current_write_generation().is_none());

        let retry_guard = begin_local_data_clear()
            .await
            .expect("a failed marker removal remains retryable");
        retry_guard.mark_ready_for_frontend_completion();
        drop(retry_guard);
        complete_local_data_clear_with(|| Ok(()))
            .await
            .expect("successful marker removal reopens writes");
        let current_generation = current_write_generation().expect("writes are reopened");
        assert_ne!(stale_generation, current_generation);
        assert!(lock_local_data_write(Some(stale_generation)).await.is_err());
    }
}
