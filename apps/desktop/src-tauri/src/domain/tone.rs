use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Tone {
    pub id: String,
    pub name: String,
    pub prompt_template: String,
    pub created_at: i64,
    pub sort_order: i32,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub output_length: Option<String>,
    #[serde(default)]
    pub example_input_output: Option<String>,
}
