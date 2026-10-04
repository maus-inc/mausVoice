use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: String,
    pub name: String,
    pub bio: String,
    #[serde(default)]
    pub company: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    pub onboarded: bool,
    #[serde(default)]
    pub preferred_microphone: Option<String>,
    #[serde(default)]
    pub preferred_language: Option<String>,
    #[serde(default)]
    pub words_this_month: i64,
    #[serde(default)]
    pub words_this_month_month: Option<String>,
    #[serde(default)]
    pub words_total: i64,
    #[serde(default = "default_play_interaction_chime")]
    pub play_interaction_chime: bool,
    // `Option<f32>` (not `f32`) so an explicit JSON `null` from the TS
    // payload (the default for new onboarding, where the field is unset)
    // deserializes cleanly. `#[serde(default)]` only covers MISSING keys,
    // not null values (serde-rs/serde#1098). The bind site coalesces None
    // to 0.35 so the column stays in its documented safe range.
    #[serde(default)]
    pub interaction_feedback_volume: Option<f32>,
    #[serde(default)]
    pub has_finished_tutorial: bool,
    #[serde(default)]
    pub has_migrated_preferred_microphone: bool,
    #[serde(default)]
    pub cohort: Option<String>,
    #[serde(default)]
    pub styling_mode: Option<String>,
    #[serde(default)]
    pub selected_tone_id: Option<String>,
    #[serde(default)]
    pub active_tone_ids: Option<String>,
    #[serde(default)]
    pub streak: Option<i64>,
    #[serde(default)]
    pub streak_recorded_at: Option<String>,
    #[serde(default)]
    pub referral_source: Option<String>,
    /// When the profile row was first written. `None` for rows that predate
    /// migration 89; the TS repo decides how to report those. Declared last so
    /// the positional `?N` binds in `upsert_user` keep reading in the order the
    /// struct has always used.
    #[serde(default)]
    pub created_at: Option<String>,
    /// When the user completed onboarding. Independent of `created_at`: a
    /// profile is created on the first name step, onboarding finishes later.
    #[serde(default)]
    pub onboarded_at: Option<String>,
}

const fn default_play_interaction_chime() -> bool {
    true
}

/// Default thock gain. The `user_set_one` write site coalesces a `None`
/// `interaction_feedback_volume` to this value so the `NOT NULL` column stays
/// in range, and `open.rs`'s upgrade test asserts the column default agrees.
///
/// This is the single Rust-side home for the number. `audio_feedback` keeps the
/// live value in a lock-free `AtomicU32`, which has to be seeded from a
/// `const`, so it holds the same value as
/// [`DEFAULT_INTERACTION_FEEDBACK_VOLUME_BITS`] rather than a second literal.
/// That constant is derived from this one by `to_bits` in a `const`
/// initializer, so the two cannot drift: the seed is this literal's bit
/// pattern, fixed at compile time, with nothing to keep in step at run time.
/// The agreement matters because the sink and the database disagreeing means a
/// fresh install plays back at one volume and reports another.
pub const DEFAULT_INTERACTION_FEEDBACK_VOLUME: f32 = 0.35;

/// [`DEFAULT_INTERACTION_FEEDBACK_VOLUME`] in the bit pattern the playback sink
/// stores it in, so seeding that atomic does not repeat the number.
pub const DEFAULT_INTERACTION_FEEDBACK_VOLUME_BITS: u32 =
    DEFAULT_INTERACTION_FEEDBACK_VOLUME.to_bits();

#[cfg(test)]
mod tests {
    //! Boundary tests for the `User` IPC contract. The TS `user.repo.ts`
    //! emits explicit JSON `null` for any user field that is null at the
    //! type level. `interactionFeedbackVolume` is `Option<f32>` (not
    //! `f32`) precisely so a null payload deserializes cleanly — serde's
    //! `default` attribute only covers MISSING keys, not null values
    //! (serde-rs/serde#1098), so a `f32` field would reject onboarding
    //! on every fresh install.

    use super::*;
    use serde_json::json;

    #[test]
    fn deserializes_when_interaction_feedback_volume_is_null() {
        let payload = json!({
            "id": "u-1",
            "name": "Test",
            "bio": "",
            "onboarded": false,
            "interactionFeedbackVolume": null,
        });
        let user: User = serde_json::from_value(payload).expect("null must deserialize");
        assert_eq!(user.interaction_feedback_volume, None);
    }

    #[test]
    fn deserializes_when_interaction_feedback_volume_is_missing() {
        let payload = json!({
            "id": "u-1",
            "name": "Test",
            "bio": "",
            "onboarded": false,
        });
        let user: User = serde_json::from_value(payload).expect("missing key must deserialize");
        assert_eq!(user.interaction_feedback_volume, None);
    }

    #[test]
    fn deserializes_when_interaction_feedback_volume_is_a_number() {
        let payload = json!({
            "id": "u-1",
            "name": "Test",
            "bio": "",
            "onboarded": false,
            "interactionFeedbackVolume": 0.42,
        });
        let user: User = serde_json::from_value(payload).expect("number must deserialize");
        assert_eq!(user.interaction_feedback_volume, Some(0.42));
    }
}
