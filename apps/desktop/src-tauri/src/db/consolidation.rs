use sqlx::{Row, Sqlite, SqliteConnection, Transaction};

use super::CONSOLIDATED_V0_1_6_MIGRATION_SQL;

struct TableFields {
    table: &'static str,
    primary_key: &'static str,
    fields: &'static [&'static str],
}

// Only fields introduced by the folded migrations need saving. The original
// migration already copies stable columns and intentionally rewrites cloud modes.
const TABLES: &[TableFields] = &[
    TableFields {
        table: "user_preferences",
        primary_key: "user_id",
        fields: &[
            "pill_reset_monitor_strategy",
            "always_request_admin_on_startup",
            "in_dictation_style_switching_enabled",
            "hallucination_filter_enabled",
            "review_before_insert",
            "agent_enabled_tools",
            "agent_max_iterations",
            "agent_permission_timeout_ms",
            "spoken_commands_enabled",
            "preserve_audio_on_failure",
            "pill_placement",
            "hands_free_delay_ms",
            "auto_learn_dictionary_enabled",
            "auto_learn_from_edits_enabled",
            "eleven_labs_keyterms_enabled",
            "expansion_flags",
            "update_channel",
        ],
    },
    TableFields {
        table: "transcriptions",
        primary_key: "id",
        fields: &[
            "post_process_provider",
            "post_process_failed",
            "post_process_error",
            "post_process_model",
        ],
    },
    TableFields {
        table: "tones",
        primary_key: "id",
        fields: &["category", "output_length", "example_input_output"],
    },
    TableFields {
        table: "user_profiles",
        primary_key: "id",
        fields: &["interaction_feedback_volume"],
    },
    TableFields {
        table: "api_keys",
        primary_key: "id",
        fields: &["transcription_path"],
    },
];

struct SavedFields {
    table: &'static str,
    primary_key: &'static str,
    backup: String,
    projection: String,
}

async fn save_existing_fields(
    connection: &mut SqliteConnection,
    table: &TableFields,
) -> Result<Option<SavedFields>, sqlx::Error> {
    let columns = sqlx::query("SELECT name FROM pragma_table_info(?1)")
        .bind(table.table)
        .fetch_all(&mut *connection)
        .await?;
    let existing: std::collections::HashSet<String> =
        columns.into_iter().map(|row| row.get("name")).collect();
    let fields: Vec<_> = table
        .fields
        .iter()
        .filter(|field| existing.contains(**field))
        .map(|field| format!("\"{field}\""))
        .collect();
    if fields.is_empty() {
        return Ok(None);
    }
    // Identifiers come only from TABLES, never from database contents or IPC.
    let saved = SavedFields {
        table: table.table,
        primary_key: table.primary_key,
        backup: format!("maus_v016_saved_{}", table.table),
        projection: fields.join(", "),
    };
    sqlx::query(&format!(
        "CREATE TEMP TABLE \"{}\" AS SELECT \"{}\", {} FROM main.\"{}\"",
        saved.backup, saved.primary_key, saved.projection, saved.table,
    ))
    .execute(&mut *connection)
    .await?;
    sqlx::query(&format!(
        "CREATE UNIQUE INDEX temp.\"{}_key\" ON \"{}\" (\"{}\")",
        saved.backup, saved.backup, saved.primary_key,
    ))
    .execute(&mut *connection)
    .await?;
    Ok(Some(saved))
}

async fn restore_fields(
    connection: &mut SqliteConnection,
    saved: &SavedFields,
) -> Result<(), sqlx::Error> {
    sqlx::query(&format!(
        "UPDATE main.\"{table}\" SET ({fields}) = (
            SELECT {fields} FROM temp.\"{backup}\"
            WHERE \"{backup}\".\"{key}\" = \"{table}\".\"{key}\"
        ) WHERE EXISTS (
            SELECT 1 FROM temp.\"{backup}\"
            WHERE \"{backup}\".\"{key}\" = \"{table}\".\"{key}\"
        )",
        table = saved.table,
        fields = saved.projection,
        backup = saved.backup,
        key = saved.primary_key,
    ))
    .execute(&mut *connection)
    .await?;
    sqlx::query(&format!("DROP TABLE temp.\"{}\"", saved.backup))
        .execute(&mut *connection)
        .await?;
    Ok(())
}

// The caller owns the transaction, including migration-record updates. Leave
// the registered SQL unchanged so databases already recording 69 keep matching
// its checksum. This compatibility path only runs while 69 is still pending.
pub(super) async fn apply(transaction: &mut Transaction<'_, Sqlite>) -> Result<(), sqlx::Error> {
    let connection = &mut **transaction;
    let mut saved = Vec::new();
    for table in TABLES {
        if let Some(fields) = save_existing_fields(connection, table).await? {
            saved.push(fields);
        }
    }
    sqlx::raw_sql(CONSOLIDATED_V0_1_6_MIGRATION_SQL)
        .execute(&mut *connection)
        .await?;
    for fields in saved {
        restore_fields(connection, &fields).await?;
    }
    Ok(())
}
