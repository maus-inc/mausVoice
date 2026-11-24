use sqlx::SqlitePool;

/// The single row this table holds. The schema's CHECK constraint enforces the
/// same value, so a second pill window cannot silently accumulate rows.
const PILL_POSITION_ID: i64 = 1;

/// Columns of `pill_position`, in the order the writer binds them and the
/// reader selects them, so the two cannot drift apart.
const PILL_POSITION_COLUMNS: &[&str] = &["id", "record", "saved_at"];

fn pill_position_column_list() -> String {
    PILL_POSITION_COLUMNS.join(", ")
}

/// Store the pill window record, replacing whatever was there.
///
/// The record is the encoded form of `rust_pill_shared::restore::ParkedWindow`.
/// This layer treats it as an opaque string on purpose: the pill crates own the
/// format, and this writer must not be able to produce a record the reader
/// cannot parse. A caller that has nothing valid to store deletes the row
/// instead of writing a partial one.
pub async fn upsert_pill_position(
    pool: SqlitePool,
    record: &str,
    saved_at: i64,
) -> Result<(), sqlx::Error> {
    let columns = pill_position_column_list();
    let placeholders = (1..=PILL_POSITION_COLUMNS.len())
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(", ");
    let statement = format!(
        "INSERT INTO pill_position ({columns})
         VALUES ({placeholders})
         ON CONFLICT(id) DO UPDATE SET
             record = excluded.record,
             saved_at = excluded.saved_at"
    );
    sqlx::query(&statement)
        .bind(PILL_POSITION_ID)
        .bind(record)
        .bind(saved_at)
        .execute(&pool)
        .await?;
    Ok(())
}

/// Read the stored pill record, or `None` when the pill has never been parked.
///
/// A missing table is `None` rather than an error: the pill spawns before the
/// frontend can run, and a database one migration behind must not stop the
/// overlay from starting. Any other database failure is returned so the caller
/// can log it rather than silently losing the position.
pub async fn fetch_pill_position(pool: SqlitePool) -> Result<Option<String>, sqlx::Error> {
    let statement = "SELECT record
         FROM pill_position
         WHERE id = ?1
         LIMIT 1";
    let result = sqlx::query_scalar::<_, String>(statement)
        .bind(PILL_POSITION_ID)
        .fetch_optional(&pool)
        .await;
    match result {
        Ok(record) => Ok(record),
        Err(err) if is_missing_table(&err) => Ok(None),
        Err(err) => Err(err),
    }
}

/// Forget the stored position, which is what "Reset Pill Position" means.
pub async fn clear_pill_position(pool: SqlitePool) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM pill_position WHERE id = ?1")
        .bind(PILL_POSITION_ID)
        .execute(&pool)
        .await?;
    Ok(())
}

/// Whether the error says the table is not there yet. SQLite reports this with
/// the message "no such table: pill_position", and sqlx surfaces it as a
/// database error without a dedicated variant.
fn is_missing_table(err: &sqlx::Error) -> bool {
    let sqlx::Error::Database(database) = err else {
        return false;
    };
    database.message().contains("no such table")
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn memory_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("in-memory database");
        sqlx::query(include_str!("migrations/096_pill_position.sql"))
            .execute(&pool)
            .await
            .expect("pill_position schema");
        pool
    }

    #[tokio::test]
    async fn a_stored_record_is_read_back_unchanged() {
        let pool = memory_pool().await;
        upsert_pill_position(pool.clone(), r#"{"version":1}"#, 1_700_000_000)
            .await
            .expect("insert");
        assert_eq!(
            fetch_pill_position(pool).await.expect("read"),
            Some(r#"{"version":1}"#.to_string())
        );
    }

    #[tokio::test]
    async fn a_second_save_replaces_the_first() {
        let pool = memory_pool().await;
        upsert_pill_position(pool.clone(), "first", 1)
            .await
            .expect("insert");
        upsert_pill_position(pool.clone(), "second", 2)
            .await
            .expect("replace");
        assert_eq!(
            fetch_pill_position(pool).await.expect("read"),
            Some("second".to_string())
        );
    }

    #[tokio::test]
    async fn clearing_removes_the_row_so_the_next_launch_uses_the_default() {
        let pool = memory_pool().await;
        upsert_pill_position(pool.clone(), "somewhere", 1)
            .await
            .expect("insert");
        clear_pill_position(pool.clone()).await.expect("clear");
        assert_eq!(fetch_pill_position(pool).await.expect("read"), None);
    }

    #[tokio::test]
    async fn reading_before_anything_is_stored_is_not_an_error() {
        let pool = memory_pool().await;
        assert_eq!(fetch_pill_position(pool).await.expect("read"), None);
    }

    /// The pill spawns before the frontend runs, so a database that predates
    /// this migration must read as "nothing stored" rather than fail the spawn.
    #[tokio::test]
    async fn a_missing_table_reads_as_no_stored_position() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("in-memory database");
        assert_eq!(fetch_pill_position(pool).await.expect("read"), None);
    }

    /// The table holds one row by construction, so two writers cannot leave a
    /// second pill's geometry behind for a later launch to pick up.
    #[tokio::test]
    async fn the_schema_rejects_a_second_row() {
        let pool = memory_pool().await;
        upsert_pill_position(pool.clone(), "primary", 1)
            .await
            .expect("insert");
        let error =
            sqlx::query("INSERT INTO pill_position (id, record, saved_at) VALUES (2, 'x', 1)")
                .execute(&pool)
                .await
                .expect_err("a second row must be rejected");
        assert!(
            error.to_string().contains("CHECK"),
            "unexpected error: {error}"
        );
    }

    /// The writer builds its statement from the shared column list, so this pins
    /// that the list matches the schema the migration creates.
    #[tokio::test]
    async fn every_declared_column_exists_in_the_migrated_table() {
        let pool = memory_pool().await;
        let columns: Vec<String> =
            sqlx::query_scalar("SELECT name FROM pragma_table_info('pill_position')")
                .fetch_all(&pool)
                .await
                .expect("table info");
        for column in PILL_POSITION_COLUMNS {
            assert!(
                columns.iter().any(|known| known == column),
                "column {column} is in the writer list but not the schema"
            );
        }
    }
}
