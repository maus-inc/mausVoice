//! Failed capture builds must not destroy a unit whose cleanup is uncertain.
use std::mem::ManuallyDrop;

pub(super) fn cleanup_failed_build<R, E>(
    resource: R,
    error: E,
    cleanup: impl FnOnce(&mut R) -> Result<(), String>,
) -> Result<E, (E, String)> {
    // The resource must also remain reserved if cleanup panics. Its ordinary
    // destructor may repeat native teardown on an already invalid handle.
    let mut resource = ManuallyDrop::new(resource);
    match cleanup(&mut resource) {
        Ok(()) => {
            // The caller's cleanup has confirmed release.
            unsafe { ManuallyDrop::drop(&mut resource) };
            Ok(error)
        }
        Err(cleanup_error) => Err((error, cleanup_error)),
    }
}

#[cfg(test)]
mod tests {
    use super::cleanup_failed_build;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    struct Resource(Arc<AtomicUsize>);
    impl Drop for Resource {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[test]
    fn drops_only_after_confirmed_cleanup() {
        let drops = Arc::new(AtomicUsize::new(0));
        assert_eq!(
            cleanup_failed_build(Resource(Arc::clone(&drops)), "build", |_| Ok(())),
            Ok("build")
        );
        assert_eq!(drops.load(Ordering::SeqCst), 1);
        assert_eq!(
            cleanup_failed_build(Resource(Arc::clone(&drops)), "build", |_| Err(
                "close".into()
            )),
            Err(("build", "close".into()))
        );
        assert_eq!(drops.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn panic_never_retries_cleanup_through_drop() {
        let drops = Arc::new(AtomicUsize::new(0));
        let result = std::panic::catch_unwind(|| {
            cleanup_failed_build(Resource(Arc::clone(&drops)), (), |_| {
                panic!("native cleanup panic")
            })
        });
        assert!(result.is_err());
        assert_eq!(drops.load(Ordering::SeqCst), 0);
    }
}
