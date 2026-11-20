//! Clean up a created native instance when initialization fails.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum InitializationError<E> {
    Initialize(E),
    Cleanup { initialize: E, dispose: E },
}

pub(super) fn initialize<E>(
    initialize: impl FnOnce() -> Result<(), E>,
    dispose: impl FnOnce() -> Result<(), E>,
) -> Result<(), InitializationError<E>> {
    match initialize() {
        Ok(()) => Ok(()),
        Err(initialize) => match dispose() {
            Ok(()) => Err(InitializationError::Initialize(initialize)),
            Err(dispose) => Err(InitializationError::Cleanup {
                initialize,
                dispose,
            }),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::{initialize, InitializationError};
    use std::cell::RefCell;

    #[test]
    fn dispose_runs_only_after_failed_initialization() {
        let calls = RefCell::new(Vec::new());
        assert_eq!(
            initialize(|| Ok::<_, i32>(()), || panic!("disposed a live unit")),
            Ok(())
        );
        let result = initialize(
            || {
                calls.borrow_mut().push("initialize");
                Err(1)
            },
            || {
                calls.borrow_mut().push("dispose");
                Ok(())
            },
        );
        assert_eq!(result, Err(InitializationError::Initialize(1)));
        assert_eq!(*calls.borrow(), ["initialize", "dispose"]);
    }

    #[test]
    fn failed_dispose_preserves_both_statuses() {
        let result = initialize(|| Err(1), || Err(2));
        assert_eq!(
            result,
            Err(InitializationError::Cleanup {
                initialize: 1,
                dispose: 2
            })
        );
    }
}
