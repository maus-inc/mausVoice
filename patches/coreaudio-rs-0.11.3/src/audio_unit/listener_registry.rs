//! Non-reused identities for CoreAudio callbacks that may arrive late.
use std::any::Any;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

type State = dyn Any + Send + Sync;

fn entries() -> &'static Mutex<HashMap<usize, Arc<State>>> {
    static ENTRIES: OnceLock<Mutex<HashMap<usize, Arc<State>>>> = OnceLock::new();
    ENTRIES.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(super) fn insert<T: Any + Send + Sync>(state: Arc<T>) -> Option<usize> {
    static NEXT: AtomicUsize = AtomicUsize::new(1);
    let token = NEXT
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
        .ok()?;
    entries()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(token, state);
    Some(token)
}

pub(super) fn get<T: Any + Send + Sync>(token: usize) -> Option<Arc<T>> {
    entries()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(&token)
        .cloned()?
        .downcast::<T>()
        .ok()
}

pub(super) fn remove(token: usize) {
    let state = entries()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(&token);
    // Drop outside the registry lock, so a destructor cannot deadlock it.
    drop(state);
}

#[cfg(test)]
mod tests {
    use super::{get, insert, remove};
    use std::sync::Arc;

    #[test]
    fn retired_tokens_are_not_reused_and_inflight_state_stays_alive() {
        let original = Arc::new(17_u32);
        let token = insert(Arc::clone(&original)).unwrap();
        let inflight = get::<u32>(token).unwrap();
        assert!(get::<u64>(token).is_none());
        remove(token);
        assert!(get::<u32>(token).is_none());
        drop(original);
        assert_eq!(*inflight, 17);
        let next = insert(Arc::new(23_u32)).unwrap();
        assert_ne!(token, next);
        assert_eq!(*get::<u32>(next).unwrap(), 23);
        remove(next);
    }
}
