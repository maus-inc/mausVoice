#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum CloseState {
    Open,
    Uncertain,
    Closed,
}

impl CloseState {
    pub(super) fn close<E>(
        &mut self,
        uninitialize: impl FnOnce() -> Result<(), E>,
        dispose: impl FnOnce() -> Result<(), E>,
    ) -> Result<(), CloseError<E>> {
        match self {
            Self::Closed => return Ok(()),
            Self::Uncertain => return Err(CloseError::Uncertain),
            Self::Open => {}
        }
        // A failed or panicked FFI call can have changed or destroyed the
        // handle. Never retry it unless the native API proves that is safe.
        *self = Self::Uncertain;
        uninitialize().map_err(CloseError::Uninitialize)?;
        dispose().map_err(CloseError::Dispose)?;
        *self = Self::Closed;
        Ok(())
    }
}

#[derive(Debug, Eq, PartialEq)]
pub(super) enum CloseError<E> {
    Uncertain,
    Uninitialize(E),
    Dispose(E),
}

#[cfg(test)]
mod tests {
    use super::{CloseError, CloseState};
    use std::cell::RefCell;

    #[test]
    fn closes_once_in_order() {
        let calls = RefCell::new(Vec::new());
        let mut state = CloseState::Open;
        let result: Result<(), CloseError<()>> = state.close(
            || {
                calls.borrow_mut().push("uninitialize");
                Ok(())
            },
            || {
                calls.borrow_mut().push("dispose");
                Ok(())
            },
        );
        assert_eq!(result, Ok(()));
        assert_eq!(state, CloseState::Closed);
        let result: Result<(), CloseError<()>> = state.close(|| panic!(), || panic!());
        assert_eq!(result, Ok(()));
        assert_eq!(*calls.borrow(), ["uninitialize", "dispose"]);
    }

    #[test]
    fn failed_operations_are_not_retried() {
        for fail_uninitialize in [true, false] {
            let mut state = CloseState::Open;
            let calls = RefCell::new(Vec::new());
            let result = state.close(
                || {
                    calls.borrow_mut().push("uninitialize");
                    if fail_uninitialize {
                        Err(1)
                    } else {
                        Ok(())
                    }
                },
                || {
                    calls.borrow_mut().push("dispose");
                    Err(2)
                },
            );
            assert_eq!(
                result,
                Err(if fail_uninitialize {
                    CloseError::Uninitialize(1)
                } else {
                    CloseError::Dispose(2)
                })
            );
            assert_eq!(state, CloseState::Uncertain);
            let retry: Result<(), CloseError<i32>> = state.close(|| panic!(), || panic!());
            assert_eq!(retry, Err(CloseError::Uncertain));
            assert_eq!(
                *calls.borrow(),
                if fail_uninitialize {
                    vec!["uninitialize"]
                } else {
                    vec!["uninitialize", "dispose"]
                }
            );
        }
    }

    #[test]
    fn panic_leaves_native_state_uncertain() {
        let mut state = CloseState::Open;
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _: Result<(), CloseError<()>> = state.close(|| panic!(), || Ok(()));
        }))
        .is_err());
        assert_eq!(state, CloseState::Uncertain);
    }
}
