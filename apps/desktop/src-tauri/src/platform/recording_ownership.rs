use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant};

#[derive(Default)]
pub struct RecordingWindow {
    closed: AtomicBool,
}

pub struct StartControl<'a> {
    pub cancelled: &'a AtomicBool,
    pub admission: Option<&'a Arc<RecordingAdmission>>,
    pub wait: Duration,
}

pub struct RecordingAdmission {
    id: String,
    generation: u64,
    token: u64,
    window: Arc<RecordingWindow>,
    created: Instant,
    cancelled: AtomicBool,
    claimed: AtomicBool,
    recovery_failed: AtomicBool,
    // Set at stop-command ingress, before its blocking worker can be delayed.
    normal_stop_requested: AtomicUsize,
    identity: Arc<()>,
    level_callback_active: Mutex<bool>,
}

impl RecordingAdmission {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    pub fn may_recover_audio(&self) -> bool {
        !self.cancelled.load(Ordering::SeqCst) && !self.window.closed.load(Ordering::SeqCst)
    }

    pub fn mark_recovery_failed(&self) {
        self.recovery_failed.store(true, Ordering::SeqCst);
    }

    /// Serialize level callback admission with release. The callback must not
    /// perform potentially blocking IPC while holding this guard.
    pub fn with_active_level_callback(&self, callback: impl FnOnce()) {
        let active = self
            .level_callback_active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if *active {
            callback();
        }
    }

    /// Best-effort check for queued level work. Delivery may still be in flight
    /// when ownership changes; consumers need epochs to reject such events.
    pub fn level_callback_is_active(&self) -> bool {
        *self
            .level_callback_active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn set_level_callback_active(&self, value: bool) {
        *self
            .level_callback_active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = value;
    }
}

const ADMISSION_LIFETIME: Duration = Duration::from_secs(300);
const MAX_ADMISSIONS: usize = 4096;
const MAX_PENDING_NORMAL_STOPS: usize = 16;
// Audio recovered from an abandoned start is kept only briefly and in memory.
const RECOVERED_AUDIO_LIFETIME: Duration = Duration::from_secs(60);
const MAX_RECOVERED_AUDIO_BYTES: usize = 128 * 1024 * 1024;
const MAX_RECOVERED_RECORDINGS: usize = 8;
// Each raw IPC response owns a separate copy. Bound replays as well as the
// retained bytes so repeated requests cannot create unbounded copies.
const MAX_RECOVERY_REPLAYS: usize = 4;

struct RecoveredRecording {
    admission: Arc<RecordingAdmission>,
    bytes: Arc<Vec<u8>>,
    created: Instant,
    replays: usize,
}

fn prune_expired_recoveries(recovered: &mut HashMap<u64, RecoveredRecording>) {
    recovered.retain(|_, entry| {
        if entry.created.elapsed() >= RECOVERED_AUDIO_LIFETIME {
            entry.admission.mark_recovery_failed();
            false
        } else {
            true
        }
    });
}

#[derive(Clone)]
pub struct RecordingRetry(Arc<()>, Option<Arc<RecordingAdmission>>);

impl RecordingRetry {
    pub fn admission(&self) -> Option<&Arc<RecordingAdmission>> {
        self.1.as_ref()
    }
}

pub struct RecordingStopIntent {
    admission: Arc<RecordingAdmission>,
    owner: Arc<Mutex<Option<Owner>>>,
    released: Arc<Condvar>,
}

impl Drop for RecordingStopIntent {
    fn drop(&mut self) {
        let _owner = self
            .owner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.admission
            .normal_stop_requested
            .fetch_sub(1, Ordering::SeqCst);
        self.released.notify_all();
    }
}

#[derive(Clone, Copy)]
struct StopPolicy {
    preserve_audio: bool,
    accept_sealed_active: bool,
}

impl StopPolicy {
    const DISCARD: Self = Self {
        preserve_audio: false,
        accept_sealed_active: false,
    };
    #[cfg(test)]
    const NORMAL: Self = Self {
        preserve_audio: true,
        accept_sealed_active: false,
    };
    const HANDOFF: Self = Self {
        preserve_audio: true,
        accept_sealed_active: true,
    };
}

/// The driver can release, remain active, or seal recoverable audio while
/// physical teardown is still pending. Only the last case permits replay.
pub enum RecoveryStop {
    Released(Result<(), String>),
    Pending(String),
    /// Capture is sealed and consumed, but hardware release is unconfirmed.
    /// Any retained audio must be marked as a failed capture before replay.
    Sealed,
}

impl RecoveryStop {
    pub fn unsealed(result: Result<(), String>, active: bool) -> Self {
        if active {
            Self::Pending(
                result
                    .err()
                    .unwrap_or_else(|| "Recording is still active after stop".into()),
            )
        } else {
            Self::Released(result)
        }
    }
}

struct Owner {
    id: String,
    token: u64,
    identity: Arc<()>,
    admission: Option<Arc<RecordingAdmission>>,
    window: Arc<RecordingWindow>,
    release_requested: bool,
    // The slot remains owned while the driver opens, even though the owner
    // mutex is not held. Nothing may stop or replace it until opening returns.
    opening: bool,
    // Driver operations run outside the mutex while this owner retains the slot.
    driver_busy: bool,
    // A normal stop waits for opening and owns its audio; cleanup retries must
    // not turn that stop into a discard while it is waiting.
    normal_stop_waiters: usize,
    // The capture buffer was sealed and consumed. Normal stops must replay
    // its retained copy instead of stopping the still-releasing driver again.
    handoff_complete: bool,
    retrying: bool,
    external: bool,
}

impl Owner {
    fn normal_stop_pending(&self) -> bool {
        self.normal_stop_waiters > 0
            || self
                .admission
                .as_ref()
                .is_some_and(|admission| admission.normal_stop_requested.load(Ordering::SeqCst) > 0)
    }

