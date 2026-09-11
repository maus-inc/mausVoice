use std::str::FromStr;

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum MeetingSource {
    Microphone,
    System,
    Mixed,
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("unknown meeting source: {0}")]
pub struct UnknownMeetingSource(String);

impl MeetingSource {
    pub fn as_db_str(self) -> &'static str {
        match self {
            MeetingSource::Microphone => "microphone",
            MeetingSource::System => "system",
            MeetingSource::Mixed => "mixed",
        }
    }
}

impl FromStr for MeetingSource {
    type Err = UnknownMeetingSource;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "microphone" => Ok(MeetingSource::Microphone),
            "system" => Ok(MeetingSource::System),
            "mixed" => Ok(MeetingSource::Mixed),
            other => Err(UnknownMeetingSource(other.to_string())),
        }
    }
}

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
    pub source: MeetingSource,
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
    pub source: MeetingSource,
    pub segments: Vec<MeetingSegment>,
    pub speakers: Vec<MeetingSpeaker>,
}
