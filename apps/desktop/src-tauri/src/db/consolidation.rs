use sqlx::{Row, Sqlite, SqliteConnection, Transaction};

use super::CONSOLIDATED_V0_1_6_MIGRATION_SQL;

struct TableFields {
    table: &'static str,
    primary_key: &'static str,
    fields: &'static [&'static str],
}

// Only fields introduced by the folded migrations need saving. The original
// migration already copies stable columns and intentionally rewrites cloud modes.
//
// Every field here has to be a column of 069's own target schema, because that is
// the table the value is written back into.
// `every_saved_field_is_a_column_of_the_consolidated_schema` below enforces it.
// `post_process_fallback` used to sit in the `transcriptions` list and is the
// reason that test exists: 070 adds it, 070 runs after 069, and
// `save_existing_fields` filters the list down to the columns that exist when the
// snapshot is taken, so the entry could never carry anything. It would have been
// worse than dead if the column were ever present while 069 was still pending --
// the projection would have taken it, 069 would have rebuilt the table without
// it, and the restore would have failed the whole 069 transaction and left the
// database unable to open.
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

#[cfg(test)]
mod tests {
    use super::{CONSOLIDATED_V0_1_6_MIGRATION_SQL, TABLES};

    /// A saved field is written back into the table that 069 just rebuilt, so it
    /// has to be one of that table's columns. Anything else is either silently
    /// dropped at snapshot time or, if the column happens to exist, turns the
    /// restore into a failed 069 transaction.
    ///
    /// 069 creates each table as `<table>_v016` and renames it, so the lookup
    /// follows the rename rather than assuming the final name.
    #[test]
    fn every_saved_field_is_a_column_of_the_consolidated_schema() {
        for table in TABLES {
            let columns = consolidated_columns(table.table);
            assert!(
                !columns.is_empty(),
                "069's schema does not define table `{}` at all, so none of {:?} can be saved",
                table.table,
                table.fields
            );
            for field in table.fields {
                assert!(
                    columns.iter().any(|column| column == field),
                    "{}.{} is saved and restored across 069, but 069's schema does not create it. \
                     A field added by a migration later than 069 can never survive this step: \
                     `save_existing_fields` filters it out while the column is absent, and \
                     `restore_fields` would fail the whole 069 transaction against a table that \
                     069 rebuilt without it if the column were ever present.",
                    table.table,
                    field
                );
            }
        }
    }

    /// Column names for `table` in 069's schema, from the `CREATE TABLE` body.
    fn consolidated_columns(table: &str) -> Vec<String> {
        // Both the `<table>_v016` form and a plain `CREATE TABLE <table>` are
        // accepted so a future 069 rewrite does not turn this into a false
        // failure when it stops using the rename dance.
        let create_start = format!("CREATE TABLE {table}_v016 (");
        let plain_start = format!("CREATE TABLE {table} (");
        let body_start = CONSOLIDATED_V0_1_6_MIGRATION_SQL
            .find(&create_start)
            .map(|at| at + create_start.len())
            .or_else(|| {
                CONSOLIDATED_V0_1_6_MIGRATION_SQL
                    .find(&plain_start)
                    .map(|at| at + plain_start.len())
            });
        let Some(body_start) = body_start else {
            return Vec::new();
        };
        let body = &CONSOLIDATED_V0_1_6_MIGRATION_SQL[body_start..];
        let Some(body_end) = body.find(");") else {
            return Vec::new();
        };

        body[..body_end]
            .split(',')
            .filter_map(|entry| {
                // Every entry here begins with a newline, because the body starts
                // right after `(` and each column is on its own line. Taking the
                // first line as-is gets that empty line rather than the column,
                // so the first non-empty line is the one that names it.
                let name = entry
                    .lines()
                    .find(|line| !line.trim().is_empty())
                    .unwrap_or_default()
                    .split_whitespace()
                    .next()
                    .unwrap_or_default();
                // A bare `name` is a column; a table constraint is uppercase and
                // carries keywords, so it is skipped rather than matched.
                if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                    return None;
                }
                if name.chars().next().is_some_and(|c| c.is_ascii_uppercase()) {
                    return None;
                }
                Some(name.to_owned())
            })
            .collect()
    }
}
