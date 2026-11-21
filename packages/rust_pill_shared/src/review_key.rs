//! Escape answers the pending transcript review. Without a review, each native
//! control keeps its own normal Escape behavior.

#[derive(Debug, Eq, PartialEq)]
pub enum ReviewKey {
    Other,
    EscapeWithoutReview,
    CancelRequested,
}

pub fn handle_review_key<K: PartialEq>(
    key: K,
    escape: K,
    pending: impl FnOnce() -> Option<String>,
    send: impl FnOnce(&str, &str, Option<String>) -> bool,
) -> ReviewKey {
    if key != escape {
        return ReviewKey::Other;
    }
    let Some(id) = pending() else {
        return ReviewKey::EscapeWithoutReview;
    };
    // Consume the key even on a closed IPC pipe. It must not also dismiss the panel.
    send(&id, "cancel", None);
    ReviewKey::CancelRequested
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_sends_one_cancel_for_the_current_id_and_no_text() {
        let mut decisions = Vec::new();
        let result = handle_review_key(
            27,
            27,
            || Some("live-2".into()),
            |id, action, text| {
                decisions.push((id.to_owned(), action.to_owned(), text));
                true
            },
        );
        assert_eq!(result, ReviewKey::CancelRequested);
        assert_eq!(decisions, [("live-2".into(), "cancel".into(), None)]);
    }

    #[test]
    fn typing_during_review_and_escape_with_no_review_send_nothing() {
        for (key, pending, expected) in [
            (65, Some("live-2"), ReviewKey::Other),
            (27, None, ReviewKey::EscapeWithoutReview),
        ] {
            assert_eq!(
                handle_review_key(
                    key,
                    27,
                    || pending.map(str::to_owned),
                    |_, _, _| panic!("unexpected decision")
                ),
                expected
            );
        }
    }
}
