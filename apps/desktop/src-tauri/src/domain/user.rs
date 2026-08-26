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
}

const fn default_play_interaction_chime() -> bool {
    true
}

/// Default thock gain (clamped to the safe window at the sink). The
/// `user_set_one` write site coalesces a `None` `interaction_feedback_volume`
/// to this value so the `NOT NULL` column stays in range. The
/// `audio_feedback` module owns its own internal default (the atomic
/// is initialized to `0.35_f32.to_bits()`), and the TS fallbacks use
/// `?? 0.35` literals; this constant is the canonical Rust-side value
/// the SQL layer should write.
pub const DEFAULT_INTERACTION_FEEDBACK_VOLUME: f32 = 0.35;

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
