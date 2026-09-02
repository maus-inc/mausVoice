use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Meeting {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub duration_ms: i64,
    pub status: String,
    pub summary: Option<String>,
    pub transcript: String,
    pub source: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MeetingSegment {
    pub id: String,
    pub meeting_id: String,
    pub speaker_id: String,
    pub start_time_ms: i64,
    pub end_time_ms: i64,
    pub text: String,
    pub confidence: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MeetingSpeaker {
    pub id: String,
    pub meeting_id: String,
    pub name: String,
    pub label: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MeetingWithDetails {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub duration_ms: i64,
    pub status: String,
    pub summary: Option<String>,
    pub transcript: String,
    pub source: String,
    pub segments: Vec<MeetingSegment>,
    pub speakers: Vec<MeetingSpeaker>,
}