    fn request_release(&mut self) {
        self.release_requested = true;
        if let Some(admission) = &self.admission {
            admission.set_level_callback_active(false);
        }
    }
}

fn finish_stop<T>(
    owner: &mut Option<Owner>,
    result: (Result<T, String>, bool),
) -> Result<T, String> {
    let (result, still_recording) = result;
    if still_recording {
        return result.and(Err("Recording is still active after stop".into()));
    }
    *owner = None;
    result
}

/// Serializes the recorder and its owner across every webview.
#[derive(Default)]
pub struct RecordingOwnership {
    owner: Arc<Mutex<Option<Owner>>>,
    windows: Mutex<HashMap<usize, Weak<RecordingWindow>>>,
    admissions: Mutex<HashMap<String, Arc<RecordingAdmission>>>,
    // A start guard can finish its admission before a dispatched stop reaches
    // native. Weak entries keep that stop addressable without retaining audio
    // or preventing reuse of the textual owner ID.
    retired_admissions: Mutex<HashMap<u64, Weak<RecordingAdmission>>>,
    recovered: Mutex<HashMap<u64, RecoveredRecording>>,
    recovery_reaper_running: AtomicBool,
    released: Arc<Condvar>,
    generation: AtomicU64,
    next_token: AtomicU64,
    resetting: AtomicBool,
}

impl RecordingOwnership {
    fn run_owned_without_lock<'a, T>(
        &'a self,
        mut owner: MutexGuard<'a, Option<Owner>>,
        action: impl FnOnce() -> T,
    ) -> (MutexGuard<'a, Option<Owner>>, Result<T, String>) {
        let current = owner.as_mut().expect("driver operation requires an owner");
        let identity = Arc::clone(&current.identity);
        current.driver_busy = true;
        drop(owner);
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(action));
        let mut owner = self
            .owner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let current = owner
            .as_mut()
            .filter(|current| Arc::ptr_eq(&current.identity, &identity))
            .expect("driver operation owner remains reserved");
        current.driver_busy = false;
        self.wake_starts();
        match outcome {
            Ok(result) => (owner, Ok(result)),
            Err(_) => {
                owner
                    .as_mut()
                    .expect("driver owner exists")
                    .request_release();
                self.wake_starts();
                (owner, Err("Recording driver panicked".into()))
            }
        }
    }

    fn stop_owned_without_lock<'a, T>(
        &'a self,
        owner: MutexGuard<'a, Option<Owner>>,
        stop: impl FnOnce() -> (Result<T, String>, bool),
    ) -> (MutexGuard<'a, Option<Owner>>, Result<T, String>) {
        let (mut owner, outcome) = self.run_owned_without_lock(owner, stop);
        let result = match outcome {
            Ok(result) => finish_stop(&mut owner, result),
            Err(error) => Err(error),
        };
        if owner.is_none() {
            self.wake_starts();
        }
        (owner, result)
    }

    fn recover_owned_without_lock<'a>(
        &'a self,
        owner: MutexGuard<'a, Option<Owner>>,
        stop: impl FnOnce() -> RecoveryStop,
    ) -> (MutexGuard<'a, Option<Owner>>, Result<(), String>) {
        let (mut owner, outcome) = self.run_owned_without_lock(owner, stop);
        let result = match outcome {
            Ok(RecoveryStop::Released(result)) => finish_stop(&mut owner, (result, false)),
            Ok(RecoveryStop::Pending(error)) => Err(error),
            Ok(RecoveryStop::Sealed) => {
                owner
                    .as_mut()
                    .expect("driver owner exists")
                    .handoff_complete = true;
                Err("Recording release is pending".into())
            }
            Err(error) => Err(error),
        };
        if owner.is_none() {
            self.wake_starts();
        }
        (owner, result)
    }

    pub fn window(&self, key: usize) -> Arc<RecordingWindow> {
        let mut windows = self
            .windows
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(window) = windows.get(&key).and_then(Weak::upgrade) {
            return window;
        }
        let window = Arc::new(RecordingWindow::default());
        windows.insert(key, Arc::downgrade(&window));
        window
    }

    pub fn close_window(&self, key: usize) -> Option<Arc<RecordingWindow>> {
        let mut windows = self
            .windows
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let window = windows.remove(&key)?.upgrade()?;
        window.closed.store(true, Ordering::SeqCst);
        let mut admissions = self
            .admissions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        admissions.retain(|_, admission| {
            let closed = Arc::ptr_eq(&admission.window, &window);
            if closed {
                admission.cancelled.store(true, Ordering::SeqCst);
            }
            !closed
        });
        self.recovered
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .retain(|_, entry| {
                if Arc::ptr_eq(&entry.admission.window, &window) {
                    entry.admission.cancelled.store(true, Ordering::SeqCst);
                    false
                } else {
                    true
                }
            });
        self.wake_starts();
        Some(window)
    }

    pub fn stop_window<T>(
        &self,
        window: &Arc<RecordingWindow>,
        stop: impl FnOnce() -> (Result<T, String>, bool),
    ) -> Option<Result<T, String>> {
        let mut owner = self
            .owner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !owner
            .as_ref()
            .is_some_and(|owner| Arc::ptr_eq(&owner.window, window))
        {
            return None;
        }
        if owner.as_ref().is_some_and(|owner| owner.external) {
            return Some(Err("Browser recording has not ended".into()));
        }
        let current = owner.as_mut().expect("window owner exists");
        current.request_release();
        self.wake_starts();
        if current.opening || current.driver_busy || current.normal_stop_pending() {
            return Some(Err("Recording release is pending".into()));
        }
        let (_owner, result) = self.stop_owned_without_lock(owner, stop);
        Some(result)
    }

    pub fn wake_starts(&self) {
        self.released.notify_all();
    }

    /// Keep a stopped recording for replay until acknowledgement or expiry.
    /// Explicit cancellation and window closure always win over recovery.
    pub fn retain_recording_audio(
        &self,
        admission: &Arc<RecordingAdmission>,
        bytes: Arc<Vec<u8>>,
    ) -> bool {
        let mut recovered = self
            .recovered
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        prune_expired_recoveries(&mut recovered);
        if !admission.may_recover_audio()
            || self.resetting.load(Ordering::SeqCst)
            || admission.generation != self.generation()
        {
            return false;
        }
        if recovered.contains_key(&admission.token)
            || recovered.len() >= MAX_RECOVERED_RECORDINGS
            || bytes.capacity() > MAX_RECOVERED_AUDIO_BYTES
            || recovered
                .values()
                .map(|entry| entry.bytes.capacity())
                .sum::<usize>()
                > MAX_RECOVERED_AUDIO_BYTES - bytes.capacity()
        {
            admission.mark_recovery_failed();
            return false;
        }
        recovered.insert(
            admission.token,
            RecoveredRecording {
                admission: Arc::clone(admission),
                bytes,
                created: Instant::now(),
                replays: 0,
            },
        );
        true
    }

    /// At most one timer task is needed, even if many recordings are retired.
    pub fn start_recovery_reaper(&self) -> bool {
        let recovered = self
            .recovered
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        !recovered.is_empty() && !self.recovery_reaper_running.swap(true, Ordering::SeqCst)
    }

    /// A concurrent save cannot be left without a timer as the last task exits.
    pub fn prune_recovered_audio(&self) -> bool {
        let mut recovered = self
            .recovered
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        prune_expired_recoveries(&mut recovered);
        if recovered.is_empty() {
            self.recovery_reaper_running.store(false, Ordering::SeqCst);
            false
        } else {
            true
        }
    }

    fn forget_abandoned_audio(&self, token: u64) {
        self.recovered
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&token);
    }

    pub fn acknowledge_audio(&self, id: &str, window: &Arc<RecordingWindow>, token: u64) {
        let mut recovered = self
            .recovered
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if recovered.get(&token).is_some_and(|entry| {
            entry.admission.id == id && Arc::ptr_eq(&entry.admission.window, window)
        }) {
            if let Some(entry) = recovered.remove(&token) {
                entry.admission.mark_recovery_failed();
            }
        }
    }

    fn recovered_audio(
        &self,
        id: &str,
        window: &Arc<RecordingWindow>,
        token: u64,
    ) -> Result<Option<Arc<Vec<u8>>>, String> {
        let mut recovered = self
            .recovered
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(entry) = recovered.get_mut(&token) else {
            return Ok(None);
        };
        if entry.created.elapsed() >= RECOVERED_AUDIO_LIFETIME {
            entry.admission.mark_recovery_failed();
            recovered.remove(&token);
            return Ok(None);
        }
        if !entry.admission.may_recover_audio() {
            recovered.remove(&token);
            return Ok(None);
        }
        if entry.admission.id != id || !Arc::ptr_eq(&entry.admission.window, window) {
            return Ok(None);
        }
        if entry.replays >= MAX_RECOVERY_REPLAYS {
            return Err("Recording recovery replay limit reached".into());
        }
        entry.replays += 1;
        Ok(Some(Arc::clone(&entry.bytes)))
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    pub fn admission_generation(&self) -> Result<u64, String> {
        if self.resetting.load(Ordering::SeqCst) {
            return Err("Recording reset is in progress".into());
        }
        let generation = self.generation();
        if self.resetting.load(Ordering::SeqCst) || generation != self.generation() {
            return Err("Recording reset is in progress".into());
        }
        Ok(generation)
    }

    pub fn reserve(&self, id: &str, window: &Arc<RecordingWindow>) -> Result<u64, String> {
        if id.is_empty() || id.len() > 128 {
            return Err("Invalid recording owner".into());
        }
        let generation = self.admission_generation()?;
        let mut admissions = self
            .admissions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut expired_claimed = Vec::new();
        admissions.retain(|_, admission| {
            // A reservation cancelled by a reset is finished: nothing can claim
            // it any more, so the next reservation for the same owner replaces
            // it instead of being refused as a duplicate.
            let dead = admission.created.elapsed() >= ADMISSION_LIFETIME
                || admission.cancelled.load(Ordering::SeqCst);
            if dead {
                admission.cancelled.store(true, Ordering::SeqCst);
                if admission.claimed.load(Ordering::SeqCst) {
                    expired_claimed.push((admission.token, Arc::downgrade(admission)));
                }
            }
            !dead
        });
        // A claimed start can still own the driver after its admission expires.
        // Keep its token addressable for a normal stop without retaining it.
        if !expired_claimed.is_empty() {
            let mut retired = self
                .retired_admissions
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            retired.retain(|_, admission| admission.strong_count() > 0);
            retired.extend(expired_claimed);
        }
        if admissions.len() >= MAX_ADMISSIONS {
            return Err("Too many recording admissions".into());
        }
        if admissions.contains_key(id) {
            return Err("Recording owner is already admitted".into());
        }
        if window.closed.load(Ordering::SeqCst)
            || self.resetting.load(Ordering::SeqCst)
            || generation != self.generation()
        {
            return Err("Recording admission was cancelled".into());
        }
        // Tokens cross the JavaScript boundary as numbers and are never reused,
        // even after reset. Exhaustion fails closed instead of wrapping.
        const MAX_SAFE_TOKEN: u64 = (1_u64 << 53) - 1;
        let token = self
            .next_token
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
                (value < MAX_SAFE_TOKEN).then_some(value + 1)
            })
            .map_err(|_| "Recording admission tokens are exhausted".to_string())?
            + 1;
        admissions.insert(
            id.to_owned(),
            Arc::new(RecordingAdmission {
                id: id.to_owned(),
                generation,
                token,
                window: Arc::clone(window),
                created: Instant::now(),
                cancelled: AtomicBool::new(false),
                claimed: AtomicBool::new(false),
                recovery_failed: AtomicBool::new(false),
                normal_stop_requested: AtomicUsize::new(0),
                identity: Arc::new(()),
                level_callback_active: Mutex::new(false),
            }),
        );
        Ok(token)
    }

    pub fn claim_admission(
        &self,
        id: &str,
        window: &Arc<RecordingWindow>,
        generation: u64,
    ) -> Result<Arc<RecordingAdmission>, String> {
        let admissions = self
            .admissions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let admission = admissions.get(id).ok_or("Recording admission is missing")?;
        if admission.token != generation
            || admission.generation != self.generation()
            || !Arc::ptr_eq(&admission.window, window)
            || admission.created.elapsed() >= ADMISSION_LIFETIME
            || admission.cancelled.load(Ordering::SeqCst)
            || admission.claimed.swap(true, Ordering::SeqCst)
        {
            return Err("Recording admission was cancelled or already used".into());
        }
        Ok(Arc::clone(admission))
    }

    pub fn finish_admission(&self, admission: &Arc<RecordingAdmission>) {
        let mut admissions = self
            .admissions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if admissions
            .get(&admission.id)
            .is_some_and(|current| Arc::ptr_eq(current, admission))
        {
            let mut retired = self
                .retired_admissions
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            retired.retain(|_, admission| admission.strong_count() > 0);
            retired.insert(admission.token, Arc::downgrade(admission));
            admissions.remove(&admission.id);
        }
    }

    fn cancel_matching_admission(
        &self,
        id: &str,
        scope: Option<(&Arc<RecordingWindow>, u64)>,
    ) -> Option<Arc<RecordingAdmission>> {
        let mut admissions = self
            .admissions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let matches = admissions.get(id).is_some_and(|admission| {
            scope.is_none_or(|(window, token)| {
                admission.token == token && Arc::ptr_eq(&admission.window, window)
            })
        });
        if matches {
            let admission = admissions.remove(id).expect("matching admission exists");
            admission.cancelled.store(true, Ordering::SeqCst);
            self.forget_abandoned_audio(admission.token);
            self.wake_starts();
            return Some(admission);
        }
        // A start guard may have retired its admission before it sets its
        // cancellation flag. The stop-or-cancel path holds the owner lock here,
        // so cancelling this exact retired admission closes that gap before a
        // claimed start can reserve the recorder.
        let retired = scope.and_then(|(window, token)| {
            self.retired_admissions
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .get(&token)
                .and_then(Weak::upgrade)
                .filter(|admission| admission.id == id && Arc::ptr_eq(&admission.window, window))
        });
        if let Some(admission) = retired {
            admission.cancelled.store(true, Ordering::SeqCst);
            self.forget_abandoned_audio(admission.token);
            self.wake_starts();
            return Some(admission);
        }
        None
    }

    pub fn cancel_scoped_admission(&self, id: &str, window: &Arc<RecordingWindow>, token: u64) {
        self.cancel_matching_admission(id, Some((window, token)));
    }

    /// Register a normal stop before scheduling its blocking worker. A lost
    /// start reply can drop its guard while that worker is still queued; the
    /// opening owner must retain the audio for the already-dispatched stop.
    pub fn note_scoped_normal_stop(
        &self,
        id: &str,
        window: &Arc<RecordingWindow>,
        token: u64,
    ) -> Result<Option<RecordingStopIntent>, String> {
        // Cleanup checks this counter while holding `owner` and reserves the
        // driver under that same lock. Registering under it makes the check and
        // stop-intent admission one ordered decision, rather than allowing an
        // intent to appear after cleanup's check but before it takes the audio.
        let _owner = self
            .owner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let admissions = self
            .admissions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let admission = admissions
            .get(id)
            .filter(|admission| admission.token == token)
            .cloned()
            .or_else(|| {
                self.retired_admissions
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .get(&token)
                    .and_then(Weak::upgrade)
            });
        let Some(admission) = admission
            .filter(|admission| admission.id == id && Arc::ptr_eq(&admission.window, window))
        else {
            return Ok(None);
        };
        admission
            .normal_stop_requested
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |count| {
                if count < MAX_PENDING_NORMAL_STOPS {
                    Some(count + 1)
                } else {
                    None
                }
            })
            .map_err(|_| "Too many pending recording stops".to_string())?;
        Ok(Some(RecordingStopIntent {
            admission,
            owner: Arc::clone(&self.owner),
            released: Arc::clone(&self.released),
        }))
    }

    #[cfg(test)]
    pub(crate) fn cancel_admission(&self, id: &str) {
        self.cancel_matching_admission(id, None);
    }

    pub fn begin_reset(&self) -> Result<(), String> {
        if self.resetting.swap(true, Ordering::SeqCst) {
            return Err("Recording reset is already in progress".into());
        }
        self.generation.fetch_add(1, Ordering::SeqCst);
        let admissions = self
            .admissions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // Cancel in place instead of dropping: a start that races the reset then
        // reports a cancelled admission instead of an unknown one, and the next
        // reservation prunes the cancelled entry.
        for admission in admissions.values() {
            admission.cancelled.store(true, Ordering::SeqCst);
        }
        let mut recovered = self
            .recovered
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for entry in recovered.drain().map(|(_, entry)| entry) {
            entry.admission.cancelled.store(true, Ordering::SeqCst);
        }
        self.wake_starts();
        Ok(())
    }

    pub fn end_reset(&self) {
        self.resetting.store(false, Ordering::SeqCst);
    }

    #[cfg(test)]
    pub fn start<T>(
        &self,
        id: &str,
        window: &Arc<RecordingWindow>,
        generation: u64,
        control: StartControl<'_>,
        start: impl FnOnce() -> Result<T, String>,
        mut stop: impl FnMut() -> bool,
    ) -> Result<T, String> {
        self.start_with_recovery(id, window, generation, control, start, |_| {
            RecoveryStop::unsealed(Ok(()), !stop())
        })
    }

    pub fn start_with_recovery<T>(
        &self,
        id: &str,
        window: &Arc<RecordingWindow>,
        generation: u64,
        control: StartControl<'_>,
        start: impl FnOnce() -> Result<T, String>,
        mut stop: impl FnMut(Option<Arc<RecordingAdmission>>) -> RecoveryStop,
    ) -> Result<T, String> {
        if id.is_empty() || id.len() > 128 {
            return Err("Invalid recording owner".into());
        }
        if control
            .admission
            .is_some_and(|admission| admission.id != id || admission.token != generation)
        {
            return Err("Recording admission does not match".into());
        }
        let generation = control
            .admission
            .map_or(generation, |admission| admission.generation);
        let mut owner = self
            .owner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let deadline = Instant::now() + control.wait;
        loop {
            if self.resetting.load(Ordering::SeqCst)
                || generation != self.generation()
                || control.cancelled.load(Ordering::SeqCst)
                || control
                    .admission
                    .is_some_and(|admission| admission.cancelled.load(Ordering::SeqCst))
                || window.closed.load(Ordering::SeqCst)
            {
                return Err("Recording start was cancelled".into());
            }
            if owner.is_none() {
                break;
            }
            // A failed stop must not make a live recorder available to a new
            // owner. Reserve the explicitly released owner while retrying so
            // the driver call cannot touch a successor.
            if owner.as_ref().is_some_and(|owner| {
                owner.release_requested
                    && !owner.opening
                    && !owner.driver_busy
                    && !owner.retrying
                    && !owner.normal_stop_pending()
            }) {
                let previous_admission = owner.as_ref().and_then(|owner| {
                    (!owner.handoff_complete)
                        .then(|| owner.admission.clone())
                        .flatten()
                });
                let (locked, _) =
                    self.recover_owned_without_lock(owner, || stop(previous_admission));
                owner = locked;
                if owner.is_none() {
                    continue;
                }
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("A recording is already in progress".into());
            }
            owner = self
                .released
                .wait_timeout(owner, remaining)
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .0;
        }
        *owner = Some(Owner {
            id: id.to_owned(),
            token: control.admission.map_or(0, |admission| admission.token),
            identity: control
                .admission
                .map_or_else(|| Arc::new(()), |admission| Arc::clone(&admission.identity)),
            admission: control.admission.map(|admission| {
                admission.set_level_callback_active(true);
                Arc::clone(admission)
            }),
            window: Arc::clone(window),
            release_requested: false,
            opening: true,
            driver_busy: false,
            normal_stop_waiters: 0,
            handoff_complete: false,
            retrying: false,
            external: false,
        });
        // The slot itself excludes successors. Do not hold the coordinator
        // mutex across potentially unbounded device enumeration or driver open.
        drop(owner);
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(start));
        let mut owner = self
            .owner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let current = owner.as_mut().expect("opening owner remains reserved");
        current.opening = false;
        // Wake normal stop waiters even if the open panicked. The owner stays
        // reserved until an owned stop proves the recorder has released it.
        self.wake_starts();
        let result = match outcome {
            Ok(result) => result,
            Err(panic) => {
                drop(owner);
                std::panic::resume_unwind(panic);
            }
        };
        if owner
            .as_ref()
            .is_some_and(|owner| owner.normal_stop_pending())
        {
            // A normal stop, unlike cancellation, is entitled to captured
            // audio, including when the start reply was lost or cancelled.
            return result;
        }
        if result.is_err()
            || owner.as_ref().is_some_and(|owner| owner.release_requested)
            || self.resetting.load(Ordering::SeqCst)
            || generation != self.generation()
            || control.cancelled.load(Ordering::SeqCst)
            || control
                .admission
                .is_some_and(|admission| admission.cancelled.load(Ordering::SeqCst))
            || window.closed.load(Ordering::SeqCst)
        {
            owner
                .as_mut()
                .expect("start reserved an owner")
                .request_release();
            self.wake_starts();
            let admission = owner.as_ref().and_then(|owner| owner.admission.clone());
            let (_owner, _) = self.recover_owned_without_lock(owner, || stop(admission));
            return result.and_then(|_| Err("Recording start was cancelled".into()));
        }
        result
    }

    /// Hold the same exclusive slot while a webview owns browser recognition.
    pub fn start_external(&self, admission: &Arc<RecordingAdmission>) -> Result<(), String> {
        let mut owner = self
            .owner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let cancelled = || {
            self.resetting.load(Ordering::SeqCst)
                || admission.generation != self.generation()
                || admission.cancelled.load(Ordering::SeqCst)
                || !admission.claimed.load(Ordering::SeqCst)
                || admission.window.closed.load(Ordering::SeqCst)
        };
        if cancelled() {
            return Err("Recording start was cancelled".into());
        }
        if owner.is_some() {
            return Err("A recording is already in progress".into());
        }
        *owner = Some(Owner {
            id: admission.id.clone(),
            token: admission.token,
            identity: Arc::clone(&admission.identity),
            admission: Some(Arc::clone(admission)),
            window: Arc::clone(&admission.window),
            release_requested: false,
            opening: false,
            driver_busy: false,
            normal_stop_waiters: 0,
            handoff_complete: false,
            retrying: false,
            external: true,
        });
        if cancelled() {
            *owner = None;
            self.wake_starts();
            return Err("Recording start was cancelled".into());
        }
        Ok(())
    }

    /// Release only after the browser's end event, or before it has started.
    fn release_external_matching(&self, id: &str, scope: Option<(&Arc<RecordingWindow>, u64)>) {
        self.cancel_matching_admission(id, scope);
        let mut owner = self
            .owner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if owner.as_ref().is_some_and(|owner| {
            owner.external
                && owner.id == id
                && scope.is_none_or(|(window, token)| {
                    owner.token == token && Arc::ptr_eq(&owner.window, window)
                })
        }) {
            *owner = None;
            self.wake_starts();
        }
    }

    pub fn release_external_scoped(&self, id: &str, window: &Arc<RecordingWindow>, token: u64) {
        self.release_external_matching(id, Some((window, token)));
    }

    #[cfg(test)]
    fn release_external(&self, id: &str) {
        self.release_external_matching(id, None);
    }

    pub fn release_external_admission(&self, admission: &RecordingAdmission) {
        let mut owner = self
            .owner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if owner.as_ref().is_some_and(|owner| {
            owner.external && Arc::ptr_eq(&owner.identity, &admission.identity)
        }) {
            *owner = None;
            self.wake_starts();
        }
    }

    fn stop_if_owned<T>(
        &self,
        id: &str,
        scope: Option<(&Arc<RecordingWindow>, u64)>,
        policy: StopPolicy,
        stop: impl FnOnce(Option<Arc<RecordingAdmission>>) -> (Result<T, String>, bool),
        replay: impl Fn() -> Option<Result<T, String>>,
        absent: impl FnOnce() -> Option<Result<T, String>>,
    ) -> Option<Result<T, String>> {
        let mut owner = self
            .owner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !owner.as_ref().is_some_and(|owner| {
            owner.id == id
                && scope.is_none_or(|(window, token)| {
                    owner.token == token && Arc::ptr_eq(&owner.window, window)
                })
        }) {
            return absent();
        }
        if owner.as_ref().is_some_and(|owner| owner.external) {
            return Some(Err("Browser recording has not ended".into()));
        }
        if policy.accept_sealed_active
            && owner
                .as_ref()
                .is_some_and(|current| current.handoff_complete)
        {
            return Some(
                replay().unwrap_or_else(|| Err("Recording audio is no longer available".into())),
            );
        }
        let current = owner.as_mut().expect("matching owner exists");
        current.request_release();
        self.wake_starts();
        if policy.preserve_audio && (current.opening || current.driver_busy) {
            let identity = Arc::clone(&current.identity);
            current.normal_stop_waiters += 1;
            while owner.as_ref().is_some_and(|current| {
                Arc::ptr_eq(&current.identity, &identity)
                    && (current.opening || current.driver_busy)
            }) {
                owner = self
                    .released
                    .wait(owner)
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
            }
            let Some(current) = owner
                .as_mut()
                .filter(|current| Arc::ptr_eq(&current.identity, &identity))
            else {
                return absent();
            };
            current.normal_stop_waiters -= 1;
        } else if current.opening
            || current.driver_busy
            || (!policy.preserve_audio && current.normal_stop_pending())
        {
            return Some(Err("Recording release is pending".into()));
        }
        if owner
            .as_ref()
            .is_some_and(|current| current.handoff_complete)
            && policy.accept_sealed_active
        {
            return Some(
                replay().unwrap_or_else(|| Err("Recording audio is no longer available".into())),
            );
        }
        let admission = owner.as_ref().and_then(|current| current.admission.clone());
        if policy.accept_sealed_active {
            let (mut owner, outcome) = self.run_owned_without_lock(owner, || stop(admission));
            let result = match outcome {
                Ok((Ok(value), true)) => {
                    owner
                        .as_mut()
                        .expect("driver owner exists")
                        .handoff_complete = true;
                    Ok(value)
                }
                Ok(outcome) => finish_stop(&mut owner, outcome),
                Err(error) => Err(error),
            };
            if owner.is_none() {
                self.wake_starts();
            }
            Some(result)
        } else {
            let (_owner, result) = self.stop_owned_without_lock(owner, || stop(admission));
            Some(result)
        }
    }

    #[cfg(test)]
    pub fn stop_scoped<T>(
        &self,
        id: &str,
        window: &Arc<RecordingWindow>,
        token: u64,
        stop: impl FnOnce() -> (Result<T, String>, bool),
    ) -> Result<T, String> {
        self.stop_if_owned(
            id,
            Some((window, token)),
            StopPolicy::NORMAL,
            |_| stop(),
            || None,
            || None,
        )
        .unwrap_or_else(|| Err("Recording is no longer owned by this session".into()))
    }

    /// Stop a matching owner, or cancel its admission before capture begins.
    /// The owner lock stays held while cancelling an unmatched admission, so a
    /// claimed start cannot open the recorder between the check and cancellation.
    #[cfg(test)]
    pub fn stop_or_cancel_scoped<T>(
        &self,
        id: &str,
        window: &Arc<RecordingWindow>,
        token: u64,
        stop: impl FnOnce() -> (Result<T, String>, bool),
    ) -> Result<Option<T>, String> {
        self.stop_if_owned(
            id,
            Some((window, token)),
            StopPolicy::NORMAL,
            |_| {
                let (result, active) = stop();
                (result.map(Some), active)
            },
            || None,
            || {
                self.cancel_matching_admission(id, Some((window, token)))
                    .map(|_| Ok(None))
            },
        )
        .unwrap_or_else(|| Err("Recording is no longer owned by this session".into()))
    }

    /// Recover audio if abandoned-start cleanup won before the normal stop
    /// entered native. The owner lock orders the absent check with that cleanup.
    /// A successful result with `active == true` must be a sealed, explicitly
    /// failed capture: the owner remains reserved until release is proven.
    pub fn stop_or_recover_scoped(
        &self,
        id: &str,
        window: &Arc<RecordingWindow>,
        token: u64,
        stop: impl FnOnce() -> (Result<Vec<u8>, String>, bool),
    ) -> Result<Option<Arc<Vec<u8>>>, String> {
        self.stop_if_owned(
            id,
            Some((window, token)),
            StopPolicy::HANDOFF,
            |admission| {
                let (result, active) = stop();
                if result.is_err() && !active {
                    if let Some(admission) = &admission {
                        admission.mark_recovery_failed();
                    }
                }
                let result = result.map(|bytes| {
                    let bytes = Arc::new(bytes);
                    if let Some(admission) = admission {
                        self.retain_recording_audio(&admission, Arc::clone(&bytes));
                    }
                    Some(bytes)
                });
                (result, active)
            },
            || match self.recovered_audio(id, window, token) {
                Ok(Some(bytes)) => Some(Ok(Some(bytes))),
                Err(error) => Some(Err(error)),
                Ok(None) => None,
            },
            || {
                match self.recovered_audio(id, window, token) {
                    Ok(Some(bytes)) => return Some(Ok(Some(bytes))),
                    Err(error) => return Some(Err(error)),
                    Ok(None) => {}
                }
                self.cancel_matching_admission(id, Some((window, token)))
                    .map(|admission| {
                        if admission.recovery_failed.load(Ordering::SeqCst) {
                            Err("Recording audio could not be recovered".into())
                        } else {
                            Ok(None)
                        }
                    })
            },
        )
        .unwrap_or_else(|| Err("Recording is no longer owned by this session".into()))
    }

    /// Idempotent cleanup: an absent or different owner is already released.
    pub fn discard_scoped<T>(
        &self,
        id: &str,
        window: &Arc<RecordingWindow>,
        token: u64,
        stop: impl FnOnce() -> (Result<T, String>, bool),
    ) -> Result<(), String> {
        self.stop_if_owned(
            id,
            Some((window, token)),
            StopPolicy::DISCARD,
            |_| stop(),
            || None,
            || None,
        )
        .map_or(Ok(()), |result| result.map(|_| ()))
    }

    #[cfg(test)]
    pub(crate) fn stop<T>(
        &self,
        id: &str,
        stop: impl FnOnce() -> (Result<T, String>, bool),
    ) -> Result<T, String> {
        self.stop_if_owned(id, None, StopPolicy::NORMAL, |_| stop(), || None, || None)
            .unwrap_or_else(|| Err("Recording is no longer owned by this session".into()))
    }

    #[cfg(test)]
    pub(crate) fn discard<T>(
        &self,
        id: &str,
        stop: impl FnOnce() -> (Result<T, String>, bool),
    ) -> Result<(), String> {
        self.stop_if_owned(id, None, StopPolicy::DISCARD, |_| stop(), || None, || None)
            .map_or(Ok(()), |result| result.map(|_| ()))
    }

    pub fn stop_admission_with_recovery(
        &self,
        admission: &RecordingAdmission,
        stop: impl FnOnce() -> RecoveryStop,
    ) -> Option<Result<(), String>> {
        let mut owner = self
            .owner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !owner.as_ref().is_some_and(|owner| {
            !owner.external && Arc::ptr_eq(&owner.identity, &admission.identity)
        }) {
            return None;
        }
        let current = owner.as_mut().expect("matching owner exists");
        current.request_release();
        self.wake_starts();
        if current.opening
            || current.driver_busy
            || current.normal_stop_pending()
            || current.handoff_complete
        {
            return Some(Err("Recording release is pending".into()));
        }
        let (_owner, result) = self.recover_owned_without_lock(owner, stop);
        Some(result)
    }

    #[cfg(test)]
    fn stop_admission<T>(
        &self,
        admission: &RecordingAdmission,
        stop: impl FnOnce() -> (Result<T, String>, bool),
    ) -> Option<Result<(), String>> {
        self.stop_admission_with_recovery(admission, || {
            let (result, active) = stop();
            RecoveryStop::unsealed(result.map(|_| ()), active)
        })
    }

    /// Reserve at most one retry worker for this particular owner instance.
    fn begin_matching_release_retry(
        &self,
        id: &str,
        scope: Option<(&Arc<RecordingWindow>, u64)>,
    ) -> Option<RecordingRetry> {
        let mut owner = self
            .owner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match owner.as_mut() {
            Some(owner)
                if owner.id == id
                    && owner.release_requested
                    && !owner.retrying
                    && scope.is_none_or(|(window, token)| {
                        owner.token == token && Arc::ptr_eq(&owner.window, window)
                    }) =>
            {
                owner.retrying = true;
                Some(RecordingRetry(
                    Arc::clone(&owner.identity),
                    owner.admission.clone(),
                ))
            }
            _ => None,
        }
    }

    pub fn begin_release_retry(&self, id: &str) -> Option<RecordingRetry> {
        self.begin_matching_release_retry(id, None)
    }

    pub fn begin_release_retry_scoped(
        &self,
        id: &str,
        window: &Arc<RecordingWindow>,
        token: u64,
    ) -> Option<RecordingRetry> {
        self.begin_matching_release_retry(id, Some((window, token)))
    }

    pub fn begin_release_retry_admission(
        &self,
        admission: &RecordingAdmission,
    ) -> Option<RecordingRetry> {
        self.begin_matching_release_retry(&admission.id, Some((&admission.window, admission.token)))
    }

    pub fn begin_release_retry_window(
        &self,
        window: &Arc<RecordingWindow>,
    ) -> Option<RecordingRetry> {
        let mut owner = self
            .owner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match owner.as_mut() {
            Some(owner)
                if Arc::ptr_eq(&owner.window, window)
                    && owner.release_requested
                    && !owner.retrying =>
            {
                owner.retrying = true;
                Some(RecordingRetry(
                    Arc::clone(&owner.identity),
                    owner.admission.clone(),
                ))
            }
            _ => None,
        }
    }

    pub fn end_release_retry(&self, token: &RecordingRetry) {
        let mut owner = self
            .owner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(owner) = owner
            .as_mut()
            .filter(|owner| Arc::ptr_eq(&owner.identity, &token.0))
        {
            owner.retrying = false;
            self.wake_starts();
        }
    }

    /// Returns true when this owner instance no longer holds the recorder.
    pub fn retry_release_with_recovery(
        &self,
        token: &RecordingRetry,
        stop: impl FnOnce(bool) -> RecoveryStop,
    ) -> bool {
        let owner = self
            .owner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !owner
            .as_ref()
            .is_some_and(|owner| Arc::ptr_eq(&owner.identity, &token.0) && owner.release_requested)
        {
            return true;
        }
        if owner
            .as_ref()
            .is_some_and(|owner| owner.opening || owner.driver_busy || owner.normal_stop_pending())
        {
            return false;
        }
        let handoff_complete = owner.as_ref().is_some_and(|owner| owner.handoff_complete);
        let (owner, _) = self.recover_owned_without_lock(owner, || stop(handoff_complete));
        owner.is_none()
    }

    #[cfg(test)]
    fn retry_release<T>(
        &self,
        token: &RecordingRetry,
        stop: impl FnOnce(bool) -> (Result<T, String>, bool),
    ) -> bool {
        self.retry_release_with_recovery(token, |handoff_complete| {
            let (result, active) = stop(handoff_complete);
            RecoveryStop::unsealed(result.map(|_| ()), active)
        })
    }

    pub fn pending_release(&self) -> Option<String> {
        let owner = self
            .owner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        owner
            .as_ref()
            .filter(|owner| owner.release_requested)
            .map(|owner| owner.id.clone())
    }

    fn use_matching_recording<T>(
        &self,
        id: &str,
        scope: Option<(&Arc<RecordingWindow>, u64)>,
        action: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let mut owner = self
            .owner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        loop {
            let Some(current) = owner.as_ref().filter(|owner| {
                owner.id == id
                    && !owner.external
                    && !owner.opening
                    && !owner.release_requested
                    && scope.is_none_or(|(window, token)| {
                        owner.token == token && Arc::ptr_eq(&owner.window, window)
                    })
            }) else {
                return Err("Recording is no longer owned by this session".into());
            };
            if !current.driver_busy {
                break;
            }
            owner = self
                .released
                .wait(owner)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
        let (_owner, result) = self.run_owned_without_lock(owner, action);
        result?
    }

    pub fn use_recording_scoped<T>(
        &self,
        id: &str,
        window: &Arc<RecordingWindow>,
        token: u64,
        action: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        self.use_matching_recording(id, Some((window, token)), action)
    }

    #[cfg(test)]
    fn use_recording<T>(
        &self,
        id: &str,
        action: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        self.use_matching_recording(id, None, action)
    }

    pub fn force_stop<T>(
        &self,
        stop: impl FnOnce() -> (Result<T, String>, bool),
    ) -> Result<T, String> {
        let mut owner = self
            .owner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if owner.as_ref().is_some_and(|owner| owner.external) {
            return Err("Browser recording has not ended".into());
        }
        if let Some(current) = owner.as_mut() {
            current.request_release();
            self.wake_starts();
            if current.opening || current.driver_busy || current.normal_stop_pending() {
                return Err("Recording release is pending".into());
            }
        } else {
            // A forced reset can discover an unowned native stream. Reserve a
            // non-admissible identity while it stops, and retain it if the
            // driver cannot prove release.
            *owner = Some(Owner {
                id: String::new(),
                token: 0,
                identity: Arc::new(()),
                admission: None,
                window: Arc::new(RecordingWindow::default()),
                release_requested: true,
                opening: false,
                driver_busy: false,
                normal_stop_waiters: 0,
                handoff_complete: false,
                retrying: false,
                external: false,
            });
        }
        let (_owner, result) = self.stop_owned_without_lock(owner, stop);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};
    use std::thread;

    fn start(coordinator: &RecordingOwnership, id: &str) -> Result<(), String> {
        coordinator.start(
            id,
            &Arc::new(RecordingWindow::default()),
            coordinator.generation(),
            StartControl {
                admission: None,
                cancelled: &AtomicBool::new(false),
                wait: Duration::ZERO,
            },
            || Ok(()),
            || false,
        )
    }

    #[test]
    fn blocked_driver_stop_keeps_ownership_without_blocking_other_operations() {
        use std::sync::mpsc;
        let coordinator = Arc::new(RecordingOwnership::default());
        let window = coordinator.window(201);
        let token = coordinator.reserve("stop-owner", &window).unwrap();
        let admission = coordinator
            .claim_admission("stop-owner", &window, token)
            .unwrap();
        coordinator
            .start(
                "stop-owner",
                &window,
                token,
                StartControl {
                    cancelled: &AtomicBool::new(false),
                    admission: Some(&admission),
                    wait: Duration::ZERO,
                },
                || Ok(()),
                || false,
            )
            .unwrap();
        coordinator.finish_admission(&admission);
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let stopping = {
            let coordinator = Arc::clone(&coordinator);
            let window = Arc::clone(&window);
            thread::spawn(move || {
                coordinator.stop_or_cancel_scoped("stop-owner", &window, token, || {
                    entered_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    (Ok(vec![1, 2, 3]), false)
                })
            })
        };
        entered_rx.recv().unwrap();
        let (checked_tx, checked_rx) = mpsc::channel();
        let observer = {
            let coordinator = Arc::clone(&coordinator);
            let window = Arc::clone(&window);
            thread::spawn(move || {
                let contender = start(&coordinator, "contender");
                let control =
                    coordinator.use_recording_scoped("stop-owner", &window, token, || Ok(()));
                let cleanup = coordinator.discard_scoped(
                    "stop-owner",
                    &window,
                    token,
                    || -> (Result<(), String>, bool) {
                        panic!("cleanup touched an in-flight stop")
                    },
                );
                let reset = coordinator.force_stop(|| -> (Result<(), String>, bool) {
                    panic!("reset touched an in-flight stop")
                });
                let closed = coordinator.close_window(201).unwrap();
                let window_cleanup =
                    coordinator.stop_window(&closed, || -> (Result<(), String>, bool) {
                        panic!("window cleanup touched an in-flight stop")
                    });
                let retry = coordinator.begin_release_retry_window(&closed).unwrap();
                let retried = coordinator
                    .retry_release(&retry, |_| -> (Result<(), String>, bool) {
                        panic!("retry touched an in-flight stop")
                    });
                coordinator.end_release_retry(&retry);
                checked_tx
                    .send((contender, control, cleanup, reset, window_cleanup, retried))
                    .unwrap();
            })
        };
        let prompt = checked_rx.recv_timeout(Duration::from_millis(500));
        release_tx.send(()).unwrap();
        let (contender, control, cleanup, reset, window_cleanup, retried) =
            prompt.expect("ownership mutex remained blocked");
        assert!(contender.is_err());
        assert!(control.is_err());
        assert!(cleanup.is_err());
        assert!(reset.is_err());
        assert!(window_cleanup.unwrap().is_err());
        assert!(!retried);
        observer.join().unwrap();
        assert_eq!(stopping.join().unwrap().unwrap(), Some(vec![1, 2, 3]));
        assert!(start(&coordinator, "successor").is_ok());
    }

    #[test]
    fn blocked_control_does_not_lock_ownership_or_overlap_stop() {
        use std::sync::mpsc;
        let coordinator = Arc::new(RecordingOwnership::default());
        let window = coordinator.window(202);
        let token = coordinator.reserve("owner", &window).unwrap();
        let admission = coordinator
            .claim_admission("owner", &window, token)
            .unwrap();
        coordinator
            .start(
                "owner",
                &window,
                token,
                StartControl {
                    cancelled: &AtomicBool::new(false),
                    admission: Some(&admission),
                    wait: Duration::ZERO,
                },
                || Ok(()),
                || false,
            )
            .unwrap();
        coordinator.finish_admission(&admission);
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let control = {
            let coordinator = Arc::clone(&coordinator);
            let window = Arc::clone(&window);
            thread::spawn(move || {
                coordinator.use_recording_scoped("owner", &window, token, || {
                    entered_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    Ok(())
                })
            })
        };
        entered_rx.recv().unwrap();
        let (checked_tx, checked_rx) = mpsc::channel();
        let observer = {
            let coordinator = Arc::clone(&coordinator);
            let window = Arc::clone(&window);
            thread::spawn(move || {
                let contender = start(&coordinator, "contender");
                let cleanup = coordinator.discard_scoped(
                    "owner",
                    &window,
                    token,
                    || -> (Result<(), String>, bool) { panic!("cleanup overlapped control") },
                );
                checked_tx.send((contender, cleanup)).unwrap();
            })
        };
        let prompt = checked_rx.recv_timeout(Duration::from_millis(500));
        let (stop_entered_tx, stop_entered_rx) = mpsc::channel();
        let (stop_started_tx, stop_started_rx) = mpsc::channel();
        let stopping = {
            let coordinator = Arc::clone(&coordinator);
            let window = Arc::clone(&window);
            thread::spawn(move || {
                stop_started_tx.send(()).unwrap();
                coordinator.stop_or_cancel_scoped("owner", &window, token, || {
                    stop_entered_tx.send(()).unwrap();
                    (Ok(vec![4, 5, 6]), false)
                })
            })
        };
        stop_started_rx.recv().unwrap();
        let overlapped = stop_entered_rx
            .recv_timeout(Duration::from_millis(50))
            .is_ok();
        release_tx.send(()).unwrap();
        let (contender, cleanup) = prompt.expect("control held the owner mutex");
        assert!(contender.is_err());
        assert!(cleanup.is_err());
        assert!(!overlapped);
        observer.join().unwrap();
        assert!(control.join().unwrap().is_ok());
        assert_eq!(stopping.join().unwrap().unwrap(), Some(vec![4, 5, 6]));
        assert!(start(&coordinator, "successor").is_ok());
    }

    #[test]
    fn controls_serialize_without_holding_the_ownership_mutex() {
        use std::sync::mpsc;
        let coordinator = Arc::new(RecordingOwnership::default());
        start(&coordinator, "owner").unwrap();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let first = {
            let coordinator = Arc::clone(&coordinator);
            thread::spawn(move || {
                coordinator.use_recording("owner", || {
                    entered_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    Ok(())
                })
            })
        };
        entered_rx.recv().unwrap();
        let (started_tx, started_rx) = mpsc::channel();
        let (second_tx, second_rx) = mpsc::channel();
        let second = {
            let coordinator = Arc::clone(&coordinator);
            thread::spawn(move || {
                started_tx.send(()).unwrap();
                coordinator.use_recording("owner", || {
                    second_tx.send(()).unwrap();
                    Ok(())
                })
            })
        };
        started_rx.recv().unwrap();
        let overlapped = second_rx.recv_timeout(Duration::from_millis(50)).is_ok();
        release_tx.send(()).unwrap();
        assert!(!overlapped);
        assert!(first.join().unwrap().is_ok());
        assert!(second.join().unwrap().is_ok());
        second_rx.recv_timeout(Duration::from_millis(500)).unwrap();
    }

    #[test]
    fn forced_stop_without_an_owner_reserves_the_driver_and_retries_failure() {
        use std::sync::mpsc;
        let coordinator = Arc::new(RecordingOwnership::default());
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let reset = {
            let coordinator = Arc::clone(&coordinator);
            thread::spawn(move || {
                coordinator.force_stop(|| {
                    entered_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    (Err::<(), String>("driver still active".into()), true)
                })
            })
        };
        entered_rx.recv().unwrap();
        let (checked_tx, checked_rx) = mpsc::channel();
        let contender = {
            let coordinator = Arc::clone(&coordinator);
            thread::spawn(move || checked_tx.send(start(&coordinator, "contender")).unwrap())
        };
        let prompt = checked_rx.recv_timeout(Duration::from_millis(500));
        release_tx.send(()).unwrap();
        assert!(prompt.expect("force stop held the owner mutex").is_err());
        contender.join().unwrap();
        assert!(reset.join().unwrap().is_err());
        let id = coordinator
            .pending_release()
            .expect("unreleased stream remains reserved");
        let retry = coordinator.begin_release_retry(&id).unwrap();
        assert!(coordinator.retry_release(&retry, |_| (Ok::<(), String>(()), false)));
        assert!(start(&coordinator, "successor").is_ok());
    }

    #[test]
    fn panicked_driver_stop_keeps_owner_recoverable() {
        let coordinator = RecordingOwnership::default();
        assert!(start(&coordinator, "owner").is_ok());
        let result = coordinator.stop("owner", || -> (Result<(), String>, bool) {
            panic!("driver panic")
        });
        assert_eq!(result.unwrap_err(), "Recording driver panicked");
        assert!(start(&coordinator, "contender").is_err());
        let retry = coordinator
            .begin_release_retry("owner")
            .expect("retry remains available");
        assert!(coordinator.retry_release(&retry, |_| (Ok::<(), String>(()), false)));
        assert!(start(&coordinator, "successor").is_ok());
    }

    #[test]
    fn panicked_control_retires_owner_without_allowing_an_overlap() {
        let coordinator = RecordingOwnership::default();
        start(&coordinator, "owner").unwrap();
        let error = coordinator
            .use_recording("owner", || -> Result<(), String> { panic!("driver panic") })
            .unwrap_err();
        assert_eq!(error, "Recording driver panicked");
        assert!(coordinator.use_recording("owner", || Ok(())).is_err());
        let retry = coordinator.begin_release_retry("owner").unwrap();
        assert!(coordinator.retry_release(&retry, |_| (Ok::<(), String>(()), false)));
        assert!(start(&coordinator, "successor").is_ok());
    }

    #[test]
    fn stop_before_start_cancels_only_the_matching_admission() {
        let coordinator = RecordingOwnership::default();
        let window = coordinator.window(1);
        let other_window = coordinator.window(2);
        let token = coordinator.reserve("pending", &window).unwrap();
        assert!(coordinator
            .stop_or_cancel_scoped(
                "pending",
                &window,
                token + 1,
                || -> (Result<(), String>, bool) { panic!("no capture has started") }
            )
            .is_err());
        assert!(coordinator
            .stop_or_cancel_scoped(
                "pending",
                &other_window,
                token,
                || -> (Result<(), String>, bool) { panic!("no capture has started") }
            )
            .is_err());
        let admission = coordinator
            .claim_admission("pending", &window, token)
            .unwrap();
        assert_eq!(
            coordinator
                .stop_or_cancel_scoped(
                    "pending",
                    &window,
                    token,
                    || -> (Result<(), String>, bool) { panic!("no capture has started") }
                )
                .unwrap(),
            None
        );
        assert!(coordinator
            .start(
                "pending",
                &window,
                token,
                StartControl {
                    cancelled: &AtomicBool::new(false),
                    admission: Some(&admission),
                    wait: Duration::ZERO,
                },
                || -> Result<(), String> { panic!("cancelled capture opened") },
                || false
            )
            .is_err());
    }

    #[test]
    fn stop_during_open_returns_the_audio_instead_of_discarding_it() {
        let coordinator = Arc::new(RecordingOwnership::default());
        let window = coordinator.window(1);
        let token = coordinator.reserve("pending", &window).unwrap();
        let admission = coordinator
            .claim_admission("pending", &window, token)
            .unwrap();
        let (opened_tx, opened_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let start = {
            let coordinator = Arc::clone(&coordinator);
            let window = Arc::clone(&window);
            thread::spawn(move || {
                coordinator.start(
                    "pending",
                    &window,
                    token,
                    StartControl {
                        cancelled: &AtomicBool::new(false),
                        admission: Some(&admission),
                        wait: Duration::ZERO,
                    },
                    || {
                        opened_tx.send(()).unwrap();
                        release_rx.recv().unwrap();
                        Ok(())
                    },
                    || panic!("capture was discarded"),
                )
            })
        };
        opened_rx.recv().unwrap();
        let stop = {
            let coordinator = Arc::clone(&coordinator);
            let window = Arc::clone(&window);
            thread::spawn(move || {
                coordinator
                    .stop_or_cancel_scoped("pending", &window, token, || (Ok(vec![1, 2, 3]), false))
            })
        };
        release_tx.send(()).unwrap();
        assert!(start.join().unwrap().is_ok());
        assert_eq!(stop.join().unwrap().unwrap(), Some(vec![1, 2, 3]));
    }

    #[test]
    fn blocked_open_keeps_its_slot_without_blocking_competing_admission_or_release() {
        use std::sync::mpsc;
        let coordinator = Arc::new(RecordingOwnership::default());
        let window = coordinator.window(200);
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let stopped = Arc::new(AtomicBool::new(false));
        let worker = {
            let coordinator = Arc::clone(&coordinator);
            let window = Arc::clone(&window);
            let stopped = Arc::clone(&stopped);
            thread::spawn(move || {
                coordinator.start(
                    "opening",
                    &window,
                    coordinator.generation(),
                    StartControl {
                        admission: None,
                        cancelled: &AtomicBool::new(false),
                        wait: Duration::ZERO,
                    },
                    || {
                        entered_tx.send(()).unwrap();
                        release_rx.recv().unwrap();
                        Ok(())
                    },
                    || {
                        stopped.store(true, Ordering::SeqCst);
                        true
                    },
                )
            })
        };
        entered_rx.recv().unwrap();
        let (result_tx, result_rx) = mpsc::channel();
        let contender = {
            let coordinator = Arc::clone(&coordinator);
            thread::spawn(move || {
                result_tx.send(start(&coordinator, "contender")).unwrap();
            })
        };
        let prompt = result_rx.recv_timeout(Duration::from_millis(500));
        let closed = coordinator.close_window(200).unwrap();
        let (cleanup_tx, cleanup_rx) = mpsc::channel();
        let cleanup = {
            let coordinator = Arc::clone(&coordinator);
            thread::spawn(move || {
                let touched_driver = AtomicBool::new(false);
                let release_result = coordinator.stop_window(&closed, || {
                    touched_driver.store(true, Ordering::SeqCst);
                    (Ok::<(), String>(()), false)
                });
                let retry_result = coordinator
                    .begin_release_retry_window(&closed)
                    .map(|retry| {
                        coordinator.retry_release(&retry, |_| {
                            touched_driver.store(true, Ordering::SeqCst);
                            (Ok::<(), String>(()), false)
                        })
                    });
                cleanup_tx
                    .send((
                        release_result,
                        retry_result,
                        touched_driver.load(Ordering::SeqCst),
                    ))
                    .unwrap();
            })
        };
        // Always release the simulated driver before asserting timeouts, so a
        // regression fails the test instead of stranding its worker threads.
        let cleanup_prompt = cleanup_rx.recv_timeout(Duration::from_millis(500));
        release_tx.send(()).unwrap();
        let started = worker.join().unwrap();
        contender.join().unwrap();
        cleanup.join().unwrap();
        assert!(started.is_err());
        assert!(prompt.unwrap().is_err());
        let (release_result, retry_result, touched_driver) = cleanup_prompt.unwrap();
        assert!(release_result.unwrap().is_err());
        assert_eq!(retry_result, Some(false));
        assert!(!touched_driver);
        assert!(stopped.load(Ordering::SeqCst));
        assert!(start(&coordinator, "successor").is_ok());
    }

    #[test]
    fn normal_stop_during_open_survives_start_guard_cancellation() {
        use std::sync::mpsc;
        let coordinator = Arc::new(RecordingOwnership::default());
        let window = coordinator.window(201);
        let token = coordinator.reserve("opening", &window).unwrap();
        let admission = coordinator
            .claim_admission("opening", &window, token)
            .unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let opener = {
            let coordinator = Arc::clone(&coordinator);
            let window = Arc::clone(&window);
            let admission = Arc::clone(&admission);
            let cancelled = Arc::clone(&cancelled);
            thread::spawn(move || {
                coordinator.start(
                    "opening",
                    &window,
                    token,
                    StartControl {
                        admission: Some(&admission),
                        cancelled: &cancelled,
                        wait: Duration::ZERO,
                    },
                    || {
                        entered_tx.send(()).unwrap();
                        release_rx.recv().unwrap();
                        Ok(())
                    },
                    || panic!("normal stop owns the captured audio"),
                )
            })
        };
        entered_rx.recv().unwrap();
        let stopper = {
            let coordinator = Arc::clone(&coordinator);
            let window = Arc::clone(&window);
            thread::spawn(move || {
                coordinator
                    .stop_or_cancel_scoped("opening", &window, token, || (Ok(vec![1, 2, 3]), false))
            })
        };
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let waiting = coordinator.owner.try_lock().ok().is_some_and(|owner| {
                owner
                    .as_ref()
                    .is_some_and(|owner| owner.normal_stop_waiters == 1)
            });
            if waiting {
                break;
            }
            if Instant::now() >= deadline {
                release_tx.send(()).unwrap();
                panic!("normal stop did not register");
            }
            thread::yield_now();
        }
        cancelled.store(true, Ordering::SeqCst);
        coordinator.begin_reset().unwrap();
        assert!(coordinator
            .force_stop(|| -> (Result<(), String>, bool) {
                panic!("reset must not discard a normal stop's audio")
            })
            .is_err());
        coordinator.end_reset();
        assert!(coordinator
            .stop_admission(&admission, || -> (Result<(), String>, bool) {
                panic!("guard must not discard a normal stop's audio")
            })
            .is_some_and(|result| result.is_err()));
        assert!(coordinator
            .begin_release_retry_admission(&admission)
            .is_some_and(|retry| {
                !coordinator.retry_release(&retry, |_| -> (Result<(), String>, bool) {
                    panic!("retry stole audio")
                })
            }));
        release_tx.send(()).unwrap();
        assert!(opener.join().unwrap().is_ok());
        assert_eq!(stopper.join().unwrap().unwrap(), Some(vec![1, 2, 3]));
        assert!(start(&coordinator, "successor").is_ok());
    }

    #[test]
    fn dispatched_stop_preserves_audio_before_its_blocking_worker_runs() {
        use std::sync::mpsc;
        let coordinator = Arc::new(RecordingOwnership::default());
        let window = coordinator.window(203);
        let token = coordinator.reserve("opening", &window).unwrap();
        let admission = coordinator
            .claim_admission("opening", &window, token)
            .unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let opener = {
            let coordinator = Arc::clone(&coordinator);
            let window = Arc::clone(&window);
            let admission = Arc::clone(&admission);
            let cancelled = Arc::clone(&cancelled);
            thread::spawn(move || {
                coordinator.start(
                    "opening",
                    &window,
                    token,
                    StartControl {
                        admission: Some(&admission),
                        cancelled: &cancelled,
                        wait: Duration::ZERO,
                    },
                    || {
                        entered_tx.send(()).unwrap();
                        release_rx.recv().unwrap();
                        Ok(())
                    },
                    || panic!("dispatched normal stop owns the audio"),
                )
            })
        };
        entered_rx.recv().unwrap();
        let other = coordinator.window(204);
        assert!(coordinator
            .note_scoped_normal_stop("opening", &other, token)
            .unwrap()
            .is_none());
        assert!(coordinator
            .note_scoped_normal_stop("opening", &window, token + 1)
            .unwrap()
            .is_none());
        assert_eq!(admission.normal_stop_requested.load(Ordering::SeqCst), 0);
        // Simulate the guard retiring the admission before stop reaches native.
        // Its opening owner still holds the exact admission identity.
        coordinator.finish_admission(&admission);
        let _intent = coordinator
            .note_scoped_normal_stop("opening", &window, token)
            .unwrap()
            .unwrap();
        assert_ne!(admission.normal_stop_requested.load(Ordering::SeqCst), 0);
        // The start guard then cancels while the stop worker is queued.
        cancelled.store(true, Ordering::SeqCst);
        assert!(coordinator
            .stop_admission(&admission, || -> (Result<(), String>, bool) {
                panic!("guard discarded a dispatched stop")
            })
            .is_some_and(|result| result.is_err()));
        release_tx.send(()).unwrap();
        assert!(opener.join().unwrap().is_ok());
        assert!(start(&coordinator, "successor").is_err());
        assert_eq!(
            coordinator
                .stop_or_cancel_scoped("opening", &window, token, || (Ok(vec![7, 8]), false))
                .unwrap(),
            Some(vec![7, 8])
        );
        assert!(start(&coordinator, "successor").is_ok());
    }

    #[test]
    fn abandoned_start_schedules_recovery_if_the_queued_stop_worker_fails() {
        let coordinator = RecordingOwnership::default();
        let window = coordinator.window(211);
        let token = coordinator.reserve("active", &window).unwrap();
        let admission = coordinator
            .claim_admission("active", &window, token)
            .unwrap();
        coordinator
            .start(
                "active",
                &window,
                token,
                StartControl {
                    admission: Some(&admission),
                    cancelled: &AtomicBool::new(false),
                    wait: Duration::ZERO,
                },
                || Ok(()),
                || true,
            )
            .unwrap();
        let intent = coordinator
            .note_scoped_normal_stop("active", &window, token)
            .unwrap()
            .unwrap();
        let cleanup_called = AtomicBool::new(false);
        let cleanup = coordinator.stop_admission(&admission, || {
            cleanup_called.store(true, Ordering::SeqCst);
            (Ok::<(), String>(()), false)
        });
        assert!(matches!(cleanup, Some(Err(_))));
        let retry = coordinator
            .begin_release_retry_admission(&admission)
            .unwrap();
        assert!(!coordinator.retry_release(&retry, |_| {
            cleanup_called.store(true, Ordering::SeqCst);
            (Ok::<(), String>(()), false)
        }));
        assert!(!cleanup_called.load(Ordering::SeqCst));
        drop(intent);
        assert!(coordinator.retry_release(&retry, |_| (Ok(()), false)));
    }

    #[test]
    fn normal_stop_registration_serializes_with_cleanup_reservation() {
        let coordinator = Arc::new(RecordingOwnership::default());
        let window = coordinator.window(209);
        let token = coordinator.reserve("active", &window).unwrap();
        let admission = coordinator
            .claim_admission("active", &window, token)
            .unwrap();
        let guard = coordinator.owner.lock().unwrap();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let worker = {
            let coordinator = Arc::clone(&coordinator);
            let window = Arc::clone(&window);
            std::thread::spawn(move || {
                started_tx.send(()).unwrap();
                let intent = coordinator
                    .note_scoped_normal_stop("active", &window, token)
                    .unwrap();
                done_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                drop(intent);
            })
        };
        started_rx.recv().unwrap();
        let completed_early = done_rx.recv_timeout(Duration::from_millis(100)).is_ok();
        let count_while_locked = admission.normal_stop_requested.load(Ordering::SeqCst);
        drop(guard);
        if !completed_early {
            done_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        }
        assert_eq!(admission.normal_stop_requested.load(Ordering::SeqCst), 1);
        release_tx.send(()).unwrap();
        worker.join().unwrap();
        assert!(!completed_early);
        assert_eq!(count_while_locked, 0);
    }

    #[test]
    fn failed_stop_does_not_clear_another_queued_stop_intent() {
        let coordinator = RecordingOwnership::default();
        let window = coordinator.window(208);
        let token = coordinator.reserve("active", &window).unwrap();
        let admission = coordinator
            .claim_admission("active", &window, token)
            .unwrap();
        coordinator
            .start(
                "active",
                &window,
                token,
                StartControl {
                    admission: Some(&admission),
                    cancelled: &AtomicBool::new(false),
                    wait: Duration::ZERO,
                },
                || Ok(()),
                || true,
            )
            .unwrap();
        coordinator.finish_admission(&admission);
        let first = coordinator
            .note_scoped_normal_stop("active", &window, token)
            .unwrap()
            .unwrap();
        let _second = coordinator
            .note_scoped_normal_stop("active", &window, token)
            .unwrap()
            .unwrap();
        assert!(coordinator
            .stop_or_cancel_scoped("active", &window, token, || (
                Err::<(), _>("failed".into()),
                true
            ))
            .is_err());
        drop(first);
        let retry = coordinator
            .begin_release_retry_admission(&admission)
            .unwrap();
        let cleanup_called = AtomicBool::new(false);
        assert!(!coordinator.retry_release(&retry, |_| {
            cleanup_called.store(true, Ordering::SeqCst);
            (Ok::<(), String>(()), false)
        }));
        assert!(!cleanup_called.load(Ordering::SeqCst));
        assert_eq!(
            coordinator
                .stop_scoped("active", &window, token, || (Ok(42), false))
                .unwrap(),
            42
        );
    }

    #[test]
    fn retiring_the_last_stop_intent_wakes_a_waiting_start() {
        use std::sync::mpsc;
        let coordinator = Arc::new(RecordingOwnership::default());
        let window = coordinator.window(209);
        let token = coordinator.reserve("active", &window).unwrap();
        let admission = coordinator
            .claim_admission("active", &window, token)
            .unwrap();
        coordinator
            .start(
                "active",
                &window,
                token,
                StartControl {
                    admission: Some(&admission),
                    cancelled: &AtomicBool::new(false),
                    wait: Duration::ZERO,
                },
                || Ok(()),
                || true,
            )
            .unwrap();
        let intent = coordinator
            .note_scoped_normal_stop("active", &window, token)
            .unwrap()
            .unwrap();
        assert!(coordinator
            .stop_scoped("active", &window, token, || (
                Err::<(), _>("failed".into()),
                true
            ))
            .is_err());
        let (entered_tx, entered_rx) = mpsc::channel();
        let (result_tx, result_rx) = mpsc::channel();
        let waiter = {
            let coordinator = Arc::clone(&coordinator);
            let window = Arc::clone(&window);
            thread::spawn(move || {
                entered_tx.send(()).unwrap();
                result_tx
                    .send(coordinator.start(
                        "next",
                        &window,
                        coordinator.generation(),
                        StartControl {
                            admission: None,
                            cancelled: &AtomicBool::new(false),
                            wait: Duration::from_secs(2),
                        },
                        || Ok(()),
                        || true,
                    ))
                    .unwrap();
            })
        };
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(result_rx.recv_timeout(Duration::from_millis(50)).is_err());
        drop(intent);
        let result = result_rx.recv_timeout(Duration::from_secs(1));
        waiter.join().unwrap();
        result.unwrap().unwrap();
        coordinator.stop("next", || (Ok(()), false)).unwrap();
    }

    #[test]
    fn stop_intent_is_retired_on_unwind_and_capacity_fails_closed() {
        let coordinator = RecordingOwnership::default();
        let window = coordinator.window(210);
        let token = coordinator.reserve("active", &window).unwrap();
        let admission = coordinator
            .claim_admission("active", &window, token)
            .unwrap();
        let intent = coordinator
            .note_scoped_normal_stop("active", &window, token)
            .unwrap()
            .unwrap();
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            let _intent = intent;
            panic!("simulated stop worker failure");
        }));
        assert_eq!(admission.normal_stop_requested.load(Ordering::SeqCst), 0);
        let mut intents: Vec<_> = (0..MAX_PENDING_NORMAL_STOPS)
            .map(|_| {
                coordinator
                    .note_scoped_normal_stop("active", &window, token)
                    .unwrap()
                    .unwrap()
            })
            .collect();
        assert!(coordinator
            .note_scoped_normal_stop("active", &window, token)
            .is_err());
        drop(intents.pop());
        intents.push(
            coordinator
                .note_scoped_normal_stop("active", &window, token)
                .unwrap()
                .unwrap(),
        );
        assert_eq!(
            admission.normal_stop_requested.load(Ordering::SeqCst),
            MAX_PENDING_NORMAL_STOPS
        );
        drop(intents);
        assert_eq!(admission.normal_stop_requested.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn normal_stop_marker_is_cleared_after_a_failed_stop() {
        let coordinator = RecordingOwnership::default();
        let window = coordinator.window(205);
        let token = coordinator.reserve("active", &window).unwrap();
        let admission = coordinator
            .claim_admission("active", &window, token)
            .unwrap();
        coordinator
            .start(
                "active",
                &window,
                token,
                StartControl {
                    admission: Some(&admission),
                    cancelled: &AtomicBool::new(false),
                    wait: Duration::ZERO,
                },
                || Ok(()),
                || true,
            )
            .unwrap();
        coordinator.finish_admission(&admission);
        let intent = coordinator
            .note_scoped_normal_stop("active", &window, token)
            .unwrap()
            .unwrap();
        assert!(coordinator
            .stop_or_cancel_scoped("active", &window, token, || (
                Err::<(), _>("failed".into()),
                true
            ))
            .is_err());
        drop(intent);
        assert_eq!(admission.normal_stop_requested.load(Ordering::SeqCst), 0);
        let retry = coordinator
            .begin_release_retry_admission(&admission)
            .unwrap();
        assert!(coordinator.retry_release(&retry, |_| (Ok(()), false)));
        assert!(start(&coordinator, "successor").is_ok());
    }

    #[test]
    fn stop_cancels_retired_admission_before_a_claimed_start_reserves_the_slot() {
        let coordinator = RecordingOwnership::default();
        let window = coordinator.window(207);
        let token = coordinator.reserve("opening", &window).unwrap();
        let admission = coordinator
            .claim_admission("opening", &window, token)
            .unwrap();
        // The start guard removes its admission before setting its own
        // cancellation flag. A stop arriving in that gap must cancel the
        // still-live admission, rather than returning while it can open later.
        coordinator.finish_admission(&admission);
        let _intent = coordinator
            .note_scoped_normal_stop("opening", &window, token)
            .unwrap()
            .unwrap();
        assert_eq!(
            coordinator
                .stop_or_cancel_scoped(
                    "opening",
                    &window,
                    token,
                    || -> (Result<(), String>, bool) { panic!("no stream has opened") },
                )
                .unwrap(),
            None
        );
        assert!(coordinator
            .start(
                "opening",
                &window,
                token,
                StartControl {
                    admission: Some(&admission),
                    cancelled: &AtomicBool::new(false),
                    wait: Duration::ZERO
                },
                || -> Result<(), String> { panic!("retired admission opened after stop") },
                || true,
            )
            .is_err());
        assert!(start(&coordinator, "successor").is_ok());
    }

    #[test]
    fn dispatched_stop_marker_uses_the_token_not_a_reused_owner_id() {
        let coordinator = RecordingOwnership::default();
        let window = coordinator.window(206);
        let old_token = coordinator.reserve("same", &window).unwrap();
        let old = coordinator
            .claim_admission("same", &window, old_token)
            .unwrap();
        coordinator
            .start(
                "same",
                &window,
                old_token,
                StartControl {
                    admission: Some(&old),
                    cancelled: &AtomicBool::new(false),
                    wait: Duration::ZERO,
                },
                || Ok(()),
                || true,
            )
            .unwrap();
        coordinator.finish_admission(&old);
        let new_token = coordinator.reserve("same", &window).unwrap();
        let new = coordinator
            .claim_admission("same", &window, new_token)
            .unwrap();
        let _intent = coordinator
            .note_scoped_normal_stop("same", &window, old_token)
            .unwrap();
        assert_ne!(old.normal_stop_requested.load(Ordering::SeqCst), 0);
        assert_eq!(new.normal_stop_requested.load(Ordering::SeqCst), 0);
        coordinator
            .stop_scoped("same", &window, old_token, || (Ok(()), false))
            .unwrap();
        coordinator
            .start(
                "same",
                &window,
                new_token,
                StartControl {
                    admission: Some(&new),
                    cancelled: &AtomicBool::new(false),
                    wait: Duration::ZERO,
                },
                || Ok(()),
                || true,
            )
            .unwrap();
        let _intent = coordinator
            .note_scoped_normal_stop("same", &window, old_token)
            .unwrap();
        assert_eq!(new.normal_stop_requested.load(Ordering::SeqCst), 0);
        coordinator
            .stop_scoped("same", &window, new_token, || (Ok(()), false))
            .unwrap();
    }

    #[test]
    fn a_panicking_open_wakes_the_normal_stop_and_keeps_its_audio() {
        use std::sync::mpsc;
        let coordinator = Arc::new(RecordingOwnership::default());
        let window = coordinator.window(202);
        let token = coordinator.reserve("opening", &window).unwrap();
        let admission = coordinator
            .claim_admission("opening", &window, token)
            .unwrap();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let opener = {
            let coordinator = Arc::clone(&coordinator);
            let window = Arc::clone(&window);
            thread::spawn(move || {
                coordinator.start(
                    "opening",
                    &window,
                    token,
                    StartControl {
                        admission: Some(&admission),
                        cancelled: &AtomicBool::new(false),
                        wait: Duration::ZERO,
                    },
                    || -> Result<(), String> {
                        entered_tx.send(()).unwrap();
                        release_rx.recv().unwrap();
                        panic!("simulated open panic")
                    },
                    || panic!("normal stop owns audio even after an open panic"),
                )
            })
        };
        entered_rx.recv().unwrap();
        let stopper = {
            let coordinator = Arc::clone(&coordinator);
            let window = Arc::clone(&window);
            thread::spawn(move || {
                coordinator
                    .stop_or_cancel_scoped("opening", &window, token, || (Ok(vec![9]), false))
            })
        };
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let waiting = coordinator.owner.try_lock().ok().is_some_and(|owner| {
                owner
                    .as_ref()
                    .is_some_and(|owner| owner.normal_stop_waiters == 1)
            });
            if waiting {
                break;
            }
            if Instant::now() >= deadline {
                release_tx.send(()).unwrap();
                panic!("normal stop did not register");
            }
            thread::yield_now();
        }
        release_tx.send(()).unwrap();
        assert!(opener.join().is_err());
        assert_eq!(stopper.join().unwrap().unwrap(), Some(vec![9]));
        assert!(start(&coordinator, "successor").is_ok());
    }

    #[test]
    fn reset_during_open_fails_closed_until_late_open_is_released() {
        use std::sync::mpsc;
        let coordinator = Arc::new(RecordingOwnership::default());
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let stopped = Arc::new(AtomicBool::new(false));
        let opener = {
            let coordinator = Arc::clone(&coordinator);
            let stopped = Arc::clone(&stopped);
            thread::spawn(move || {
                coordinator.start(
                    "opening",
                    &Arc::new(RecordingWindow::default()),
                    coordinator.generation(),
                    StartControl {
                        admission: None,
                        cancelled: &AtomicBool::new(false),
                        wait: Duration::ZERO,
                    },
                    || {
                        entered_tx.send(()).unwrap();
                        release_rx.recv().unwrap();
                        Ok(())
                    },
                    || {
                        stopped.store(true, Ordering::SeqCst);
                        true
                    },
                )
            })
        };
        entered_rx.recv().unwrap();
        coordinator.begin_reset().unwrap();
        let (reset_tx, reset_rx) = mpsc::channel();
        let reset = {
            let coordinator = Arc::clone(&coordinator);
            thread::spawn(move || {
                let touched_driver = AtomicBool::new(false);
                let result = coordinator.force_stop(|| {
                    touched_driver.store(true, Ordering::SeqCst);
                    (Ok::<(), String>(()), false)
                });
                coordinator.end_reset();
                reset_tx
                    .send((result, touched_driver.load(Ordering::SeqCst)))
                    .unwrap();
            })
        };
        let prompt = reset_rx.recv_timeout(Duration::from_millis(500));
        let successor_while_open = if prompt.is_ok() {
            Some(start(&coordinator, "successor"))
        } else {
            None
        };
        release_tx.send(()).unwrap();
        assert!(opener.join().unwrap().is_err());
        reset.join().unwrap();
        let (result, touched_driver) = prompt.unwrap();
        assert!(result.is_err());
        assert!(!touched_driver);
        assert!(successor_while_open.unwrap().is_err());
        assert!(stopped.load(Ordering::SeqCst));
        assert!(start(&coordinator, "successor").is_ok());
    }

    #[test]
    fn external_capture_blocks_native_and_reset_until_its_own_release() {
        let ownership = RecordingOwnership::default();
        let window = ownership.window(1);
        let generation = ownership.reserve("browser", &window).unwrap();
        let admission = ownership
            .claim_admission("browser", &window, generation)
            .unwrap();
        ownership.start_external(&admission).unwrap();
        ownership.finish_admission(&admission);
        assert!(start(&ownership, "native").is_err());
        assert!(ownership
            .discard("browser", || -> (Result<(), String>, bool) {
                panic!("native stop must not release browser recognition")
            })
            .is_err());
        ownership.begin_reset().unwrap();
        assert!(ownership
            .force_stop(|| -> (Result<(), String>, bool) {
                panic!("reset must not assume browser recognition ended")
            })
            .is_err());
        ownership.release_external("other");
        assert!(ownership.reserve("blocked", &window).is_err());
        ownership.release_external("browser");
        assert!(ownership.reserve("still-blocked", &window).is_err());
        ownership.end_reset();
        assert!(start(&ownership, "native").is_ok());
    }

    #[test]
    fn cancelled_external_admission_cannot_start_late() {
        let ownership = RecordingOwnership::default();
        let window = ownership.window(1);
        let generation = ownership.reserve("browser", &window).unwrap();
        let admission = ownership
            .claim_admission("browser", &window, generation)
            .unwrap();
        ownership.release_external("browser");
        assert!(ownership.start_external(&admission).is_err());
        assert!(start(&ownership, "native").is_ok());
    }

    #[test]
    fn external_window_retirement_keeps_capture_until_confirmation() {
        let ownership = RecordingOwnership::default();
        let window = ownership.window(33);
        let generation = ownership.reserve("browser", &window).unwrap();
        let admission = ownership
            .claim_admission("browser", &window, generation)
            .unwrap();
        ownership.start_external(&admission).unwrap();
        ownership.finish_admission(&admission);
        let retired = ownership.close_window(33).unwrap();
        assert!(ownership
            .stop_window(&retired, || -> (Result<(), String>, bool) {
                panic!("retirement must not assume browser capture is stopped")
            })
            .unwrap()
            .is_err());
        assert!(start(&ownership, "native").is_err());
        ownership.release_external("browser");
        assert!(start(&ownership, "native").is_ok());
    }

    #[test]
    fn stale_claim_guard_cannot_release_a_successor_with_reused_id() {
        let ownership = RecordingOwnership::default();
        let window = ownership.window(34);
        let generation = ownership.reserve("browser", &window).unwrap();
        let old = ownership
            .claim_admission("browser", &window, generation)
            .unwrap();
        ownership.start_external(&old).unwrap();
        ownership.finish_admission(&old);
        ownership.release_external("browser");
        let generation = ownership.reserve("browser", &window).unwrap();
        let successor = ownership
            .claim_admission("browser", &window, generation)
            .unwrap();
        ownership.start_external(&successor).unwrap();
        ownership.finish_admission(&successor);
        ownership.release_external_admission(&old);
        assert!(start(&ownership, "native").is_err());
        ownership.release_external("browser");
        assert!(start(&ownership, "native").is_ok());
    }

    #[test]
    fn release_waits_for_level_delivery_and_retires_old_callback() {
        use std::sync::mpsc;

        let coordinator = Arc::new(RecordingOwnership::default());
        let window = coordinator.window(18);
        let generation = coordinator.reserve("levels", &window).unwrap();
        let admission = coordinator
            .claim_admission("levels", &window, generation)
            .unwrap();
        coordinator
            .start(
                "levels",
                &window,
                generation,
                StartControl {
                    cancelled: &AtomicBool::new(false),
                    admission: Some(&admission),
                    wait: Duration::ZERO,
                },
                || Ok(()),
                || true,
            )
            .unwrap();

        let (entered_tx, entered_rx) = mpsc::channel();
        let (continue_tx, continue_rx) = mpsc::channel();
        let emitter_admission = Arc::clone(&admission);
        let emitter = thread::spawn(move || {
            emitter_admission.with_active_level_callback(|| {
                entered_tx.send(()).unwrap();
                continue_rx.recv().unwrap();
            });
        });
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let (stopped_tx, stopped_rx) = mpsc::channel();
        let stopping = Arc::clone(&coordinator);
        let stopper = thread::spawn(move || {
            stopping.stop("levels", || (Ok(()), false)).unwrap();
            stopped_tx.send(()).unwrap();
        });
        assert!(stopped_rx.recv_timeout(Duration::from_millis(50)).is_err());
        continue_tx.send(()).unwrap();
        stopped_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        emitter.join().unwrap();
        stopper.join().unwrap();
        admission.with_active_level_callback(|| panic!("retired level callback ran"));
        start(&coordinator, "successor").unwrap();
        admission.with_active_level_callback(|| panic!("old callback reached successor"));
    }

    #[test]
    fn discarded_admission_cannot_start_when_ipc_arrives_late() {
        let coordinator = RecordingOwnership::default();
        let window = coordinator.window(11);
        let generation = coordinator.reserve("late", &window).unwrap();
        coordinator.cancel_admission("late");
        assert!(coordinator
            .claim_admission("late", &window, generation)
            .is_err());
        coordinator
            .discard("late", || -> (Result<(), String>, bool) {
                panic!("late stream opened")
            })
            .unwrap();
    }

    #[test]
    fn reset_and_window_close_cancel_outstanding_admissions() {
        let coordinator = RecordingOwnership::default();
        let window = coordinator.window(11);
        let old = coordinator.reserve("old", &window).unwrap();
        coordinator.begin_reset().unwrap();
        coordinator.end_reset();
        assert!(coordinator.claim_admission("old", &window, old).is_err());
        let generation = coordinator.reserve("window", &window).unwrap();
        coordinator.close_window(11).unwrap();
        assert!(coordinator
            .claim_admission("window", &window, generation)
            .is_err());
        assert!(coordinator.reserve("closed", &window).is_err());
    }

    #[test]
    fn admission_is_one_use_and_is_bound_to_its_window() {
        let coordinator = RecordingOwnership::default();
        let window = coordinator.window(11);
        let other = coordinator.window(12);
        let generation = coordinator.reserve("a", &window).unwrap();
        assert!(coordinator.reserve("a", &window).is_err());
        assert!(coordinator
            .claim_admission("a", &other, generation)
            .is_err());
        let admission = coordinator
            .claim_admission("a", &window, generation)
            .unwrap();
        assert!(coordinator
            .claim_admission("a", &window, generation)
            .is_err());
        coordinator.finish_admission(&admission);
        assert!(coordinator
            .claim_admission("a", &window, generation)
            .is_err());
    }

    #[test]
    fn cancellation_during_open_releases_the_claimed_admission() {
        let coordinator = Arc::new(RecordingOwnership::default());
        let window = coordinator.window(11);
        let generation = coordinator.reserve("opening", &window).unwrap();
        let admission = coordinator
            .claim_admission("opening", &window, generation)
            .unwrap();
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let stopped = Arc::new(AtomicBool::new(false));
        let worker = {
            let coordinator = Arc::clone(&coordinator);
            let stopped = Arc::clone(&stopped);
            thread::spawn(move || {
                coordinator.start(
                    "opening",
                    &window,
                    generation,
                    StartControl {
                        cancelled: &AtomicBool::new(false),
                        admission: Some(&admission),
                        wait: Duration::ZERO,
                    },
                    || {
                        entered_tx.send(()).unwrap();
                        release_rx.recv().unwrap();
                        Ok(())
                    },
                    || {
                        stopped.store(true, Ordering::SeqCst);
                        true
                    },
                )
            })
        };
        entered_rx.recv().unwrap();
        coordinator.cancel_admission("opening");
        release_tx.send(()).unwrap();
        assert!(worker.join().unwrap().is_err());
        assert!(stopped.load(Ordering::SeqCst));
        start(&coordinator, "new").unwrap();
    }

    #[test]
    fn cancelled_guard_cannot_stop_a_reused_owner_id() {
        let coordinator = RecordingOwnership::default();
        let window = coordinator.window(11);
        let generation = coordinator.reserve("same", &window).unwrap();
        let old = coordinator
            .claim_admission("same", &window, generation)
            .unwrap();
        coordinator
            .start(
                "same",
                &window,
                generation,
                StartControl {
                    cancelled: &AtomicBool::new(false),
                    admission: Some(&old),
                    wait: Duration::ZERO,
                },
                || Ok(()),
                || true,
            )
            .unwrap();
        coordinator.stop("same", || (Ok(()), false)).unwrap();
        coordinator.finish_admission(&old);
        let generation = coordinator.reserve("same", &window).unwrap();
        let new = coordinator
            .claim_admission("same", &window, generation)
            .unwrap();
        coordinator
            .start(
                "same",
                &window,
                generation,
                StartControl {
                    cancelled: &AtomicBool::new(false),
                    admission: Some(&new),
                    wait: Duration::ZERO,
                },
                || Ok(()),
                || true,
            )
            .unwrap();
        assert!(coordinator
            .stop_admission(&old, || -> (Result<(), String>, bool) {
                panic!("old guard stopped successor")
            })
            .is_none());
        coordinator.stop("same", || (Ok(()), false)).unwrap();
        coordinator.finish_admission(&new);
    }

    #[test]
    fn expired_claimed_admission_remains_addressable_for_normal_stop() {
        let coordinator = RecordingOwnership::default();
        let window = coordinator.window(11);
        let token = coordinator.reserve("old", &window).unwrap();
        let admission = {
            let mut admissions = coordinator.admissions.lock().unwrap();
            let admission = admissions.get_mut("old").unwrap();
            let unique = Arc::get_mut(admission).unwrap();
            unique.claimed.store(true, Ordering::SeqCst);
            unique.created = Instant::now() - ADMISSION_LIFETIME;
            Arc::clone(admission)
        };
        coordinator
            .start(
                "old",
                &window,
                token,
                StartControl {
                    cancelled: &AtomicBool::new(false),
                    admission: Some(&admission),
                    wait: Duration::ZERO,
                },
                || Ok(()),
                || true,
            )
            .unwrap();
        let successor_token = coordinator.reserve("old", &window).unwrap();
        let successor = coordinator
            .claim_admission("old", &window, successor_token)
            .unwrap();
        assert!(coordinator
            .note_scoped_normal_stop("old", &coordinator.window(12), token)
            .unwrap()
            .is_none());
        assert_eq!(admission.normal_stop_requested.load(Ordering::SeqCst), 0);
        let _intent = coordinator
            .note_scoped_normal_stop("old", &window, token)
            .unwrap()
            .unwrap();
        assert_ne!(admission.normal_stop_requested.load(Ordering::SeqCst), 0);
        assert_eq!(successor.normal_stop_requested.load(Ordering::SeqCst), 0);
        let cleanup_called = AtomicBool::new(false);
        assert!(coordinator
            .stop_admission(&admission, || {
                cleanup_called.store(true, Ordering::SeqCst);
                (Ok::<(), String>(()), false)
            })
            .is_some_and(|result| result.is_err()));
        assert!(!cleanup_called.load(Ordering::SeqCst));
        assert_eq!(
            coordinator
                .stop_scoped("old", &window, token, || (Ok(42), false))
                .unwrap(),
            42
        );
    }

    #[test]
    fn new_start_retries_only_an_explicitly_released_owner() {
        let coordinator = RecordingOwnership::default();
        let window = Arc::new(RecordingWindow::default());
        start(&coordinator, "old").unwrap();
        let cancelled = AtomicBool::new(false);
        let recovery_called = AtomicBool::new(false);
        let attempt = || {
            coordinator.start(
                "new",
                &window,
                coordinator.generation(),
                StartControl {
                    admission: None,
                    cancelled: &cancelled,
                    wait: Duration::ZERO,
                },
                || Ok(()),
                || {
                    recovery_called.store(true, Ordering::SeqCst);
                    true
                },
            )
        };
        assert!(attempt().is_err());
        assert!(!recovery_called.load(Ordering::SeqCst));
        assert!(coordinator
            .stop("old", || (Err::<(), _>("temporary failure".into()), true))
            .is_err());
        attempt().unwrap();
        assert!(recovery_called.load(Ordering::SeqCst));
        assert!(coordinator
            .stop("old", || -> (Result<(), String>, bool) {
                panic!("stale cleanup")
            })
            .is_err());
        coordinator.stop("new", || (Ok(()), false)).unwrap();
    }

    #[test]
    fn unsuccessful_recovery_keeps_owner_and_blocks_new_stream() {
        let coordinator = RecordingOwnership::default();
        start(&coordinator, "old").unwrap();
        assert!(coordinator
            .stop("old", || (Err::<(), _>("stop failed".into()), true))
            .is_err());
        let opened = AtomicBool::new(false);
        let result = coordinator.start(
            "new",
            &Arc::new(RecordingWindow::default()),
            coordinator.generation(),
            StartControl {
                admission: None,
                cancelled: &AtomicBool::new(false),
                wait: Duration::ZERO,
            },
            || {
                opened.store(true, Ordering::SeqCst);
                Ok(())
            },
            || false,
        );
        assert!(result.is_err());
        assert!(!opened.load(Ordering::SeqCst));
        coordinator.stop("old", || (Ok(()), false)).unwrap();
        start(&coordinator, "new").unwrap();
    }

    #[test]
    fn cancelled_waiter_does_not_recover_another_owner() {
        let coordinator = RecordingOwnership::default();
        start(&coordinator, "old").unwrap();
        assert!(coordinator
            .stop("old", || (Err::<(), _>("stop failed".into()), true))
            .is_err());
        let result = coordinator.start(
            "new",
            &Arc::new(RecordingWindow::default()),
            coordinator.generation(),
            StartControl {
                admission: None,
                cancelled: &AtomicBool::new(true),
                wait: Duration::ZERO,
            },
            || -> Result<(), String> { panic!("cancelled start") },
            || -> bool { panic!("cancelled recovery") },
        );
        assert!(result.is_err());
        coordinator.stop("old", || (Ok(()), false)).unwrap();
    }

    #[test]
    fn retry_worker_is_unique_and_cannot_stop_a_successor() {
        let coordinator = RecordingOwnership::default();
        start(&coordinator, "old").unwrap();
        assert!(coordinator.begin_release_retry("old").is_none());
        assert!(coordinator
            .stop("old", || (Err::<(), _>("failure".into()), true))
            .is_err());
        let retry = coordinator.begin_release_retry("old").unwrap();
        assert!(coordinator.begin_release_retry("old").is_none());
        assert!(!coordinator.retry_release(&retry, |_| (Err::<(), _>("still active".into()), true)));
        assert!(coordinator.retry_release(&retry, |_| (
            Err::<(), _>("released with error".into()),
            false
        )));
        start(&coordinator, "new").unwrap();
        assert!(
            coordinator.retry_release(&retry, |_| -> (Result<(), String>, bool) {
                panic!("successor stopped")
            })
        );
        coordinator.end_release_retry(&retry);
        coordinator.stop("new", || (Ok(()), false)).unwrap();
    }

    #[test]
    fn stale_discard_is_idempotent_and_never_touches_successor() {
        let coordinator = RecordingOwnership::default();
        coordinator
            .discard("old", || -> (Result<(), String>, bool) {
                panic!("no owner")
            })
            .unwrap();
        start(&coordinator, "old").unwrap();
        coordinator.discard("old", || (Ok(()), false)).unwrap();
        start(&coordinator, "new").unwrap();
        coordinator
            .discard("old", || -> (Result<(), String>, bool) {
                panic!("successor")
            })
            .unwrap();
        coordinator.stop("new", || (Ok(()), false)).unwrap();
    }

    #[test]
    fn stale_owner_cannot_stop_or_control_successor() {
        let coordinator = RecordingOwnership::default();
        start(&coordinator, "old").unwrap();
        coordinator.stop("old", || (Ok(()), false)).unwrap();
        start(&coordinator, "new").unwrap();
        assert!(coordinator
            .stop("old", || -> (Result<(), String>, bool) {
                panic!("stale stop")
            })
            .is_err());
        assert!(coordinator
            .use_recording("old", || -> Result<(), String> { panic!("stale action") })
            .is_err());
        coordinator.use_recording("new", || Ok(())).unwrap();
        coordinator.stop("new", || (Ok(()), false)).unwrap();
    }

    #[test]
    fn concurrent_starts_do_not_share_a_recording() {
        let coordinator = Arc::new(RecordingOwnership::default());
        let barrier = Arc::new(Barrier::new(3));
        let threads: Vec<_> = ["a", "b"]
            .into_iter()
            .map(|id| {
                let coordinator = Arc::clone(&coordinator);
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    barrier.wait();
                    start(&coordinator, id)
                })
            })
            .collect();
        barrier.wait();
        assert_eq!(
            threads
                .into_iter()
                .map(|thread| thread.join().unwrap())
                .filter(Result::is_ok)
                .count(),
            1
        );
    }

    #[test]
    fn waiting_start_acquires_only_after_the_other_owner_releases() {
        use std::sync::mpsc;
        let coordinator = Arc::new(RecordingOwnership::default());
        start(&coordinator, "test").unwrap();
        let (attempt_tx, attempt_rx) = mpsc::channel();
        let (opened_tx, opened_rx) = mpsc::channel();
        let worker = {
            let coordinator = Arc::clone(&coordinator);
            thread::spawn(move || {
                attempt_tx.send(()).unwrap();
                coordinator.start(
                    "dictation",
                    &Arc::new(RecordingWindow::default()),
                    coordinator.generation(),
                    StartControl {
                        admission: None,
                        cancelled: &AtomicBool::new(false),
                        wait: Duration::from_secs(2),
                    },
                    || {
                        opened_tx.send(()).unwrap();
                        Ok(())
                    },
                    || true,
                )
            })
        };
        attempt_rx.recv().unwrap();
        assert!(opened_rx.try_recv().is_err());
        coordinator.stop("test", || (Ok(()), false)).unwrap();
        worker.join().unwrap().unwrap();
        opened_rx.recv().unwrap();
        coordinator.stop("dictation", || (Ok(()), false)).unwrap();
    }

    #[test]
    fn waiting_start_times_out_without_touching_the_current_owner() {
        let coordinator = RecordingOwnership::default();
        start(&coordinator, "test").unwrap();
        let result = coordinator.start(
            "dictation",
            &Arc::new(RecordingWindow::default()),
            coordinator.generation(),
            StartControl {
                admission: None,
                cancelled: &AtomicBool::new(false),
                wait: Duration::from_millis(20),
            },
            || -> Result<(), String> { panic!("competing capture opened") },
            || true,
        );
        assert!(result.is_err());
        coordinator.stop("test", || (Ok(()), false)).unwrap();
    }

    #[test]
    fn panic_during_start_preserves_owner_for_cleanup() {
        let coordinator = RecordingOwnership::default();
        let result = std::panic::catch_unwind(|| {
            coordinator.start(
                "a",
                &Arc::new(RecordingWindow::default()),
                coordinator.generation(),
                StartControl {
                    admission: None,
                    cancelled: &AtomicBool::new(false),
                    wait: Duration::ZERO,
                },
                || -> Result<(), String> { panic!("start failed") },
                || true,
            )
        });
        assert!(result.is_err());
        assert!(start(&coordinator, "b").is_err());
        coordinator.stop("a", || (Ok(()), false)).unwrap();
        start(&coordinator, "b").unwrap();
    }

    #[test]
    fn stop_error_only_retains_a_live_stream() {
        let coordinator = RecordingOwnership::default();
        start(&coordinator, "a").unwrap();
        assert!(coordinator
            .stop("a", || (Err::<(), _>("failure".into()), true))
            .is_err());
        assert!(start(&coordinator, "b").is_err());
        assert!(coordinator
            .stop("a", || (Err::<(), _>("failure".into()), false))
            .is_err());
        start(&coordinator, "b").unwrap();
    }

    #[test]
    fn a_successful_stop_cannot_claim_a_live_stream_was_released() {
        let coordinator = RecordingOwnership::default();
        start(&coordinator, "a").unwrap();
        assert!(coordinator.stop("a", || (Ok(()), true)).is_err());
        assert!(coordinator.force_stop(|| (Ok(()), true)).is_err());
        assert!(start(&coordinator, "b").is_err());
        coordinator.stop("a", || (Ok(()), false)).unwrap();
        start(&coordinator, "b").unwrap();
    }

    #[test]
    fn reset_invalidates_an_admitted_but_delayed_start() {
        let coordinator = RecordingOwnership::default();
        let old_generation = coordinator.admission_generation().unwrap();
        coordinator.begin_reset().unwrap();
        assert!(coordinator.admission_generation().is_err());
        coordinator.force_stop(|| (Ok(()), false)).unwrap();
        assert!(coordinator.admission_generation().is_err());
        coordinator.end_reset();
        assert_ne!(coordinator.admission_generation().unwrap(), old_generation);
        assert!(coordinator
            .start(
                "old",
                &Arc::new(RecordingWindow::default()),
                old_generation,
                StartControl {
                    admission: None,
                    cancelled: &AtomicBool::new(false),
                    wait: Duration::ZERO
                },
                || -> Result<(), String> { panic!("stale start") },
                || true
            )
            .is_err());
        start(&coordinator, "new").unwrap();
    }

    #[test]
    fn reset_during_a_blocking_start_releases_it_before_reset_finishes() {
        use std::sync::mpsc;
        let coordinator = Arc::new(RecordingOwnership::default());
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let stopped = Arc::new(AtomicBool::new(false));
        let worker = {
            let coordinator = Arc::clone(&coordinator);
            let stopped = Arc::clone(&stopped);
            thread::spawn(move || {
                coordinator.start(
                    "a",
                    &Arc::new(RecordingWindow::default()),
                    coordinator.generation(),
                    StartControl {
                        admission: None,
                        cancelled: &AtomicBool::new(false),
                        wait: Duration::ZERO,
                    },
                    || {
                        entered_tx.send(()).unwrap();
                        release_rx.recv().unwrap();
                        Ok(())
                    },
                    || {
                        stopped.store(true, Ordering::SeqCst);
                        true
                    },
                )
            })
        };
        entered_rx.recv().unwrap();
        coordinator.begin_reset().unwrap();
        release_tx.send(()).unwrap();
        assert!(worker.join().unwrap().is_err());
        assert!(stopped.load(Ordering::SeqCst));
        coordinator.force_stop(|| (Ok(()), false)).unwrap();
        coordinator.end_reset();
        start(&coordinator, "b").unwrap();
    }

    #[test]
    fn destroyed_window_cannot_stop_a_successor_with_a_reused_key() {
        let coordinator = RecordingOwnership::default();
        let old = coordinator.window(42);
        coordinator
            .start(
                "old",
                &old,
                coordinator.generation(),
                StartControl {
                    admission: None,
                    cancelled: &AtomicBool::new(false),
                    wait: Duration::ZERO,
                },
                || Ok(()),
                || true,
            )
            .unwrap();
        let closed = coordinator.close_window(42).unwrap();
        coordinator
            .stop_window(&closed, || (Ok(()), false))
            .unwrap()
            .unwrap();
        let new = coordinator.window(42);
        coordinator
            .start(
                "new",
                &new,
                coordinator.generation(),
                StartControl {
                    admission: None,
                    cancelled: &AtomicBool::new(false),
                    wait: Duration::ZERO,
                },
                || Ok(()),
                || true,
            )
            .unwrap();
        assert!(coordinator
            .stop_window(&closed, || -> (Result<(), String>, bool) {
                panic!("old cleanup stopped a successor")
            })
            .is_none());
        assert!(coordinator
            .start(
                "stale",
                &old,
                coordinator.generation(),
                StartControl {
                    admission: None,
                    cancelled: &AtomicBool::new(false),
                    wait: Duration::ZERO
                },
                || -> Result<(), String> { panic!("closed window started") },
                || true
            )
            .is_err());
        coordinator.stop("new", || (Ok(()), false)).unwrap();
    }

    #[test]
    fn destroyed_window_cancels_a_blocking_start_without_blocking_event_thread() {
        use std::sync::mpsc;
        let coordinator = Arc::new(RecordingOwnership::default());
        let window = coordinator.window(17);
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let stopped = Arc::new(AtomicBool::new(false));
        let worker = {
            let coordinator = Arc::clone(&coordinator);
            let window = Arc::clone(&window);
            let stopped = Arc::clone(&stopped);
            thread::spawn(move || {
                coordinator.start(
                    "old",
                    &window,
                    coordinator.generation(),
                    StartControl {
                        admission: None,
                        cancelled: &AtomicBool::new(false),
                        wait: Duration::ZERO,
                    },
                    || {
                        entered_tx.send(()).unwrap();
                        release_rx.recv().unwrap();
                        Ok(())
                    },
                    || {
                        stopped.store(true, Ordering::SeqCst);
                        true
                    },
                )
            })
        };
        entered_rx.recv().unwrap();
        let closed = coordinator.close_window(17).unwrap();
        release_tx.send(()).unwrap();
        assert!(worker.join().unwrap().is_err());
        assert!(stopped.load(Ordering::SeqCst));
        assert!(coordinator
            .stop_window(&closed, || -> (Result<(), String>, bool) {
                panic!("already released")
            })
            .is_none());
        start(&coordinator, "new").unwrap();
    }

    #[test]
    fn reused_id_cannot_claim_cancel_or_control_a_new_admission() {
        let coordinator = RecordingOwnership::default();
        let window = coordinator.window(77);
        let other_window = coordinator.window(78);
        let old = coordinator.reserve("reused", &window).unwrap();
        coordinator.cancel_scoped_admission("reused", &window, old);
        let new = coordinator.reserve("reused", &window).unwrap();
        assert_ne!(old, new);
        assert!(coordinator.claim_admission("reused", &window, old).is_err());
        coordinator.cancel_scoped_admission("reused", &window, old);
        coordinator.cancel_scoped_admission("reused", &other_window, new);
        let admission = coordinator.claim_admission("reused", &window, new).unwrap();
        coordinator
            .start(
                "reused",
                &window,
                new,
                StartControl {
                    admission: Some(&admission),
                    cancelled: &AtomicBool::new(false),
                    wait: Duration::ZERO,
                },
                || Ok(()),
                || true,
            )
            .unwrap();
        coordinator.finish_admission(&admission);
        assert!(coordinator
            .stop_scoped("reused", &window, old, || -> (Result<(), String>, bool) {
                panic!("old stop touched successor")
            })
            .is_err());
        assert!(coordinator
            .stop_scoped(
                "reused",
                &other_window,
                new,
                || -> (Result<(), String>, bool) { panic!("other window stopped successor") }
            )
            .is_err());
        coordinator
            .discard_scoped(
                "reused",
                &other_window,
                new,
                || -> (Result<(), String>, bool) { panic!("other window discarded successor") },
            )
            .unwrap();
        assert!(coordinator
            .use_recording_scoped("reused", &other_window, new, || -> Result<(), String> {
                panic!("other window controlled successor")
            })
            .is_err());
        assert!(coordinator
            .use_recording_scoped("reused", &window, old, || -> Result<(), String> {
                panic!("old control touched successor")
            })
            .is_err());
        coordinator
            .discard_scoped("reused", &window, old, || -> (Result<(), String>, bool) {
                panic!("old discard touched successor")
            })
            .unwrap();
        coordinator
            .stop_scoped("reused", &window, new, || (Ok(()), false))
            .unwrap();
    }

    #[test]
    fn stale_external_release_cannot_release_reused_id() {
        let coordinator = RecordingOwnership::default();
        let window = coordinator.window(79);
        let old = coordinator.reserve("browser", &window).unwrap();
        let admission = coordinator
            .claim_admission("browser", &window, old)
            .unwrap();
        coordinator.start_external(&admission).unwrap();
        coordinator.finish_admission(&admission);
        coordinator.release_external_scoped("browser", &window, old);
        let new = coordinator.reserve("browser", &window).unwrap();
        let admission = coordinator
            .claim_admission("browser", &window, new)
            .unwrap();
        coordinator.start_external(&admission).unwrap();
        coordinator.finish_admission(&admission);
        coordinator.release_external_scoped("browser", &window, old);
        let other_window = coordinator.window(82);
        coordinator.release_external_scoped("browser", &other_window, new);
        assert!(start(&coordinator, "native").is_err());
        coordinator.release_external_scoped("browser", &window, new);
        assert!(start(&coordinator, "native").is_ok());
    }

    #[test]
    fn reset_does_not_reuse_admission_tokens() {
        let coordinator = RecordingOwnership::default();
        let window = coordinator.window(81);
        let old = coordinator.reserve("reused", &window).unwrap();
        coordinator.begin_reset().unwrap();
        coordinator.end_reset();
        let new = coordinator.reserve("reused", &window).unwrap();
        assert_ne!(old, new);
        assert!(coordinator.claim_admission("reused", &window, old).is_err());
        assert!(coordinator.claim_admission("reused", &window, new).is_ok());
    }

    #[test]
    fn admission_tokens_fail_closed_before_javascript_precision_is_lost() {
        let coordinator = RecordingOwnership::default();
        coordinator
            .next_token
            .store((1_u64 << 53) - 2, Ordering::SeqCst);
        let window = coordinator.window(80);
        assert_eq!(
            coordinator.reserve("last", &window).unwrap(),
            (1_u64 << 53) - 1
        );
        assert!(coordinator.reserve("overflow", &window).is_err());
    }

    #[test]
    fn a_reserved_retry_is_not_stolen_by_a_waiting_start() {
        let coordinator = RecordingOwnership::default();
        start(&coordinator, "owner").unwrap();
        assert!(coordinator
            .discard("owner", || (
                Err::<(), String>("release failed".into()),
                true
            ))
            .is_err());
        let retry = coordinator.begin_release_retry("owner").unwrap();
        let attempted = AtomicBool::new(false);
        let result = coordinator.start(
            "successor",
            &Arc::new(RecordingWindow::default()),
            coordinator.generation(),
            StartControl {
                admission: None,
                cancelled: &AtomicBool::new(false),
                wait: Duration::from_millis(20),
            },
            || -> Result<(), String> { panic!("successor opened before release") },
            || {
                attempted.store(true, Ordering::SeqCst);
                true
            },
        );
        assert!(result.is_err());
        assert!(!attempted.load(Ordering::SeqCst));
        assert!(coordinator.retry_release(&retry, |_| (Ok(()), false)));
        coordinator.end_release_retry(&retry);
        assert!(start(&coordinator, "successor").is_ok());
    }

    #[test]
    fn ending_a_retry_wakes_a_start_waiting_to_recover_the_owner() {
        use std::sync::mpsc;
        let coordinator = Arc::new(RecordingOwnership::default());
        start(&coordinator, "owner").unwrap();
        assert!(coordinator
            .discard("owner", || (
                Err::<(), String>("release failed".into()),
                true
            ))
            .is_err());
        let retry = coordinator.begin_release_retry("owner").unwrap();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let waiting = Arc::clone(&coordinator);
        let worker = thread::spawn(move || {
            entered_tx.send(()).unwrap();
            let result = waiting.start(
                "successor",
                &Arc::new(RecordingWindow::default()),
                waiting.generation(),
                StartControl {
                    admission: None,
                    cancelled: &AtomicBool::new(false),
                    wait: Duration::from_secs(2),
                },
                || Ok(()),
                || true,
            );
            done_tx.send(result).unwrap();
        });
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        // Give the waiting thread time to enter the condition variable; the
        // owner cannot be released while the retry reservation is installed.
        assert!(done_rx.recv_timeout(Duration::from_millis(30)).is_err());
        coordinator.end_release_retry(&retry);
        assert!(done_rx
            .recv_timeout(Duration::from_millis(500))
            .unwrap()
            .is_ok());
        worker.join().unwrap();
        coordinator.stop("successor", || (Ok(()), false)).unwrap();
    }

    fn admitted_recording(
        coordinator: &RecordingOwnership,
        id: &str,
        window: &Arc<RecordingWindow>,
    ) -> (u64, Arc<RecordingAdmission>) {
        let token = coordinator.reserve(id, window).unwrap();
        let admission = coordinator.claim_admission(id, window, token).unwrap();
        coordinator
            .start(
                id,
                window,
                token,
                StartControl {
                    admission: Some(&admission),
                    cancelled: &AtomicBool::new(false),
                    wait: Duration::ZERO,
                },
                || Ok(()),
                || true,
            )
            .unwrap();
        coordinator.finish_admission(&admission);
        (token, admission)
    }

    #[test]
    fn normal_stop_reply_can_be_replayed_until_scoped_discard() {
        let coordinator = RecordingOwnership::default();
        let window = coordinator.window(110);
        let other = coordinator.window(111);
        let (token, _admission) = admitted_recording(&coordinator, "old", &window);
        let first = coordinator
            .stop_or_recover_scoped("old", &window, token, || (Ok(vec![1, 2]), false))
            .unwrap()
            .unwrap();
        drop(first); // Simulate a reply that was lost after native stopped.
        let (new_token, _) = admitted_recording(&coordinator, "new", &window);
        assert!(coordinator
            .stop_or_recover_scoped("old", &other, token, || panic!("wrong window"))
            .is_err());
        assert_eq!(
            coordinator
                .stop_or_recover_scoped("old", &window, token, || panic!("retried driver stop"))
                .unwrap(),
            Some(Arc::new(vec![1, 2]))
        );
        coordinator.cancel_scoped_admission("old", &other, token);
        assert_eq!(
            coordinator
                .stop_or_recover_scoped("old", &window, token, || panic!("retried driver stop"))
                .unwrap(),
            Some(Arc::new(vec![1, 2]))
        );
        coordinator.cancel_scoped_admission("old", &window, token);
        assert!(coordinator.recovered.lock().unwrap().get(&token).is_none());
        assert_eq!(
            coordinator
                .stop_or_recover_scoped("new", &window, new_token, || (Ok(vec![3]), false))
                .unwrap(),
            Some(Arc::new(vec![3]))
        );
    }

    #[test]
    fn replay_limit_does_not_remove_audio_or_allow_wrong_scope_to_consume_it() {
        let coordinator = RecordingOwnership::default();
        let window = coordinator.window(116);
        let other = coordinator.window(117);
        let (token, _) = admitted_recording(&coordinator, "owner", &window);
        coordinator
            .stop_or_recover_scoped("owner", &window, token, || (Ok(vec![1]), false))
            .unwrap();
        for _ in 0..MAX_RECOVERY_REPLAYS {
            assert!(coordinator
                .stop_or_recover_scoped("owner", &other, token, || panic!("wrong window"))
                .is_err());
            assert_eq!(
                coordinator
                    .stop_or_recover_scoped("owner", &window, token, || panic!("retried driver"))
                    .unwrap(),
                Some(Arc::new(vec![1]))
            );
        }
        assert!(coordinator
            .stop_or_recover_scoped("owner", &window, token, || panic!("retried driver"))
            .unwrap_err()
            .contains("replay limit"));
        assert!(coordinator.recovered.lock().unwrap().contains_key(&token));
        coordinator.acknowledge_audio("owner", &window, token);
        assert!(coordinator.recovered.lock().unwrap().is_empty());
    }

    #[test]
    fn acknowledgement_clears_only_the_matching_recovery_without_stopping_capture() {
        let coordinator = RecordingOwnership::default();
        let window = coordinator.window(114);
        let other = coordinator.window(115);
        let (old_token, _) = admitted_recording(&coordinator, "old", &window);
        coordinator
            .stop_or_recover_scoped("old", &window, old_token, || (Ok(vec![1]), false))
            .unwrap();
        let (new_token, _) = admitted_recording(&coordinator, "new", &window);
        coordinator.acknowledge_audio("old", &other, old_token);
        coordinator.acknowledge_audio("wrong", &window, old_token);
        coordinator.acknowledge_audio("old", &window, new_token);
        assert_eq!(
            coordinator
                .stop_or_recover_scoped("old", &window, old_token, || panic!("retried driver stop"))
                .unwrap(),
            Some(Arc::new(vec![1]))
        );
        coordinator.acknowledge_audio("old", &window, old_token);
        assert!(coordinator
            .recovered
            .lock()
            .unwrap()
            .get(&old_token)
            .is_none());
        assert!(coordinator
            .stop_or_recover_scoped("old", &window, old_token, || panic!("stopped successor"))
            .is_err());
        assert_eq!(
            coordinator
                .stop_or_recover_scoped("new", &window, new_token, || (Ok(vec![2]), false))
                .unwrap(),
            Some(Arc::new(vec![2]))
        );
    }

    #[test]
    fn sealed_audio_replays_while_release_is_blocked_without_reopening_capture() {
        use std::sync::mpsc;
        let coordinator = Arc::new(RecordingOwnership::default());
        let window = coordinator.window(501);
        let (token, admission) = admitted_recording(&coordinator, "old", &window);
        assert_eq!(
            coordinator
                .stop_or_recover_scoped("old", &window, token, || (Ok(vec![3, 4]), true))
                .unwrap(),
            Some(Arc::new(vec![3, 4]))
        );
        let retry = coordinator
            .begin_release_retry_scoped("old", &window, token)
            .unwrap();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let worker = {
            let coordinator = Arc::clone(&coordinator);
            thread::spawn(move || {
                coordinator.retry_release(&retry, |handoff_complete| {
                    assert!(
                        handoff_complete,
                        "release retry must discard, not recache audio"
                    );
                    entered_tx.send(()).unwrap();
                    release_rx.recv_timeout(Duration::from_secs(2)).unwrap();
                    (Ok::<(), String>(()), false)
                })
            })
        };
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(start(&coordinator, "successor").is_err());
        assert_eq!(
            coordinator
                .stop_or_recover_scoped("old", &window, token, || panic!(
                    "replay touched the driver"
                ))
                .unwrap(),
            Some(Arc::new(vec![3, 4]))
        );
        coordinator.acknowledge_audio("old", &window, token);
        assert!(coordinator
            .stop_or_recover_scoped("old", &window, token, || panic!(
                "acknowledged audio stopped the driver"
            ))
            .is_err());
        assert!(coordinator
            .stop_admission(&admission, || -> (Result<(), String>, bool) {
                panic!("old start guard must not recache the result")
            })
            .is_some_and(|result| result.is_err()));
        release_tx.send(()).unwrap();
        assert!(worker.join().unwrap());
        assert!(coordinator.recovered.lock().unwrap().is_empty());
        assert!(start(&coordinator, "successor").is_ok());
    }

    #[test]
    fn concurrent_normal_stop_replays_the_sealed_handoff() {
        use std::sync::mpsc;
        let coordinator = Arc::new(RecordingOwnership::default());
        let window = coordinator.window(503);
        let (token, _) = admitted_recording(&coordinator, "old", &window);
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let first = {
            let coordinator = Arc::clone(&coordinator);
            let window = Arc::clone(&window);
            thread::spawn(move || {
                coordinator.stop_or_recover_scoped("old", &window, token, || {
                    entered_tx.send(()).unwrap();
                    release_rx.recv_timeout(Duration::from_secs(2)).unwrap();
                    (Ok(vec![8]), true)
                })
            })
        };
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let second = {
            let coordinator = Arc::clone(&coordinator);
            let window = Arc::clone(&window);
            thread::spawn(move || {
                coordinator.stop_or_recover_scoped("old", &window, token, || {
                    panic!("second stop touched driver")
                })
            })
        };
        release_tx.send(()).unwrap();
        assert_eq!(first.join().unwrap().unwrap(), Some(Arc::new(vec![8])));
        assert_eq!(second.join().unwrap().unwrap(), Some(Arc::new(vec![8])));
        assert!(start(&coordinator, "successor").is_err());
    }

    #[test]
    fn abandoned_cleanup_can_handoff_audio_before_a_blocked_release() {
        use std::sync::mpsc;
        let coordinator = Arc::new(RecordingOwnership::default());
        let window = coordinator.window(601);
        let (token, admission) = admitted_recording(&coordinator, "old", &window);
        let (entered_tx, entered_rx) = mpsc::channel();
        let (seal_tx, seal_rx) = mpsc::channel();
        let cleanup = {
            let coordinator = Arc::clone(&coordinator);
            let admission = Arc::clone(&admission);
            thread::spawn(move || {
                coordinator.stop_admission_with_recovery(&admission, || {
                    entered_tx.send(()).unwrap();
                    seal_rx.recv_timeout(Duration::from_secs(2)).unwrap();
                    assert!(coordinator.retain_recording_audio(&admission, Arc::new(vec![6, 1])));
                    RecoveryStop::Sealed
                })
            })
        };
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let intent = coordinator
            .note_scoped_normal_stop("old", &window, token)
            .unwrap()
            .unwrap();
        let normal = {
            let coordinator = Arc::clone(&coordinator);
            let window = Arc::clone(&window);
            thread::spawn(move || {
                let _intent = intent;
                coordinator.stop_or_recover_scoped("old", &window, token, || {
                    panic!("sealed cleanup was stopped again")
                })
            })
        };
        seal_tx.send(()).unwrap();
        assert!(cleanup.join().unwrap().unwrap().is_err());
        assert_eq!(normal.join().unwrap().unwrap(), Some(Arc::new(vec![6, 1])));
        assert!(start(&coordinator, "successor").is_err());
        coordinator.acknowledge_audio("old", &window, token);
        let retry = coordinator
            .begin_release_retry_admission(&admission)
            .unwrap();
        assert!(coordinator.retry_release_with_recovery(&retry, |sealed| {
            assert!(sealed, "cleanup must discard, never recache, after handoff");
            RecoveryStop::Released(Ok(()))
        }));
        assert!(coordinator.recovered.lock().unwrap().is_empty());
        assert!(start(&coordinator, "successor").is_ok());
    }

    #[test]
    fn cancelled_abandoned_handoff_cannot_publish_or_be_recached() {
        use std::sync::mpsc;
        let coordinator = Arc::new(RecordingOwnership::default());
        let window = coordinator.window(602);
        let (token, admission) = admitted_recording(&coordinator, "old", &window);
        let (entered_tx, entered_rx) = mpsc::channel();
        let (seal_tx, seal_rx) = mpsc::channel();
        let cleanup = {
            let coordinator = Arc::clone(&coordinator);
            let admission = Arc::clone(&admission);
            thread::spawn(move || {
                coordinator.stop_admission_with_recovery(&admission, || {
                    entered_tx.send(()).unwrap();
                    seal_rx.recv_timeout(Duration::from_secs(2)).unwrap();
                    assert!(!coordinator.retain_recording_audio(&admission, Arc::new(vec![6, 2])));
                    RecoveryStop::Sealed
                })
            })
        };
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        coordinator.cancel_scoped_admission("old", &window, token);
        seal_tx.send(()).unwrap();
        assert!(cleanup.join().unwrap().unwrap().is_err());
        assert!(coordinator
            .stop_or_recover_scoped("old", &window, token, || panic!(
                "cancelled handoff reused driver"
            ))
            .is_err());
        let retry = coordinator
            .begin_release_retry_admission(&admission)
            .unwrap();
        assert!(coordinator.retry_release_with_recovery(&retry, |sealed| {
            assert!(sealed);
            RecoveryStop::Released(Ok(()))
        }));
        assert!(coordinator.recovered.lock().unwrap().is_empty());
    }

    #[test]
    fn release_retry_can_seal_audio_and_next_retry_only_discards() {
        let coordinator = RecordingOwnership::default();
        let window = coordinator.window(603);
        let (token, admission) = admitted_recording(&coordinator, "old", &window);
        assert!(coordinator
            .stop_admission(&admission, || (Err::<(), _>("active".into()), true))
            .unwrap()
            .is_err());
        let retry = coordinator
            .begin_release_retry_admission(&admission)
            .unwrap();
        assert!(!coordinator.retry_release_with_recovery(&retry, |sealed| {
            assert!(!sealed);
            assert!(coordinator.retain_recording_audio(&admission, Arc::new(vec![6, 3])));
            RecoveryStop::Sealed
        }));
        assert_eq!(
            coordinator
                .stop_or_recover_scoped("old", &window, token, || panic!(
                    "retry already sealed audio"
                ))
                .unwrap(),
            Some(Arc::new(vec![6, 3]))
        );
        coordinator.acknowledge_audio("old", &window, token);
        assert!(coordinator.retry_release_with_recovery(&retry, |sealed| {
            assert!(sealed);
            RecoveryStop::Released(Ok(()))
        }));
        assert!(coordinator.recovered.lock().unwrap().is_empty());
    }

    #[test]
    fn failed_open_with_an_unreleased_candidate_keeps_its_owner_until_retry() {
        let coordinator = RecordingOwnership::default();
        let window = coordinator.window(605);
        let token = coordinator.reserve("old", &window).unwrap();
        let old = coordinator.claim_admission("old", &window, token).unwrap();
        let result = coordinator.start_with_recovery(
            "old",
            &window,
            token,
            StartControl {
                admission: Some(&old),
                cancelled: &AtomicBool::new(false),
                wait: Duration::ZERO,
            },
            || Err::<(), _>("play failed".into()),
            |admission| {
                assert!(Arc::ptr_eq(&admission.unwrap(), &old));
                assert!(coordinator.retain_recording_audio(&old, Arc::new(vec![1, 2])));
                RecoveryStop::Sealed
            },
        );
        assert_eq!(result.unwrap_err(), "play failed");
        let retry = coordinator.begin_release_retry_admission(&old).unwrap();
        assert!(!coordinator.retry_release_with_recovery(&retry, |sealed| {
            assert!(sealed);
            RecoveryStop::Pending("pause failed".into())
        }));
        let next_token = coordinator.reserve("next", &window).unwrap();
        let next = coordinator
            .claim_admission("next", &window, next_token)
            .unwrap();
        assert!(coordinator
            .start_with_recovery(
                "next",
                &window,
                next_token,
                StartControl {
                    admission: Some(&next),
                    cancelled: &AtomicBool::new(false),
                    wait: Duration::ZERO,
                },
                || -> Result<(), String> { panic!("candidate still owns the driver") },
                |_| panic!("retry already owns cleanup"),
            )
            .is_err());
        assert_eq!(
            coordinator
                .stop_or_recover_scoped("old", &window, token, || panic!("already sealed"))
                .unwrap(),
            Some(Arc::new(vec![1, 2]))
        );
        coordinator.acknowledge_audio("old", &window, token);
        assert!(coordinator.retry_release_with_recovery(&retry, |sealed| {
            assert!(sealed);
            RecoveryStop::Released(Ok(()))
        }));
        let successor = coordinator.reserve("successor", &window).unwrap();
        let admission = coordinator
            .claim_admission("successor", &window, successor)
            .unwrap();
        coordinator
            .start_with_recovery(
                "successor",
                &window,
                successor,
                StartControl {
                    admission: Some(&admission),
                    cancelled: &AtomicBool::new(false),
                    wait: Duration::ZERO,
                },
                || Ok(()),
                |_| panic!("old owner was released"),
            )
            .unwrap();
    }

    #[test]
    fn successor_cannot_enter_while_its_cleanup_seals_previous_audio() {
        let coordinator = RecordingOwnership::default();
        let window = coordinator.window(604);
        let (token, old) = admitted_recording(&coordinator, "old", &window);
        assert!(coordinator
            .stop_admission(&old, || (Err::<(), _>("active".into()), true))
            .unwrap()
            .is_err());
        let next_token = coordinator.reserve("next", &window).unwrap();
        let next = coordinator
            .claim_admission("next", &window, next_token)
            .unwrap();
        let opened = AtomicBool::new(false);
        let result = coordinator.start_with_recovery(
            "next",
            &window,
            next_token,
            StartControl {
                admission: Some(&next),
                cancelled: &AtomicBool::new(false),
                wait: Duration::ZERO,
            },
            || {
                opened.store(true, Ordering::SeqCst);
                Ok(())
            },
            |previous| {
                let previous = previous.unwrap();
                assert!(Arc::ptr_eq(&previous, &old));
                assert!(coordinator.retain_recording_audio(&previous, Arc::new(vec![6, 4])));
                RecoveryStop::Sealed
            },
        );
        assert!(result.is_err());
        assert!(!opened.load(Ordering::SeqCst));
        assert_eq!(
            coordinator
                .stop_or_recover_scoped("old", &window, token, || panic!(
                    "sealed audio already exists"
                ))
                .unwrap(),
            Some(Arc::new(vec![6, 4]))
        );
        coordinator.acknowledge_audio("old", &window, token);
        let retry = coordinator.begin_release_retry_admission(&old).unwrap();
        assert!(coordinator.retry_release_with_recovery(&retry, |sealed| {
            assert!(sealed);
            RecoveryStop::Released(Ok(()))
        }));
        assert!(coordinator.recovered.lock().unwrap().is_empty());
    }

    #[test]
    fn successor_cleanup_discards_after_a_sealed_handoff() {
        let coordinator = RecordingOwnership::default();
        let window = coordinator.window(502);
        let (token, _) = admitted_recording(&coordinator, "old", &window);
        coordinator
            .stop_or_recover_scoped("old", &window, token, || (Ok(vec![1]), true))
            .unwrap();
        coordinator.acknowledge_audio("old", &window, token);
        let next = coordinator.reserve("successor", &window).unwrap();
        let admission = coordinator
            .claim_admission("successor", &window, next)
            .unwrap();
        coordinator
            .start_with_recovery(
                "successor",
                &window,
                next,
                StartControl {
                    admission: Some(&admission),
                    cancelled: &AtomicBool::new(false),
                    wait: Duration::ZERO,
                },
                || Ok(()),
                |old_admission| {
                    assert!(
                        old_admission.is_none(),
                        "takeover must discard after handoff"
                    );
                    RecoveryStop::Released(Ok(()))
                },
            )
            .unwrap();
        assert!(coordinator.recovered.lock().unwrap().is_empty());
    }

    #[test]
    fn stop_failure_does_not_become_empty_success_on_retry() {
        let coordinator = RecordingOwnership::default();
        let window = coordinator.window(112);
        let (token, _admission) = admitted_recording(&coordinator, "old", &window);
        assert!(coordinator
            .stop_or_recover_scoped("old", &window, token, || (
                Err("driver failed".into()),
                false
            ))
            .is_err());
        assert!(coordinator
            .stop_or_recover_scoped("old", &window, token, || panic!("already stopped"))
            .is_err());
    }

    #[test]
    fn cancellation_during_a_normal_stop_does_not_retain_the_reply() {
        use std::sync::mpsc;
        let coordinator = Arc::new(RecordingOwnership::default());
        let window = coordinator.window(113);
        let (token, _admission) = admitted_recording(&coordinator, "old", &window);
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let worker = {
            let coordinator = Arc::clone(&coordinator);
            let window = Arc::clone(&window);
            thread::spawn(move || {
                coordinator.stop_or_recover_scoped("old", &window, token, || {
                    entered_tx.send(()).unwrap();
                    release_rx.recv_timeout(Duration::from_secs(2)).unwrap();
                    (Ok(vec![42]), false)
                })
            })
        };
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        coordinator.cancel_scoped_admission("old", &window, token);
        release_tx.send(()).unwrap();
        assert!(worker.join().unwrap().is_ok());
        assert!(coordinator.recovered.lock().unwrap().is_empty());
    }

    #[test]
    fn normal_stop_recovers_when_abandoned_cleanup_wins_before_ingress() {
        let coordinator = RecordingOwnership::default();
        let window = coordinator.window(101);
        let (token, admission) = admitted_recording(&coordinator, "old", &window);
        assert!(coordinator
            .stop_admission(&admission, || {
                assert!(coordinator.retain_recording_audio(&admission, Arc::new(vec![1, 2, 3])));
                (Ok::<(), String>(()), false)
            })
            .unwrap()
            .is_ok());
        // Reusing the textual owner cannot redirect the old recording to a new owner.
        let (new_token, _) = admitted_recording(&coordinator, "old", &window);
        let other = coordinator.window(102);
        assert!(coordinator
            .stop_or_recover_scoped("old", &other, token, || panic!(
                "wrong window stopped recorder"
            ))
            .is_err());
        let _intent = coordinator
            .note_scoped_normal_stop("old", &window, token)
            .unwrap()
            .unwrap();
        assert_eq!(
            coordinator
                .stop_or_recover_scoped("old", &window, token, || panic!(
                    "old stop touched successor"
                ))
                .unwrap(),
            Some(Arc::new(vec![1, 2, 3]))
        );
        assert_eq!(
            coordinator
                .stop_or_recover_scoped("old", &window, token, || panic!(
                    "old stop touched successor"
                ))
                .unwrap(),
            Some(Arc::new(vec![1, 2, 3]))
        );
        coordinator.cancel_scoped_admission("old", &window, token);
        assert!(coordinator.recovered.lock().unwrap().get(&token).is_none());
        assert_eq!(
            coordinator
                .stop_or_recover_scoped("old", &window, new_token, || (Ok(vec![4]), false))
                .unwrap(),
            Some(Arc::new(vec![4]))
        );
    }

    #[test]
    fn normal_stop_waiting_on_abandoned_cleanup_takes_its_audio() {
        use std::sync::mpsc;
        let coordinator = Arc::new(RecordingOwnership::default());
        let window = coordinator.window(103);
        let (token, admission) = admitted_recording(&coordinator, "old", &window);
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let cleanup = {
            let coordinator = Arc::clone(&coordinator);
            let admission = Arc::clone(&admission);
            thread::spawn(move || {
                coordinator.stop_admission(&admission, || {
                    entered_tx.send(()).unwrap();
                    release_rx.recv_timeout(Duration::from_secs(2)).unwrap();
                    assert!(coordinator.retain_recording_audio(&admission, Arc::new(vec![5, 6])));
                    (Ok::<(), String>(()), false)
                })
            })
        };
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let intent = coordinator
            .note_scoped_normal_stop("old", &window, token)
            .unwrap()
            .unwrap();
        let stopper = {
            let coordinator = Arc::clone(&coordinator);
            let window = Arc::clone(&window);
            thread::spawn(move || {
                let _intent = intent;
                coordinator.stop_or_recover_scoped("old", &window, token, || {
                    panic!("cleanup already stopped the driver")
                })
            })
        };
        let deadline = Instant::now() + Duration::from_secs(2);
        while coordinator
            .owner
            .lock()
            .unwrap()
            .as_ref()
            .is_none_or(|owner| owner.normal_stop_waiters != 1)
        {
            assert!(
                Instant::now() < deadline,
                "normal stop did not begin waiting"
            );
            thread::yield_now();
        }
        release_tx.send(()).unwrap();
        assert!(cleanup.join().unwrap().unwrap().is_ok());
        assert_eq!(stopper.join().unwrap().unwrap(), Some(Arc::new(vec![5, 6])));
    }

    #[test]
    fn explicit_retirement_clears_recovery_and_blocks_late_saves() {
        for mode in 0..3 {
            let coordinator = RecordingOwnership::default();
            let window = coordinator.window(104);
            let (token, admission) = admitted_recording(&coordinator, "old", &window);
            assert!(coordinator
                .stop_admission(&admission, || {
                    assert!(coordinator.retain_recording_audio(&admission, Arc::new(vec![9])));
                    (Ok::<(), String>(()), false)
                })
                .unwrap()
                .is_ok());
            match mode {
                0 => coordinator.cancel_scoped_admission("old", &window, token),
                1 => {
                    coordinator.close_window(104);
                }
                _ => {
                    coordinator.begin_reset().unwrap();
                    coordinator.end_reset();
                }
            }
            assert!(coordinator.recovered.lock().unwrap().is_empty());
            assert!(!coordinator.retain_recording_audio(&admission, Arc::new(vec![10])));
            assert!(coordinator
                .stop_or_recover_scoped("old", &window, token, || panic!("retired recorder used"))
                .unwrap()
                .is_none());
        }
    }

    #[test]
    fn cancellation_during_abandoned_driver_stop_prevents_late_retention() {
        use std::sync::mpsc;
        let coordinator = Arc::new(RecordingOwnership::default());
        let window = coordinator.window(108);
        let (token, admission) = admitted_recording(&coordinator, "old", &window);
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let cleanup = {
            let coordinator = Arc::clone(&coordinator);
            let admission = Arc::clone(&admission);
            thread::spawn(move || {
                coordinator.stop_admission(&admission, || {
                    entered_tx.send(()).unwrap();
                    release_rx.recv_timeout(Duration::from_secs(2)).unwrap();
                    assert!(!coordinator.retain_recording_audio(&admission, Arc::new(vec![1])));
                    (Ok::<(), String>(()), false)
                })
            })
        };
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        coordinator.cancel_scoped_admission("old", &window, token);
        release_tx.send(()).unwrap();
        assert!(cleanup.join().unwrap().unwrap().is_ok());
        assert!(coordinator.recovered.lock().unwrap().is_empty());
    }

    #[test]
    fn recovery_expires_and_is_bounded_without_evicting_live_audio() {
        let coordinator = RecordingOwnership::default();
        let window = coordinator.window(105);
        let (token, admission) = admitted_recording(&coordinator, "old", &window);
        coordinator
            .stop_admission(&admission, || {
                assert!(coordinator.retain_recording_audio(&admission, Arc::new(vec![7])));
                (Ok::<(), String>(()), false)
            })
            .unwrap()
            .unwrap();
        assert!(coordinator.start_recovery_reaper());
        assert!(!coordinator.start_recovery_reaper());
        assert!(coordinator.prune_recovered_audio());
        assert_eq!(coordinator.recovered.lock().unwrap().len(), 1);
        coordinator
            .recovered
            .lock()
            .unwrap()
            .get_mut(&token)
            .unwrap()
            .created = Instant::now() - RECOVERED_AUDIO_LIFETIME;
        assert!(!coordinator.prune_recovered_audio());
        assert!(!coordinator.start_recovery_reaper());
        assert!(coordinator.recovered.lock().unwrap().is_empty());
        assert!(!coordinator
            .retain_recording_audio(&admission, Arc::new(vec![0; MAX_RECOVERED_AUDIO_BYTES + 1])));
        assert!(coordinator
            .stop_or_recover_scoped("old", &window, token, || panic!("already stopped"))
            .is_err());
    }

    #[test]
    fn retry_worker_retains_audio_for_its_original_admission() {
        let coordinator = RecordingOwnership::default();
        let window = coordinator.window(109);
        let (token, admission) = admitted_recording(&coordinator, "old", &window);
        assert!(coordinator
            .stop_admission(&admission, || (Err::<(), String>("pending".into()), true))
            .unwrap()
            .is_err());
        let retry = coordinator
            .begin_release_retry_admission(&admission)
            .unwrap();
        assert!(coordinator.retry_release(&retry, |_| {
            let owner = retry.admission().unwrap();
            assert!(Arc::ptr_eq(owner, &admission));
            assert!(coordinator.retain_recording_audio(owner, Arc::new(vec![13])));
            (Ok::<(), String>(()), false)
        }));
        assert_eq!(
            coordinator
                .stop_or_recover_scoped("old", &window, token, || panic!("already stopped"))
                .unwrap(),
            Some(Arc::new(vec![13]))
        );
    }

    #[test]
    fn successor_recovery_preserves_previous_owners_admission() {
        let coordinator = RecordingOwnership::default();
        let window = coordinator.window(107);
        let (old_token, old) = admitted_recording(&coordinator, "old", &window);
        assert!(coordinator
            .stop_admission(&old, || (Err::<(), String>("pending".into()), true))
            .unwrap()
            .is_err());
        let new_token = coordinator.reserve("new", &window).unwrap();
        let new = coordinator
            .claim_admission("new", &window, new_token)
            .unwrap();
        coordinator
            .start_with_recovery(
                "new",
                &window,
                new_token,
                StartControl {
                    admission: Some(&new),
                    cancelled: &AtomicBool::new(false),
                    wait: Duration::ZERO,
                },
                || Ok(()),
                |previous| {
                    let previous = previous.unwrap();
                    assert!(Arc::ptr_eq(&previous, &old));
                    assert!(coordinator.retain_recording_audio(&previous, Arc::new(vec![11])));
                    RecoveryStop::Released(Ok(()))
                },
            )
            .unwrap();
        assert_eq!(
            coordinator
                .stop_or_recover_scoped("old", &window, old_token, || panic!(
                    "old stop touched successor"
                ))
                .unwrap(),
            Some(Arc::new(vec![11]))
        );
        assert_eq!(
            coordinator
                .stop_or_recover_scoped("new", &window, new_token, || (Ok(vec![12]), false))
                .unwrap(),
            Some(Arc::new(vec![12]))
        );
    }

    #[test]
    fn abandoned_open_recovers_only_its_own_cleanup() {
        let coordinator = RecordingOwnership::default();
        let window = coordinator.window(106);
        let token = coordinator.reserve("old", &window).unwrap();
        let admission = coordinator.claim_admission("old", &window, token).unwrap();
        let cancelled = AtomicBool::new(false);
        let result = coordinator.start_with_recovery(
            "old",
            &window,
            token,
            StartControl {
                admission: Some(&admission),
                cancelled: &cancelled,
                wait: Duration::ZERO,
            },
            || {
                cancelled.store(true, Ordering::SeqCst);
                Ok(())
            },
            |owner_admission| {
                assert!(Arc::ptr_eq(&owner_admission.unwrap(), &admission));
                assert!(coordinator.retain_recording_audio(&admission, Arc::new(vec![8])));
                RecoveryStop::Released(Ok(()))
            },
        );
        assert!(result.is_err());
        coordinator.finish_admission(&admission);
        assert_eq!(
            coordinator
                .stop_or_recover_scoped("old", &window, token, || panic!("already stopped"))
                .unwrap(),
            Some(Arc::new(vec![8]))
        );
    }

    #[test]
    fn cancelled_start_is_released_before_another_can_start() {
        let coordinator = RecordingOwnership::default();
        let cancelled = AtomicBool::new(false);
        let result = coordinator.start(
            "a",
            &Arc::new(RecordingWindow::default()),
            coordinator.generation(),
            StartControl {
                admission: None,
                cancelled: &cancelled,
                wait: Duration::ZERO,
            },
            || {
                cancelled.store(true, Ordering::SeqCst);
                Ok(())
            },
            || true,
        );
        assert!(result.is_err());
        start(&coordinator, "b").unwrap();
    }
}
