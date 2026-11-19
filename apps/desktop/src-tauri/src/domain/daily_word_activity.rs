use serde::{Deserialize, Serialize};

/// Per-local-calendar-day word usage, without any transcription content.
#[derive(Clone, Debug, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DailyWordActivity {
    pub local_date: String,
    pub word_count: i64,
}
