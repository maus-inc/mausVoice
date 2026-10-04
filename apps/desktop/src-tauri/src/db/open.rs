use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha384};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};

use super::migrations;

/// The canonical SHA-384 of a migration's SQL: CRLF folded to LF, then hashed.
///
/// Canonical, NOT compatible. `sqlx` -- and therefore `tauri-plugin-sql`, which this file
/// replaced -- hashes `sql.as_bytes()` with no normalization at all
/// (`sqlx-core-0.8.6/src/migrate/migration.rs:25`), so for LF input the two agree and for
/// CRLF input they do not. That matters because the SQL reaches the binary through
/// `include_str!` from whatever the *building* checkout held. The repository-root
/// `.gitattributes` pins `*.sql text eol=lf` -- there is no `.gitattributes` beside this
/// file or these migrations, and the rule that matters is the root one. That file did not
/// exist before this change, and `build-desktop.yml` builds a `windows-latest` leg, so a
/// build from a Windows checkout at the base branch embedded CRLF SQL and wrote
/// `Sha384(CRLF)` into `_sqlx_migrations`. Those rows cannot be rewritten -- the database is
/// the only record -- which is why verification accepts the historical digest too. See
/// `migration_checksum_matches`.
pub fn migration_checksum(sql: &str) -> Vec<u8> {
    let normalized = sql.replace("\r\n", "\n");
    Sha384::digest(normalized.as_bytes()).to_vec()
}

/// The digest a CRLF checkout would have produced for this SQL, which is what `sqlx`
/// recorded before `.gitattributes` pinned `*.sql text eol=lf`.
///
/// SHA-384 over the SQL with every LF expanded back to CRLF -- NOT over `sql` as given.
/// That distinction is the whole fix, and it is easy to get wrong in a way the unit test
/// cannot see: hashing the LF text a second time just reproduces the canonical digest, so
/// a CRLF row still matches neither arm and the open still fails. The end-to-end test is
/// what caught that; the first version of the unit test passed throughout.
///
/// Only ever a second ACCEPTED value. Nothing writes it: `migration_checksum` is canonical
/// and every row this code writes uses it.
fn historical_migration_checksum(sql: &str) -> Vec<u8> {
    Sha384::digest(sql.replace("\r\n", "\n").replace("\n", "\r\n").as_bytes()).to_vec()
}

/// SHA-384 digests of migration 069's SQL as earlier builds recorded them, with the ref each
/// came from.
///
/// 069 has three distinct blobs across the refs this repository still carries. The commit that
/// diverged two of them, `bc17875a` ("Correct four comments that still claimed migration 070
/// was never used"), changed three lines and every one of them was a comment -- so the schema
/// those builds produce is identical to this build's and only the text differs. A database
/// written by one of them recorded that text's digest, this build computes its own, and the
/// mismatch path returns `OpenError` WITHOUT quarantining: the app reports that it cannot
/// open the database and there is no in-app way back.
///
/// Two entries, not three: `fix/pr208-audit-findings` and `arena/0.1.6-feature-completion`
/// carry the same blob.
///
/// This is an allowlist, and deliberately the narrower of the two available fixes. The wider
/// one -- recording a digest of the comment-stripped SQL, so equivalence stays decidable from
/// the ledger forever -- was implemented, and its own test rejected it: a build records the
/// RAW digest of its own text, so a digest of the stripped text can never match one.
///
///     raw digest of a commented text   e18edfc9e5c015f7...
///     digest of the stripped text      1051159cde5420ef...
///
/// So that arm was inert while reading as tolerance. Making the stripped form the RECORDED one
/// would work, and would give up the property that lets this digest stand in for `sqlx`'s --
/// which is why these are two named digests rather than one folded rule.
///
/// The cost, stated: the next COMMENT-only edit to 069 breaks this again and someone has to add
/// a row. That is a smaller problem than an unreadable database, and it is visible.
const MIGRATION_069_SUPERSEDED_DIGESTS: &[(&str, &str)] = &[
    (
        "d112bf2cedb20a47c868663d87025caab7c7a6b28be61d95b09e4d907cc90e9a\
         33bbeddf72bdea0e60060af8ab7b0859",
        "integration/0.1.6-staging",
    ),
    (
        "6ec29f6389926fe988145bc833451538c783c423d9e134e767bb4e5fcc5fdbc6be6\
         a1e10cd05b4deb53d9f1eb15ccfb1",
        "fix/pr208-audit-findings and arena/0.1.6-feature-completion",
    ),
];

/// The digest `hex` names. Only ever called on the two literals above, so a malformed entry
/// would be a bug in this table rather than anything a caller can reach.
fn decode_sha384_hex(hex: &str) -> Vec<u8> {
    assert_eq!(hex.len(), 96, "a SHA-384 is 48 bytes, so 96 hex characters");
    hex.as_bytes()
        .chunks(2)
        .map(|pair| {
            let hi = (pair[0] as char)
                .to_digit(16)
                .expect("table holds hex digits");
            let lo = (pair[1] as char)
                .to_digit(16)
                .expect("table holds hex digits");
            ((hi << 4) | lo) as u8
        })
        .collect()
}

/// Whether `stored` is a digest some earlier build of `version` legitimately wrote.
///
/// Only 069 has any, and only the two comment-only variants named in the table. Every other
/// version returns false, so a modified migration anywhere else is still refused.
///
/// 069 itself is the exception this function documents rather than avoids: it decides on the
/// version number and a fixed list, and never looks at the current text. So if 069 is edited a
/// THIRD time -- even to change the schema -- a database carrying either of those two digests
/// still opens, because nothing here re-derives them. That is the price of a list over a rule,
/// and it is why the list is short, labelled with the ref each entry came from, and asserted to
/// have exactly the number of entries the history has.
fn is_superseded_checksum(version: i64, stored: &[u8]) -> bool {
    version == 69
        && MIGRATION_069_SUPERSEDED_DIGESTS
            .iter()
            .any(|(hex, _)| decode_sha384_hex(hex) == stored)
}

/// Whether a recorded checksum is one this build could legitimately have written.
///
/// Three sources, and none is accepted for symmetry -- each is a digest some build actually
/// wrote:
///
///   1. `migration_checksum` -- the canonical form, which every row this code writes carries,
///      and which `sqlx` agreed with for LF input.
///   2. `historical_migration_checksum` -- what `sqlx` wrote for a build whose checkout held
///      CRLF in the `.sql` files.
///   3. `is_superseded_checksum` -- what a build carrying one of 069's two comment-only
///      variants recorded. See that table for why this is a list and not a rule.
///
/// Accepting only the first turns a readable database into an unrecoverable `OpenError`, and
/// the failure path deliberately does not quarantine, so there is no in-app way back.
///
/// The first two cannot mask a genuinely modified migration: they hash this build's own text,
/// so a changed file matches neither.
///
/// The third CAN, for 069 only, and an earlier version of this comment claimed otherwise. It
/// compares against a fixed list rather than re-deriving anything, so a third edit to 069 would
/// not be noticed for a database already carrying one of the two superseded digests. An earlier
/// version of this doc defended the third arm by saying it "names the two known other texts
/// exactly", which is true of what it names and not a statement about what happens next. The
/// cost is bounded and deliberate -- an unreadable database has no in-app recovery -- and it is
/// recorded in `is_superseded_checksum` where the list lives rather than smoothed over here.
fn migration_checksum_matches(version: i64, stored: &[u8], sql: &str) -> bool {
    stored == migration_checksum(sql).as_slice()
        || stored == historical_migration_checksum(sql).as_slice()
        || is_superseded_checksum(version, stored)
}

#[derive(Debug)]
enum OpenError {
    Integrity(String),
    Other(String),
}

impl OpenError {
    fn message(&self) -> &str {
        match self {
            Self::Integrity(message) | Self::Other(message) => message,
        }
    }
}

/// Whether an open failure means the file itself is damaged, as opposed to the
/// migration ledger disagreeing with this build.
///
/// Only the file-level signals belong here. A checksum mismatch or a leftover
/// `success = false` row means the *ledger* cannot be reconciled, and the file
/// is still perfectly readable: quarantining it would move a user's
/// transcriptions, keys and preferences aside and open an empty database in
/// their place, with nothing to tell them it happened. Those surface as a
/// repairable error instead.
///
/// Matched against the whole error chain, not just the top-level display: a
/// SQLite corruption code is often only present on the source error.
pub fn is_integrity_failure(message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();
    normalized.contains("database disk image is malformed")
        || normalized.contains("file is not a database")
        || normalized.contains("sqlite_corrupt")
        || normalized.contains("sqlite_notadb")
}

/// Classify a SQLite failure as file damage or something else.
///
/// SQLite reports its corruption codes on the error *source*, not on the
/// top-level display, so matching only `err.to_string()` classified a genuinely
/// corrupt file as `Other` and left the user with a raw error instead of the
/// quarantine-and-recover path.
fn classify_sqlx(context: &str, err: impl std::error::Error) -> OpenError {
    let detail = err.to_string();
    let mut chain = detail.clone();
    let mut source = err.source();
    while let Some(inner) = source {
        chain.push(' ');
        chain.push_str(&inner.to_string());
        source = inner.source();
    }
    let message = format!("{context}: {detail}");
    if is_integrity_failure(&chain) || is_integrity_failure(&message) {
        OpenError::Integrity(message)
    } else {
        OpenError::Other(message)
    }
}

fn sqlite_connect_options(path: &Path) -> SqliteConnectOptions {
    SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .foreign_keys(true)
}

const SQLITE_SIDECARS: &[&str] = &["-journal", "-wal", "-shm"];

fn rename_all_or_restore(moves: &[(PathBuf, PathBuf)]) -> std::io::Result<()> {
    let mut completed = Vec::new();
    for (from, to) in moves {
        if let Err(err) = std::fs::rename(from, to) {
            for (done_from, done_to) in completed.into_iter().rev() {
                let _ = std::fs::rename(done_to, done_from);
            }
            return Err(err);
        }
        completed.push((from, to));
    }
    Ok(())
}

/// The prefix `quarantine_sqlite_file` gives every directory it creates.
///
/// Always followed by a decimal nanosecond stamp, which is what lets
/// `is_quarantine_name` recognise its own output exactly rather than by prefix alone.
pub const QUARANTINE_PREFIX: &str = "mausvoice.broken-";

/// Whether `name` is a quarantine directory this module created.
///
/// `quarantine_sqlite_file` builds every one of them as `QUARANTINE_PREFIX` followed by
/// `SystemTime::now().as_nanos()`, so an all-digit suffix is precisely the set it can
/// produce. Matching the bare prefix instead makes a user-directed privacy wipe recursively
/// delete anything else that happens to share it -- and `remove_dir_all` over a directory
/// the user named is not a privacy wipe, it is data loss.
fn is_quarantine_name(name: &str) -> bool {
    match name.strip_prefix(QUARANTINE_PREFIX) {
        Some(stamp) => !stamp.is_empty() && stamp.bytes().all(|b| b.is_ascii_digit()),
        None => false,
    }
}

pub fn quarantine_sqlite_file(path: &Path) -> std::io::Result<PathBuf> {
    let parent = path.parent().unwrap_or(path);
    let mut stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = loop {
        let candidate = parent.join(format!("{QUARANTINE_PREFIX}{stamp}"));
        match std::fs::create_dir(&candidate) {
            Ok(()) => break candidate,
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                stamp = stamp.saturating_add(1);
            }
            Err(err) => return Err(err),
        }
    };
    let dest = dir.join("mausvoice.db");
    let mut moves = Vec::new();
    if path.exists() {
        moves.push((path.to_path_buf(), dest.clone()));
    }
    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
        for suffix in SQLITE_SIDECARS {
            let side = path.with_file_name(format!("{name}{suffix}"));
            if side.exists() {
                moves.push((side, dir.join(format!("mausvoice.db{suffix}"))));
            }
        }
    }
    if let Err(err) = rename_all_or_restore(&moves) {
        let _ = std::fs::remove_dir(&dir);
        return Err(err);
    }
    Ok(dest)
}

/// Remove every quarantined broken database backup created by `quarantine_sqlite_file`.
/// Invoked on an explicit user-directed privacy wipe (`clear_local_data`) so old
/// transcriptions, settings, and credentials do not linger in `mausvoice.broken-*`.
pub fn delete_quarantined_databases(parent_or_db: &Path) -> std::io::Result<usize> {
    let mut deleted = 0;
    let parent = if parent_or_db.is_file() {
        parent_or_db.parent().unwrap_or(parent_or_db)
    } else {
        parent_or_db
    };
    if !parent.is_dir() {
        return Ok(0);
    }
    for entry in std::fs::read_dir(parent)? {
        let entry = entry?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if is_quarantine_name(&name_str) {
            let path = entry.path();
            if path.is_dir() {
                std::fs::remove_dir_all(&path)?;
                deleted += 1;
            } else if path.is_file() {
                std::fs::remove_file(&path)?;
                deleted += 1;
            }
        }
    }
    Ok(deleted)
}

async fn connect_pool(path: &Path) -> Result<SqlitePool, OpenError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| OpenError::Other(err.to_string()))?;
    }
    SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(sqlite_connect_options(path))
        .await
        .map_err(|err| classify_sqlx("connect", err))
}

async fn retire_consolidated_migrations(
    connection: &mut sqlx::SqliteConnection,
    versions: &[i64],
) -> Result<(), sqlx::Error> {
    for version in versions {
        sqlx::query("DELETE FROM _sqlx_migrations WHERE version = ?1")
            .bind(version)
            .execute(&mut *connection)
            .await?;
    }
    Ok(())
}

/// Every migration version any ref in this repository used in the range 070 to
/// 088, all of which the 0.1.6 consolidation folded into this build's target
/// schema.
///
/// The numbers sit above the consolidation step (069) on purpose: the
/// individual steps were written and shipped first, and the consolidation was
/// numbered 069 afterwards, so "the steps between 069 and 089" is the numeric
/// description of this list. 089 arrived after the consolidation and is still
/// applied, so it is not retired. Intermediate builds recorded these steps
/// individually, so their ledger rows retire on open instead of being reported
/// as a downgrade.
///
/// This is an explicit list on purpose. The previous `71..=88` range also
/// retired 080 and 088, and no ref in this repository has ever used either
/// number, so a future legitimate `080_*.sql` or `088_*.sql` would have had its
/// ledger row hard-deleted instead of surfacing as a downgrade. Adding a
/// version here is now a deliberate edit and can never be a side effect of
/// widening a number.
///
/// The list is every `NNN_*.sql` file that a build recorded under
/// `_sqlx_migrations` between 069 and 089 and that 069 folds in, and nothing
/// for 080 or 088. A ledger row for one of those two is therefore never
/// retired and still surfaces as a downgrade.
///
/// 070 was the third such gap until this build claimed it, for
/// `070_post_process_fallback`. A colliding ledger row at 70 is therefore no
/// longer quarantined as an unknown step: `configured.contains(70)` is true, so
/// control reaches the checksum comparison and the open fails with "migration 70
/// (post_process_fallback) was previously applied but has been modified". That
/// still refuses to open, so the safety property holds, but it now names 070 as
/// the culprit instead of reporting a bare downgrade. The header of
/// `migrations/069_consolidated_v0_1_6_schema.sql` names the same 16 steps,
/// `expansion_flags` included, because that column arrived on the 075 step
/// rather than on a step of its own.
///
/// Retirement matches on `(version, description)`, not on the number alone.
/// Other long-lived lines reuse these numbers for unrelated schemas — 076 is
/// `feature_preferences` on one and `meetings` on another, 077/078/079 likewise
/// — and those databases hold real rows. Retiring by number would delete the
/// ledger record of what happened to their file, so a later merge from one of
/// those branches would re-run its migration: `CREATE TABLE IF NOT EXISTS`
/// would hide that, and any `ALTER TABLE` would hard-fail the open. The
/// description is the part that says which migration a row actually recorded,
/// and it is already stored on every row.
///
/// Two of these keep a leading `add_`, and that is not an inconsistency: it is what the
/// step was registered under, so it is what ended up on the ledger row. The descriptions
/// come from the migration filenames with the numeric prefix removed, and
/// `073_add_pill_reset_monitor_strategy.sql` and `074_add_always_request_admin_on_startup.sql`
/// both begin `add_`. Writing the list from the filenames and dropping the prefix gave
/// `pill_reset_monitor_strategy` and `always_request_admin_on_startup`, which match no row
/// any build ever wrote -- and an unmatched row is not ignored, it refuses the open:
///
///     migration 73 is recorded but is not in the current migration set; the database was
///     likely created by a newer version of the app
///
/// That is a shipped-blocker, not a latent one: 073 and 074 are in the released 0.1.6, so
/// every database that release wrote carries these two names, and this build ships 1-70 plus
/// 89 and 90, so both versions are unconfigured here and both go down the retirement path.
/// `a_database_written_by_the_released_0_1_6_upgrades` is the test that failed before this
/// fix; it takes the four names from the released branch's own registrations rather than
/// from this list, which is the only way a typo in the list can be caught by anything.
///
/// A name that no build shipped is deliberately absent: `075_preserve_audio_on_failure`,
/// `075_tone_structured_fields` and `077_spoken_commands_and_hallucination` appear
/// only on long-lived branches and the 069 header lists them as never released, so a
/// ledger row carrying one of those has not come from a real install. A database
/// that does surface as a downgrade in that case is the fail-safe outcome.
///
/// That does make the upgrade path stricter for anyone who ran a branch build
/// under a colliding name: those databases now report "likely created by a newer
/// version" rather than upgrading silently. Surfacing beats deleting their ledger
/// rows, but it is a behaviour change worth knowing about before 0.1.6 ships.
/// `consolidated_intermediate_migration_rows_are_retired` below exercises the
/// retirement path, and
/// `unretired_consolidation_era_numbers_surface_as_a_downgrade` covers the
/// two gaps that are left, 080 and 088.
const RETIRED_CONSOLIDATION_ERA_VERSIONS: &[(i64, &str)] = &[
    (71, "remove_cloud_modes"),
    (72, "drop_is_enterprise"),
    (73, "add_pill_reset_monitor_strategy"),
    (74, "add_always_request_admin_on_startup"),
    (75, "expansion_flags"),
    (76, "api_key_transcription_path"),
    (77, "pill_placement_and_hands_free_delay"),
    (78, "post_process_attribution"),
    (79, "interaction_feedback_volume"),
    (81, "preserve_audio_on_failure"),
    (82, "api_key_transcription_path"),
    (83, "pill_placement_and_hands_free_delay"),
    (84, "auto_learn_dictionary"),
    (85, "auto_learn_from_edits"),
    (86, "transcription_post_process_model"),
    (87, "eleven_labs_keyterms_enabled"),
];

async fn apply_migrations(pool: &SqlitePool) -> Result<(), OpenError> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS _sqlx_migrations (
            version BIGINT PRIMARY KEY,
            description TEXT NOT NULL,
            installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            success BOOLEAN NOT NULL,
            checksum BLOB NOT NULL,
            execution_time BIGINT NOT NULL
        )",
    )
    .execute(pool)
    .await
    .map_err(|err| classify_sqlx("create _sqlx_migrations", err))?;

    let failed: Option<i64> = sqlx::query_scalar(
        "SELECT version FROM _sqlx_migrations WHERE success = false ORDER BY version LIMIT 1",
    )
    .fetch_optional(pool)
    .await
    .map_err(|err| classify_sqlx("read failed migrations", err))?;
    if let Some(version) = failed {
        // `Other`, not `Integrity`: the file is readable, this build just cannot
        // say how far it got. `Integrity` quarantines, which would move a
        // working database aside for a ledger disagreement.
        return Err(OpenError::Other(format!(
            "migration {version} previously failed; the database needs recovery before it can be opened"
        )));
    }

    let applied =
        sqlx::query("SELECT version, description, checksum FROM _sqlx_migrations ORDER BY version")
            .fetch_all(pool)
            .await
            .map_err(|err| classify_sqlx("read applied migrations", err))?;

    let mut applied_checksums = std::collections::HashMap::new();
    let mut applied_descriptions = std::collections::HashMap::new();
    for row in applied {
        let version: i64 = row.get("version");
        let description: String = row.get("description");
        let checksum: Vec<u8> = row.get("checksum");
        applied_descriptions.insert(version, description);
        applied_checksums.insert(version, checksum);
    }

    let configured: std::collections::HashSet<i64> = migrations()
        .into_iter()
        .filter(|migration| matches!(migration.kind, tauri_plugin_sql::MigrationKind::Up))
        .map(|migration| migration.version)
        .collect();
    let mut retired: Vec<i64> = Vec::new();
    for version in applied_checksums.keys() {
        if !configured.contains(version) {
            // The individual migrations that the 0.1.6 release folded into the
            // single post-0.1.5 consolidation step (69). Databases written by
            // intermediate builds recorded those steps individually; that
            // schema is already part of this build's target, so those rows are
            // retired below instead of failing the open as a downgrade. Only
            // the versions a real build actually shipped are listed, so any
            // other unconfigured version keeps the strict behavior: a database
            // from a genuinely newer release must surface loudly, not be
            // rewritten underneath it.
            // Match the description too. The number alone is ambiguous: other
            // long-lived branches put unrelated migrations at 076-079, and
            // retiring one of those rows would erase the record of a schema
            // this build knows nothing about.
            let description = applied_descriptions
                .get(version)
                .map(String::as_str)
                .unwrap_or_default();
            if RETIRED_CONSOLIDATION_ERA_VERSIONS
                .iter()
                .any(|(retired, name)| retired == version && *name == description)
            {
                retired.push(*version);
                continue;
            }
            // A version recorded in `_sqlx_migrations` that this build does not
            // ship means the database was written by a newer release (a normal
            // downgrade/rollback). The file is perfectly readable, so this is
            // not corruption: classify it as `Other` so the failure is surfaced
            // to the user instead of `Integrity`, which would quarantine the
            // file and silently discard the user's transcriptions, keys and
            // preferences.
            return Err(OpenError::Other(format!(
                "migration {version} is recorded but is not in the current migration set; \
                 the database was likely created by a newer version of the app"
            )));
        }
    }
    retired.sort_unstable();
    for migration in migrations() {
        if !matches!(migration.kind, tauri_plugin_sql::MigrationKind::Up) {
            continue;
        }
        let version = migration.version;
        if let Some(stored) = applied_checksums.get(&version) {
            if !migration_checksum_matches(version, stored, migration.sql) {
                // A modified migration file is a disagreement about what this
                // build's history should have been, not damage to the database.
                // Quarantining here would discard a perfectly readable file and
                // open an empty one in its place, so this surfaces for repair.
                //
                // Two of the three accepted sources hash this build's own text, so neither
                // matching means the file really did change. The third does not: for 069 it is
                // a fixed list of two superseded digests, so this is unreachable for 069 by
                // construction and a later edit to that one file would not be caught here.
                // `is_superseded_checksum` says so where the list is.
                return Err(OpenError::Other(format!(
                    "migration {version} ({}) was previously applied but has been modified; \
                     the database is readable but its history does not match this build",
                    migration.description
                )));
            }
        }
    }

    for migration in migrations() {
        if !matches!(migration.kind, tauri_plugin_sql::MigrationKind::Up)
            || applied_checksums.contains_key(&migration.version)
        {
            continue;
        }
        let version = migration.version;
        let expected = migration_checksum(migration.sql);
        let started = std::time::Instant::now();
        let mut transaction = pool
            .begin()
            .await
            .map_err(|err| classify_sqlx("begin migration transaction", err))?;
        let result = async {
            if version == 69 {
                super::consolidation::apply(&mut transaction).await?;
                retire_consolidated_migrations(&mut transaction, &retired).await?;
            } else {
                sqlx::raw_sql(migration.sql)
                    .execute(&mut *transaction)
                    .await?;
            }
            Ok::<(), sqlx::Error>(())
        }
        .await;
        if let Err(err) = result {
            let classified = classify_sqlx(&format!("migration {version}"), err);
            if let Err(rollback_err) = transaction.rollback().await {
                let message = format!("{}; rollback failed: {rollback_err}", classified.message());
                return Err(match classified {
                    OpenError::Integrity(_) => OpenError::Integrity(message),
                    OpenError::Other(_) => OpenError::Other(message),
                });
            }
            return Err(classified);
        }
        let execution_time = i64::try_from(started.elapsed().as_nanos()).unwrap_or(i64::MAX);
        sqlx::query(
            "INSERT INTO _sqlx_migrations
             (version, description, success, checksum, execution_time)
             VALUES (?1, ?2, true, ?3, ?4)",
        )
        .bind(version)
        .bind(migration.description)
        .bind(&expected)
        .bind(execution_time)
        .execute(&mut *transaction)
        .await
        .map_err(|err| classify_sqlx("record migration", err))?;
        transaction
            .commit()
            .await
            .map_err(|err| classify_sqlx("commit migration", err))?;
        if version == 69 {
            retired.clear();
        }
    }

    // Already-consolidated profiles may retain old ledger rows, and retiring
    // them only drops the record of steps whose schema 069 already established.
    //
    // This does NOT re-validate the retired rows, and it cannot: a retired
    // version is by definition absent from `migrations()`, which is the set the
    // checksum loop above iterates, and its SQL is no longer shipped (071-087
    // were folded into 069). There is no expected checksum left to compare the
    // stored one against, so re-adding those files purely to validate rows that
    // are about to be deleted would reintroduce the migration history this
    // consolidation exists to remove. What is checked for these rows is the
    // (version, description) match in `RETIRED_CONSOLIDATION_ERA_VERSIONS`,
    // which they must pass to reach this point.
    if !retired.is_empty() {
        let mut transaction = pool
            .begin()
            .await
            .map_err(|err| classify_sqlx("begin retirement transaction", err))?;
        retire_consolidated_migrations(&mut transaction, &retired)
            .await
            .map_err(|err| classify_sqlx("retire consolidated migrations", err))?;
        transaction
            .commit()
            .await
            .map_err(|err| classify_sqlx("commit retirement transaction", err))?;
    }

    Ok(())
}

/// Open the app database, applying migrations.
///
/// Only file-level damage (a corrupt or non-SQLite file) quarantines the broken
/// file and opens a fresh database. A ledger disagreement — a checksum mismatch,
/// a leftover `success = false` row, or a version this build does not ship — is
/// returned as-is with the file left in place, as are transient errors such as a
/// lock or a permission failure and a buggy new migration. Quarantining any of
/// those would move a perfectly readable database holding the user's
/// transcriptions, keys and preferences aside and open an empty one in its
/// place, discarding the data without saying so.
pub async fn open_app_database(path: &Path) -> Result<SqlitePool, String> {
    match try_open(path).await {
        Ok(pool) => Ok(pool),
        Err(OpenError::Other(message)) => Err(message),
        Err(OpenError::Integrity(first_error)) => {
            log::error!(
                "Database at {} is unusable ({first_error}); quarantining and opening a fresh file",
                path.display()
            );
            match quarantine_sqlite_file(path) {
                Ok(backup) => log::warn!("Moved broken database to {}", backup.display()),
                Err(err) => {
                    return Err(format!(
                        "failed to quarantine broken database after {first_error}: {err}"
                    ));
                }
            }
            try_open(path).await.map_err(|retry_error| {
                format!(
                    "database recovery failed after {first_error}; retry error: {}",
                    retry_error.message()
                )
            })
        }
    }
}

async fn try_open(path: &Path) -> Result<SqlitePool, OpenError> {
    let pool = connect_pool(path).await?;
    if let Err(err) = apply_migrations(&pool).await {
        pool.close().await;
        return Err(err);
    }
    Ok(pool)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempDb {
        dir: PathBuf,
        path: PathBuf,
    }

    impl TempDb {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "mausvoice-open-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            Self {
                path: dir.join("mausvoice.db"),
                dir,
            }
        }
    }

    impl Drop for TempDb {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// The quarantine directories currently in `dir`, as `is_quarantine_name` defines them.
    fn quarantined_archives(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| is_quarantine_name(name))
            .collect()
    }

    /// Assert the open left no quarantined copy of the database behind.
    ///
    /// Quarantine renames the user's file aside and reopens a fresh one, so it
    /// is only ever correct for genuine file damage. Every repairable failure
    /// has to leave the file in place, which is what these assert.
    fn assert_not_quarantined(dir: &Path, context: &str) {
        let archives = quarantined_archives(dir);
        assert!(
            archives.is_empty(),
            "{context}, but found quarantined archives: {archives:?}"
        );
    }

    fn assert_quarantined(dir: &Path, context: &str) {
        assert!(
            !quarantined_archives(dir).is_empty(),
            "{context}, but no quarantined archive exists"
        );
    }

    #[test]
    fn checksum_matches_sqlx_sha384_vector() {
        // Independent SHA-384 of b"SELECT 1;" (same digest sqlx stores).
        let expected = hex_literal(
            "26e71cc37450b183fb5bb72ec4f644ed27de1b55fad3d4d6cfb0ca0d71f42ca990911d74649814105a190325e15d2092",
        );
        assert_eq!(migration_checksum("SELECT 1;"), expected);
        assert_ne!(migration_checksum("SELECT 2;"), expected);
    }

    fn hex_literal(hex: &str) -> Vec<u8> {
        (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn integrity_classifier_does_not_treat_locks_as_corruption() {
        // The first two are the exact strings the two repairable paths build, so
        // this fails if anyone re-adds a needle that matches them — which is how
        // both used to be quarantined. The rest are the file-level signals and
        // the near misses beside them.
        assert!(!is_integrity_failure(
            "migration 70 (create_users_table) was previously applied but has been modified; \
             the database is readable but its history does not match this build"
        ));
        assert!(!is_integrity_failure(
            "migration 70 previously failed; the database needs recovery before it can be opened"
        ));
        assert!(is_integrity_failure("database disk image is malformed"));
        assert!(is_integrity_failure("file is not a database"));
        assert!(is_integrity_failure(
            "(code: 11) database disk image is malformed"
        ));
        assert!(!is_integrity_failure("database is locked"));
        assert!(!is_integrity_failure("migration 77 failed: syntax error"));
    }

    #[test]
    fn a_full_disk_is_not_classified_as_file_damage() {
        // SQLITE_FULL is a condition of the filesystem, not of the file: the
        // database is intact and the user's data is still in it. Quarantining
        // a full disk would delete a working database and leave an empty one,
        // and would do it again on the fresh file, so this must surface as a
        // repairable error. This is the string sqlx actually produces —
        // `SqliteError` renders as `(code: <int>) <message>` and exposes only
        // the numeric extended result code, never the `SQLITE_FULL` symbol.
        let sqlx_full =
            "migration 89 (user_profile_timestamps): (code: 13) database or disk is full";
        assert!(!is_integrity_failure(sqlx_full));
        assert!(!is_integrity_failure(
            "record migration: (code: 13) database or disk is full"
        ));
    }

    #[test]
    fn quarantine_renames_db_and_sidecars() {
        let temp = TempDb::new();
        let path = &temp.path;
        std::fs::write(path, b"broken").unwrap();
        let journal = path.with_file_name("mausvoice.db-journal");
        let wal = path.with_file_name("mausvoice.db-wal");
        std::fs::write(&journal, b"journal").unwrap();
        std::fs::write(&wal, b"wal").unwrap();
        let dest = quarantine_sqlite_file(path).unwrap();
        assert!(!path.exists());
        assert!(!journal.exists());
        assert!(!wal.exists());
        assert!(dest.exists());
        assert_eq!(std::fs::read(&dest).unwrap(), b"broken");
        assert_eq!(
            std::fs::read(dest.with_file_name("mausvoice.db-journal")).unwrap(),
            b"journal"
        );
        assert_eq!(
            std::fs::read(dest.with_file_name("mausvoice.db-wal")).unwrap(),
            b"wal"
        );
        let quarantine_name = dest
            .parent()
            .unwrap()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert!(
            is_quarantine_name(&quarantine_name),
            "quarantine must name its directory the way `is_quarantine_name` recognises, \
             or the wipe will not find it. Got {quarantine_name:?}"
        );
    }

    /// The wipe removes exactly what `quarantine_sqlite_file` creates, and nothing that
    /// merely shares the prefix.
    ///
    /// The survival half used to be asserted the other way: this test created
    /// `mausvoice.broken-67890.bak` and asserted it was DELETED. Nothing in this module can
    /// produce that name -- the stamp is always a decimal integer -- so the assertion was
    /// pinning the collateral damage rather than the intent, and `remove_dir_all` over a
    /// directory a user happened to name is data loss wearing a privacy wipe's clothes.
    #[test]
    fn delete_quarantined_databases_removes_only_its_own_directories() {
        let temp = TempDb::new();
        // A real one: created through the function under test, not spelled out.
        let real = quarantine_sqlite_file(&{
            std::fs::write(temp.dir.join("mausvoice.db"), b"db").unwrap();
            temp.dir.join("mausvoice.db")
        })
        .unwrap();

        // Names sharing the prefix that the function cannot produce.
        let unrelated_file = temp.dir.join("mausvoice.broken-67890.bak");
        let unrelated_dir = temp.dir.join("mausvoice.broken-my-backup");
        std::fs::write(&unrelated_file, b"mine").unwrap();
        std::fs::create_dir(&unrelated_dir).unwrap();
        std::fs::write(unrelated_dir.join("holiday.png"), b"mine").unwrap();
        let untouched_db = temp.dir.join("mausvoice.db");
        std::fs::write(&untouched_db, b"keep").unwrap();

        let removed = delete_quarantined_databases(&temp.dir).unwrap();

        assert_eq!(removed, 1, "only the quarantine directory is ours");
        assert!(
            !real.parent().unwrap().exists(),
            "the real quarantine is removed"
        );
        assert!(
            unrelated_file.exists(),
            "a file we never create is not ours to delete"
        );
        assert!(
            unrelated_dir.join("holiday.png").exists(),
            "`remove_dir_all` over a directory the user named is data loss, not a wipe"
        );
        assert!(untouched_db.exists());
    }

    /// The predicate, on its own, because it is what the wipe's safety rests on and the
    /// case above can only reach the names it happens to construct.
    #[test]
    fn is_quarantine_name_recognises_only_what_quarantine_creates() {
        // Exactly the shape `quarantine_sqlite_file` builds: prefix plus a decimal
        // nanosecond stamp.
        assert!(is_quarantine_name("mausvoice.broken-1728000000000000000"));
        assert!(is_quarantine_name("mausvoice.broken-1"));

        // Every near miss. Each of these shares the prefix and is not ours.
        for name in [
            "mausvoice.broken-",          // empty stamp
            "mausvoice.broken-67890.bak", // the old test's case
            "mausvoice.broken-my-backup", // a user's directory, removed recursively before
            "mausvoice.broken-12a",       // not all digits
            "mausvoice.broken-1 ",        // trailing space
            "mausvoice.broken--1",        // sign
            "mausvoice.broken-1e3",       // exponent notation, not our format
            "mausvoice.db",
            "broken-1",
            "mausvoice.broken",
            "MAUSVOICE.BROKEN-1", // the prefix is case-sensitive
        ] {
            assert!(
                !is_quarantine_name(name),
                "{name:?} shares the prefix but is not a name this module creates"
            );
        }
    }

    #[test]
    fn quarantine_restores_moved_files_if_a_sidecar_rename_fails() {
        let temp = TempDb::new();
        let path = &temp.path;
        std::fs::write(path, b"db").unwrap();
        let journal = path.with_file_name("mausvoice.db-journal");
        std::fs::write(&journal, b"journal").unwrap();
        let dest_dir = temp.dir.join("dest");
        std::fs::create_dir(&dest_dir).unwrap();
        std::fs::create_dir(dest_dir.join("mausvoice.db-journal")).unwrap();
        rename_all_or_restore(&[
            (path.clone(), dest_dir.join("mausvoice.db")),
            (journal.clone(), dest_dir.join("mausvoice.db-journal")),
        ])
        .unwrap_err();
        assert!(path.exists());
        assert!(journal.exists());
        assert_eq!(std::fs::read(path).unwrap(), b"db");
        assert_eq!(std::fs::read(&journal).unwrap(), b"journal");
    }

    #[tokio::test]
    async fn corrupt_sqlite_file_is_quarantined_and_reopened() {
        let temp = TempDb::new();
        std::fs::write(&temp.path, b"this is not a sqlite database").unwrap();

        let recovered = open_app_database(&temp.path)
            .await
            .expect("corrupt bytes should quarantine and reopen");
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations")
            .fetch_one(&recovered)
            .await
            .unwrap();
        assert_eq!(count, migrations().len() as i64);
        recovered.close().await;
        assert_quarantined(&temp.dir, "corrupt bytes must be quarantined");
    }

    #[tokio::test]
    async fn a_failed_migration_row_surfaces_and_keeps_the_database() {
        let temp = TempDb::new();
        let path = &temp.path;
        let pool = try_open(path).await.expect("initial migrate");
        // One row, not all of them: a crash mid-migration leaves exactly the step
        // it was on flipped, and the code reads the lowest such version.
        let expected_version: i64 = sqlx::query_scalar("SELECT MIN(version) FROM _sqlx_migrations")
            .fetch_one(&pool)
            .await
            .unwrap();
        let affected =
            sqlx::query("UPDATE _sqlx_migrations SET success = false WHERE version = ?1")
                .bind(expected_version)
                .execute(&pool)
                .await
                .unwrap()
                .rows_affected();
        assert_eq!(affected, 1, "exactly the fixture row must be flipped");
        pool.close().await;

        // A crash mid-migration leaves `success = false` behind. The file is
        // perfectly readable; this build simply cannot say how far it got. It
        // used to be treated as corruption, which quarantined the database and
        // opened an empty one in its place — losing every transcription, key and
        // preference with nothing said.
        let error = open_app_database(path)
            .await
            .expect_err("a failed migration row must not be opened silently")
            .to_string();

        // The exact phrase the code builds. Asserting on the bare number would
        // pass for any message containing that digit, and every version here is
        // small enough that any message contains one.
        assert!(
            error.contains(&format!("migration {expected_version} previously failed")),
            "the failing version must be named so it can be looked up: {error}"
        );
        assert!(
            error.contains("needs recovery"),
            "the message must say the row is recoverable: {error}"
        );
        assert!(path.exists(), "the database file must be left where it was");
        assert_not_quarantined(&temp.dir, "a readable database must not be quarantined");
    }

    #[tokio::test]
    async fn unknown_recorded_migration_version_is_surfaced_not_quarantined() {
        let temp = TempDb::new();
        let path = &temp.path;
        let pool = try_open(path).await.expect("initial migrate");
        sqlx::query(
            "INSERT INTO _sqlx_migrations
             (version, description, success, checksum, execution_time)
             VALUES (9999, 'ghost', true, x'deadbeef', 0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;

        // A version this build does not ship (a newer release wrote it) is a
        // forward-compatible downgrade, not corruption: the open must fail
        // loudly but leave the user's database file untouched.
        let result = open_app_database(path).await;
        assert!(
            result.is_err(),
            "newer-schema database must be surfaced, not silently opened"
        );
        assert_not_quarantined(
            &temp.dir,
            "a newer-schema database must never be quarantined",
        );
        assert!(path.exists(), "the original database must be preserved");
    }

    #[tokio::test]
    async fn existing_database_is_upgraded_to_head_without_quarantine() {
        let temp = TempDb::new();
        let path = &temp.path;
        let up_migrations: Vec<_> = migrations()
            .into_iter()
            .filter(|migration| matches!(migration.kind, tauri_plugin_sql::MigrationKind::Up))
            .collect();
        assert!(
            up_migrations.len() >= 2,
            "test needs at least two migrations"
        );

        // Reproduce the state an existing database is in before an upgrade: all but
        // the newest migration applied, with each recorded in `_sqlx_migrations`.
        //
        // These rows use `migration_checksum`, which is what this build writes. For a
        // database whose last write came from `sqlx` on an LF checkout those are the
        // same bytes -- but not for one written from a CRLF checkout, which is the case
        // `a_database_recorded_by_sqlx_with_crlf_line_endings_still_opens` exists for.
        {
            let pool = connect_pool(path).await.expect("connect");
            sqlx::query(
                "CREATE TABLE _sqlx_migrations (
                    version BIGINT PRIMARY KEY,
                    description TEXT NOT NULL,
                    installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    success BOOLEAN NOT NULL,
                    checksum BLOB NOT NULL,
                    execution_time BIGINT NOT NULL
                )",
            )
            .execute(&pool)
            .await
            .expect("create _sqlx_migrations");
            for migration in &up_migrations[..up_migrations.len() - 1] {
                let checksum = migration_checksum(migration.sql);
                sqlx::raw_sql(migration.sql)
                    .execute(&pool)
                    .await
                    .expect("apply prior migration");
                sqlx::query(
                    "INSERT INTO _sqlx_migrations
                     (version, description, success, checksum, execution_time)
                     VALUES (?1, ?2, true, ?3, 0)",
                )
                .bind(migration.version)
                .bind(migration.description)
                .bind(&checksum)
                .execute(&pool)
                .await
                .expect("record prior migration");
            }
            pool.close().await;
        }

        let upgraded = open_app_database(path)
            .await
            .expect("an existing database must upgrade, not fail");
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations")
            .fetch_one(&upgraded)
            .await
            .unwrap();
        assert_eq!(
            count,
            up_migrations.len() as i64,
            "the remaining migration must be applied on upgrade"
        );
        upgraded.close().await;
        assert_not_quarantined(
            &temp.dir,
            "a routine upgrade must never quarantine the database",
        );
    }

    /// A database whose `069` row was written by a build carrying one of the two
    /// comment-only variants must still open.
    ///
    /// This is the reviewer's scenario exactly. `069_consolidated_v0_1_6_schema.sql` has three
    /// blobs across the refs this repository carries, and `bc17875a` -- "Correct four comments
    /// that still claimed migration 070 was never used" -- diverged two of them by changing
    /// three lines, every one a comment. So those builds produce the identical schema and this
    /// build refuses their databases: the recorded digest is of their text, the computed one
    /// of this build's, and the mismatch path returns `OpenError` WITHOUT quarantining, so
    /// there is no in-app way back.
    ///
    /// Each of the two digests is exercised, and so is the scoping: the same digest recorded
    /// against a DIFFERENT version is still refused, because the table is keyed on 69 and a
    /// general allowance would stop being an allowance.
    #[tokio::test]
    async fn a_database_recorded_from_a_superseded_069_variant_still_opens() {
        assert_eq!(
            super::MIGRATION_069_SUPERSEDED_DIGESTS.len(),
            2,
            "one entry per distinct historical blob; a third ref pair shares one of them"
        );
        for (hex, origin) in super::MIGRATION_069_SUPERSEDED_DIGESTS {
            let temp = TempDb::new();
            let path = &temp.path;
            let up_to_69: Vec<_> = migrations()
                .into_iter()
                .filter(|m| {
                    matches!(m.kind, tauri_plugin_sql::MigrationKind::Up) && m.version <= 69
                })
                .collect();
            assert!(
                up_to_69.iter().any(|m| m.version == 69),
                "migration 069 must be in the set this test drives"
            );

            {
                let pool = connect_pool(path).await.expect("connect");
                sqlx::query(
                    "CREATE TABLE _sqlx_migrations (
                        version BIGINT PRIMARY KEY,
                        description TEXT NOT NULL,
                        installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        success BOOLEAN NOT NULL,
                        checksum BLOB NOT NULL,
                        execution_time BIGINT NOT NULL
                    )",
                )
                .execute(&pool)
                .await
                .expect("create _sqlx_migrations");
                for migration in &up_to_69 {
                    sqlx::raw_sql(migration.sql)
                        .execute(&pool)
                        .await
                        .expect("apply prior migration");
                    // The superseded build recorded its OWN text's digest for 069 and this
                    // build's canonical digest for everything else, which is what a branch
                    // carrying only the comment change would have done.
                    let checksum = if migration.version == 69 {
                        super::decode_sha384_hex(hex)
                    } else {
                        migration_checksum(migration.sql)
                    };
                    sqlx::query(
                        "INSERT INTO _sqlx_migrations
                         (version, description, success, checksum, execution_time)
                         VALUES (?1, ?2, true, ?3, 0)",
                    )
                    .bind(migration.version)
                    .bind(migration.description)
                    .bind(checksum)
                    .execute(&pool)
                    .await
                    .expect("record prior migration");
                }
                pool.close().await;
            }

            // The digest must genuinely NOT be this build's, or the test proves nothing.
            let this_builds = migrations()
                .into_iter()
                .find(|m| m.version == 69)
                .map(|m| migration_checksum(m.sql))
                .expect("069 is registered");
            assert_ne!(
                this_builds,
                super::decode_sha384_hex(hex),
                "the {origin} digest must differ from this build's"
            );

            let opened = open_app_database(path).await.unwrap_or_else(|err| {
                panic!(
                    "a database written by a build carrying the {origin} variant of 069 \
                        must open under this one, and did not: {err:?}"
                )
            });
            opened.close().await;
            assert_not_quarantined(
                &temp.dir,
                "a ledger row whose migration only gained a comment is not corruption",
            );

            // And the scoping: the same digest against a different version is a modified
            // migration, and is refused.
            let sql_69 = migrations()
                .into_iter()
                .find(|m| m.version == 69)
                .map(|m| m.sql)
                .expect("069 is registered");
            assert!(
                !migration_checksum_matches(68, &super::decode_sha384_hex(hex), sql_69),
                "the allowance is keyed on 69 and must not generalise to another version"
            );
            assert!(
                migration_checksum_matches(69, &super::decode_sha384_hex(hex), sql_69),
                "and the same digest IS accepted for 69, or the row above proves nothing"
            );
        }
    }

    /// The ledger row `sqlx` wrote, and this build has to accept it.
    ///
    /// `sqlx` hashes `sql.as_bytes()` with no normalization. This build's own digest folds
    /// CRLF to LF first. The SQL reaches the binary by `include_str!`, so those two agree
    /// only when the checkout that built it had LF in the `.sql` files -- and before this
    /// branch there was no `.gitattributes` to say so, while `build-desktop.yml` has a
    /// `windows-latest` leg. A row recorded from a CRLF checkout therefore holds a digest
    /// this build computes differently, and the mismatch path returns `OpenError` WITHOUT
    /// quarantining: the file is left exactly where it is and the app cannot open it, with
    /// no in-app way back. Measured on `000_schema.sql`: the LF digest begins `7acd05d8`,
    /// the CRLF digest `0b0189df`.
    ///
    /// This is the end-to-end form; `migration_checksum_accepts_the_sqlx_form` is the unit
    /// form. The negative is the sibling test below, which asserts a genuinely modified
    /// migration still refuses to open -- accepting a second form is only safe because a
    /// changed file matches neither.
    #[tokio::test]
    async fn a_database_recorded_by_sqlx_with_crlf_line_endings_still_opens() {
        let temp = TempDb::new();
        let path = &temp.path;
        let up_migrations: Vec<_> = migrations()
            .into_iter()
            .filter(|migration| matches!(migration.kind, tauri_plugin_sql::MigrationKind::Up))
            .collect();
        assert!(
            up_migrations.len() >= 2,
            "test needs at least two migrations"
        );

        {
            let pool = connect_pool(path).await.expect("connect");
            sqlx::query(
                "CREATE TABLE _sqlx_migrations (
                    version BIGINT PRIMARY KEY,
                    description TEXT NOT NULL,
                    installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    success BOOLEAN NOT NULL,
                    checksum BLOB NOT NULL,
                    execution_time BIGINT NOT NULL
                )",
            )
            .execute(&pool)
            .await
            .expect("create _sqlx_migrations");
            for migration in &up_migrations[..up_migrations.len() - 1] {
                // The SQL as a CRLF checkout would have held it, and the digest `sqlx`
                // takes of exactly those bytes.
                let crlf = migration.sql.replace("\r\n", "\n").replace("\n", "\r\n");
                assert_ne!(
                    crlf, migration.sql,
                    "test needs a migration with a newline to fold, or it proves nothing"
                );
                sqlx::raw_sql(migration.sql)
                    .execute(&pool)
                    .await
                    .expect("apply prior migration");
                sqlx::query(
                    "INSERT INTO _sqlx_migrations
                     (version, description, success, checksum, execution_time)
                     VALUES (?1, ?2, true, ?3, 0)",
                )
                .bind(migration.version)
                .bind(migration.description)
                // Stated independently of the function under test, for the same reason
                // as in the unit test: a row sqlx wrote is Sha384 over the CRLF bytes.
                .bind(Sha384::digest(crlf.as_bytes()).to_vec())
                .execute(&pool)
                .await
                .expect("record prior migration with the sqlx digest");
            }
            pool.close().await;
        }

        let opened = open_app_database(path)
            .await
            .expect("a database sqlx recorded must still open under this build");
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations")
            .fetch_one(&opened)
            .await
            .unwrap();
        assert_eq!(
            count,
            up_migrations.len() as i64,
            "the remaining migration must be applied on upgrade"
        );
        opened.close().await;
        assert_not_quarantined(
            &temp.dir,
            "a row sqlx wrote is not corruption and must never quarantine the database",
        );
    }

    /// The unit form of the same property, plus the negative that makes the first one safe.
    ///
    /// The expected CRLF digest is written out here as a SHA-384 over a literal CRLF
    /// string, NOT as `historical_migration_checksum(&crlf)`. An earlier version computed it
    /// with the function under test, so the test agreed with a wrong implementation --
    /// which is how `historical_migration_checksum` came to hash the LF text and leave the
    /// real CRLF row matching neither arm.
    #[test]
    fn migration_checksum_accepts_the_sqlx_form() {
        let lf = "CREATE TABLE test (\n  id INTEGER PRIMARY KEY\n);\n";
        let crlf = "CREATE TABLE test (\r\n  id INTEGER PRIMARY KEY\r\n);\r\n";

        // What a CRLF checkout's `sqlx` recorded, stated independently.
        let crlf_digest: Vec<u8> = Sha384::digest(crlf.as_bytes()).to_vec();
        assert_eq!(
            crlf_digest,
            super::historical_migration_checksum(lf),
            "the historical form must be the digest OF THE CRLF TEXT, not of the LF text"
        );
        assert_eq!(
            crlf_digest,
            super::historical_migration_checksum(crlf),
            "line endings must not change which variant is hashed"
        );

        // Canonical: one digest regardless of line endings, and that is what gets written.
        assert_eq!(migration_checksum(lf), migration_checksum(crlf));
        assert_ne!(
            migration_checksum(lf),
            crlf_digest,
            "the two accepted forms must be different values, or the second arm is dead"
        );

        // Accepted: the canonical form, and the form sqlx recorded from a CRLF checkout.
        assert!(migration_checksum_matches(70, &migration_checksum(lf), lf));
        assert!(migration_checksum_matches(70, &crlf_digest, lf));
        assert!(migration_checksum_matches(70, &crlf_digest, crlf));

        // Refused: a genuinely modified migration. This is what stops the second accepted
        // form from becoming a loophole.
        let modified_crlf = crlf.replace("test", "other");
        assert!(!migration_checksum_matches(
            70,
            &Sha384::digest(modified_crlf.as_bytes()),
            crlf
        ));
        assert!(!migration_checksum_matches(70, b"deadbeef", lf));
        assert!(!migration_checksum_matches(70, &[], lf));
    }

    #[tokio::test]
    async fn multiple_unknown_recorded_migration_versions_preserve_the_database() {
        let temp = TempDb::new();
        let path = &temp.path;
        let pool = try_open(path).await.expect("initial migrate");
        // The recorded set must be a realistic mix: shipped versions, plus
        // two newer-release versions interleaved with the existing applied
        // set. Iteration order over the applied HashMap is non-deterministic,
        // so this test exercises every position the unknown rows can land in.
        sqlx::query(
            "INSERT INTO _sqlx_migrations
             (version, description, success, checksum, execution_time)
             VALUES (9998, 'future_a', true, x'deadbeef', 0),
                    (9999, 'future_b', true, x'feedface', 0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;

        let result = open_app_database(path).await;
        assert!(
            result.is_err(),
            "a database with newer-release migrations must be surfaced, not silently opened"
        );
        assert_not_quarantined(
            &temp.dir,
            "a downgrade with multiple newer versions must never quarantine the database",
        );
        assert!(
            path.exists(),
            "the original database must be preserved regardless of how many newer versions are present"
        );
    }

    #[test]
    fn migration_checksum_is_stable_across_lf_and_crlf() {
        let lf_sql = "CREATE TABLE test (\n  id INTEGER PRIMARY KEY,\n  name TEXT NOT NULL\n);\n";
        let crlf_sql =
            "CREATE TABLE test (\r\n  id INTEGER PRIMARY KEY,\r\n  name TEXT NOT NULL\r\n);\r\n";
        let lf_hash = migration_checksum(lf_sql);
        let crlf_hash = migration_checksum(crlf_sql);
        assert_eq!(
            lf_hash, crlf_hash,
            "CRLF and LF must produce identical SHA-384 checksums"
        );
    }

    #[tokio::test]
    async fn checksum_mismatch_surfaces_for_repair_and_leaves_the_database_in_place() {
        // A migration file that no longer matches the checksum recorded in the
        // ledger is a disagreement about this build's history, not damage to the
        // database. The file is still perfectly readable, so the open must fail
        // loudly and leave it alone. Quarantining here would move the user's
        // transcriptions, keys and preferences aside and open an empty database
        // in their place without telling them, so this asserts the opposite:
        // the error surfaces, nothing is quarantined, and the data survives.
        let temp = TempDb::new();
        let path = &temp.path;
        let pool = try_open(path).await.expect("initial migrate");
        sqlx::query(
            "INSERT INTO transcriptions (id, transcript, timestamp)
             VALUES ('keep-me', 'do not lose this', 1)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("UPDATE _sqlx_migrations SET checksum = x'deadbeef' WHERE version = 1")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;

        let error = open_app_database(path)
            .await
            .expect_err("a checksum mismatch must surface, not be papered over");
        assert!(
            error.contains("was previously applied but has been modified")
                && error.contains("readable"),
            "the mismatch must be surfaced for repair, got: {error}"
        );

        assert!(
            path.exists(),
            "the original database file must be left in place for repair"
        );
        assert_not_quarantined(
            &temp.dir,
            "a ledger disagreement must never quarantine the database",
        );

        // The schema and the user's data are all still there, and the ledger row
        // is untouched, so the mismatch is diagnosable and repairable in place.
        let check = connect_pool(path)
            .await
            .expect("the file is still openable");
        let transcript: String =
            sqlx::query_scalar("SELECT transcript FROM transcriptions WHERE id = 'keep-me'")
                .fetch_one(&check)
                .await
                .unwrap();
        assert_eq!(
            transcript, "do not lose this",
            "the user's data must survive a surfaced mismatch"
        );
        let recorded: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM _sqlx_migrations WHERE version = 1 AND checksum = x'deadbeef'",
        )
        .fetch_one(&check)
        .await
        .unwrap();
        assert_eq!(
            recorded, 1,
            "the mismatched ledger row must be left in place, not deleted or rewritten"
        );
        check.close().await;
    }

    #[tokio::test]
    async fn delete_quarantined_databases_removes_all_broken_archives() {
        let temp = TempDb::new();
        let path = &temp.path;
        // Genuine file-level damage, which is the only thing that quarantines
        // now. A ledger disagreement surfaces for repair and leaves the file in
        // place, so it would never produce an archive for this to delete.
        std::fs::write(path, b"this is not a sqlite database").unwrap();

        let recovered = open_app_database(path)
            .await
            .expect("a corrupt file quarantines and reopens");
        recovered.close().await;

        assert_quarantined(&temp.dir, "broken archive must exist after recovery");

        let removed =
            delete_quarantined_databases(&temp.dir).expect("quarantine deletion succeeds");
        assert!(
            removed >= 1,
            "must delete at least one quarantined directory"
        );

        assert_not_quarantined(
            &temp.dir,
            "no broken archives should remain after explicit deletion",
        );
    }

    async fn pre_consolidation_pool(path: &Path) -> SqlitePool {
        let pool = connect_pool(path).await.expect("connect to fresh db");

        sqlx::query(
            "CREATE TABLE IF NOT EXISTS _sqlx_migrations (
                version BIGINT PRIMARY KEY,
                description TEXT NOT NULL,
                installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                success BOOLEAN NOT NULL,
                checksum BLOB NOT NULL,
                execution_time BIGINT NOT NULL
            )",
        )
        .execute(&pool)
        .await
        .unwrap();

        // Everything the 0.1.5 release shipped, applied and recorded exactly
        // as the previous migrator wrote it; only step 69 stays pending.
        for migration in migrations() {
            if migration.version >= 69 {
                continue;
            }
            sqlx::raw_sql(migration.sql)
                .execute(&pool)
                .await
                .expect("apply 0.1.5-era migration");
            let checksum = migration_checksum(migration.sql);
            sqlx::query(
                "INSERT INTO _sqlx_migrations
                 (version, description, success, checksum, execution_time)
                 VALUES (?1, ?2, 1, ?3, 0)",
            )
            .bind(migration.version)
            .bind(migration.description)
            .bind(&checksum)
            .execute(&pool)
            .await
            .unwrap();
        }

        pool
    }

    #[tokio::test]
    async fn migration_69_upgrades_legacy_1_5_x_db() {
        // Simulate a user upgrading from a 0.1.5 build (its last migration
        // was 68): apply and record every earlier migration for real, seed
        // era-typical rows, then open. The single consolidated step 69 must
        // rebuild the post-0.1.5 tables, preserve the rows, materialize the
        // new defaults, and drop the retired is_enterprise column.
        let temp = TempDb::new();
        let path = &temp.path;
        let pool = pre_consolidation_pool(path).await;

        // Era-typical rows that must survive the rebuild.
        sqlx::query(
            "INSERT INTO user_preferences (user_id, transcription_mode, is_enterprise)
             VALUES ('legacy-user', char(99, 108, 111, 117, 100), 1)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO transcriptions (id, transcript, timestamp)
             VALUES ('legacy', 'old', 1)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO user_profiles (id, name, bio)
             VALUES ('legacy-user', 'Legacy', '')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO api_keys (id, name, provider, created_at, salt, key_hash, key_ciphertext)
             VALUES ('k1', 'Key', 'openai', 1, 'salt', 'hash', 'cipher')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO tones (id, name, prompt_template, created_at)
             VALUES ('tone1', 'Casual', 'be casual', 1)",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;

        // Reopen: the consolidated step 69 runs. A failing upgrade would fail
        // the try_open call below.
        let pool = try_open(path).await.expect("upgrade opens");

        // Step 69 recorded exactly once; the recorded set matches the build.
        let recorded: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM _sqlx_migrations WHERE version = 69 AND success = 1",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(recorded, 1);
        let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(total, migrations().len() as i64);

        // Cloud preference was rewritten and the row survived the rebuild;
        // consolidated columns arrived at their defaults.
        let prefs = sqlx::query(
            "SELECT transcription_mode, update_channel, expansion_flags,
                    pill_reset_monitor_strategy, spoken_commands_enabled
             FROM user_preferences WHERE user_id = 'legacy-user'",
        )
        .fetch_one(&pool)
        .await
        .expect("legacy preferences row survives");
        assert_eq!(
            prefs.try_get::<String, _>("transcription_mode").unwrap(),
            "local"
        );
        assert_eq!(
            prefs.try_get::<String, _>("update_channel").unwrap(),
            "stable"
        );
        assert_eq!(prefs.try_get::<String, _>("expansion_flags").unwrap(), "{}");
        assert_eq!(
            prefs
                .try_get::<String, _>("pill_reset_monitor_strategy")
                .unwrap(),
            "current"
        );
        assert!(prefs.try_get::<i64, _>("spoken_commands_enabled").unwrap() == 1);

        // is_enterprise is gone.
        let enterprise: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pragma_table_info('user_preferences')
             WHERE name = 'is_enterprise'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(enterprise, 0);

        // Legacy transcription row survives; new columns exist as NULLs and
        // accept writes.
        let legacy = sqlx::query(
            "SELECT post_process_provider, post_process_failed, post_process_error
             FROM transcriptions WHERE id = 'legacy'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            legacy
                .try_get::<Option<String>, _>("post_process_provider")
                .unwrap(),
            None
        );
        assert_eq!(
            legacy
                .try_get::<Option<i64>, _>("post_process_failed")
                .unwrap(),
            None
        );
        sqlx::query(
            "INSERT INTO transcriptions
                (id, transcript, timestamp,
                 post_process_provider, post_process_failed, post_process_error, post_process_model)
             VALUES ('new', 'new', 2, 'cerebras', 1, '402 out of credit', 'whisper-large')",
        )
        .execute(&pool)
        .await
        .unwrap();

        // post_process_fallback is the marker for a row saved after
        // post-processing failed and local fast styling took over. It has to
        // survive a round trip or the row reads as clean after a reload.
        let fallback_null =
            sqlx::query("SELECT post_process_fallback FROM transcriptions WHERE id = 'legacy'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            fallback_null
                .try_get::<Option<i64>, _>("post_process_fallback")
                .unwrap(),
            None
        );
        sqlx::query("UPDATE transcriptions SET post_process_fallback = 1 WHERE id = 'new'")
            .execute(&pool)
            .await
            .unwrap();
        let fallback_read =
            sqlx::query("SELECT post_process_fallback FROM transcriptions WHERE id = 'new'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            fallback_read
                .try_get::<Option<bool>, _>("post_process_fallback")
                .unwrap(),
            Some(true)
        );

        // interaction_feedback_volume materialized on the pre-upgrade profile.
        let volume = sqlx::query(
            "SELECT interaction_feedback_volume FROM user_profiles WHERE id = 'legacy-user'",
        )
        .fetch_one(&pool)
        .await
        .expect("legacy profile row survives")
        .try_get::<f64, _>("interaction_feedback_volume")
        .unwrap();
        let expected = f64::from(crate::domain::user::DEFAULT_INTERACTION_FEEDBACK_VOLUME);
        assert!(
            (volume - expected).abs() < 1e-6,
            "volume default {volume} != {expected}"
        );

        // api_keys.transcription_path and tones structured fields exist.
        let key_path_null: Option<String> =
            sqlx::query("SELECT transcription_path FROM api_keys WHERE id = 'k1'")
                .fetch_one(&pool)
                .await
                .unwrap()
                .try_get("transcription_path")
                .unwrap();
        assert_eq!(key_path_null, None);
        let tone = sqlx::query("SELECT category, name FROM tones WHERE id = 'tone1'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(tone.try_get::<Option<String>, _>("category").unwrap(), None);
        assert_eq!(tone.try_get::<String, _>("name").unwrap(), "Casual");

        // Verify post-069 onboarded CHECK constraint: accepts 0 and 1, rejects invalid integers like 2.
        sqlx::query(
            "INSERT INTO user_profiles (id, name, bio, onboarded)
             VALUES ('valid-0', 'Valid Zero', '', 0)",
        )
        .execute(&pool)
        .await
        .expect("onboarded=0 accepted");

        sqlx::query(
            "INSERT INTO user_profiles (id, name, bio, onboarded)
             VALUES ('valid-1', 'Valid One', '', 1)",
        )
        .execute(&pool)
        .await
        .expect("onboarded=1 accepted");

        let reject_two = sqlx::query(
            "INSERT INTO user_profiles (id, name, bio, onboarded)
             VALUES ('invalid-2', 'Invalid Two', '', 2)",
        )
        .execute(&pool)
        .await;
        assert!(
            reject_two.is_err(),
            "CHECK (onboarded IN (0, 1)) must reject onboarded=2",
        );

        pool.close().await;
    }

    async fn intermediate_pool(path: &Path) -> SqlitePool {
        let pool = pre_consolidation_pool(path).await;
        sqlx::raw_sql(include_str!("fixtures/intermediate_profile.sql"))
            .execute(&pool)
            .await
            .expect("seed intermediate profile");
        pool
    }

    async fn profile_snapshots(pool: &SqlitePool) -> Vec<(String, Vec<String>)> {
        let mut snapshots = Vec::new();
        for table in [
            "user_preferences",
            "tones",
            "transcriptions",
            "user_profiles",
            "api_keys",
        ] {
            let columns: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info(?1)")
                .bind(table)
                .fetch_all(pool)
                .await
                .unwrap();
            let fields = columns
                .iter()
                .filter(|column| {
                    // Consolidation intentionally removes enterprise state and
                    // rewrites these three cloud modes. Assert those separately.
                    table != "user_preferences"
                        || !matches!(
                            column.as_str(),
                            "is_enterprise"
                                | "transcription_mode"
                                | "post_processing_mode"
                                | "agent_mode"
                        )
                })
                .map(|column| {
                    format!(
                        "'{}', \"{}\"",
                        column.replace('\'', "''"),
                        column.replace('"', "\"\"")
                    )
                })
                .collect::<Vec<_>>()
                .join(", ");
            let key = if table == "user_preferences" {
                "user_id"
            } else {
                "id"
            };
            let query = format!("SELECT json_object({fields}) FROM {table} ORDER BY {key}");
            let rows = sqlx::query_scalar(&query).fetch_all(pool).await.unwrap();
            snapshots.push((query, rows));
        }
        snapshots
    }

    async fn assert_profile_snapshots(pool: &SqlitePool, snapshots: &[(String, Vec<String>)]) {
        for (query, before) in snapshots {
            let after: Vec<String> = sqlx::query_scalar(query).fetch_all(pool).await.unwrap();
            assert_eq!(&after, before, "profile changed for {query}");
        }
    }

    #[tokio::test]
    async fn consolidation_preserves_intermediate_values_and_reopens() {
        let temp = TempDb::new();
        let pool = intermediate_pool(&temp.path).await;
        let snapshots = profile_snapshots(&pool).await;
        pool.close().await;

        let upgraded = open_app_database(&temp.path)
            .await
            .expect("upgrade intermediate profile");
        assert_profile_snapshots(&upgraded, &snapshots).await;
        let modes: (String, String, String) = sqlx::query_as(
            "SELECT transcription_mode, post_processing_mode, agent_mode
             FROM user_preferences WHERE user_id = 'intermediate-user'",
        )
        .fetch_one(&upgraded)
        .await
        .unwrap();
        assert_eq!(modes, ("local".into(), "none".into(), "none".into()));
        let retired: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations WHERE version IN (75, 87)")
                .fetch_one(&upgraded)
                .await
                .unwrap();
        assert_eq!(retired, 0);
        let checksum: Vec<u8> =
            sqlx::query_scalar("SELECT checksum FROM _sqlx_migrations WHERE version = 69")
                .fetch_one(&upgraded)
                .await
                .unwrap();
        assert_eq!(
            checksum,
            migration_checksum(super::super::CONSOLIDATED_V0_1_6_MIGRATION_SQL)
        );
        upgraded.close().await;

        let reopened = open_app_database(&temp.path)
            .await
            .expect("reopen consolidated profile");
        assert_profile_snapshots(&reopened, &snapshots).await;
        reopened.close().await;
    }

    #[tokio::test]
    async fn consolidation_preserves_partial_intermediate_schema() {
        let temp = TempDb::new();
        let pool = pre_consolidation_pool(&temp.path).await;
        sqlx::raw_sql(
            "ALTER TABLE tones ADD COLUMN category TEXT;
            INSERT INTO tones (id, name, prompt_template, created_at, category)
            VALUES ('partial-style', 'Partial', 'Keep it', 1, 'Existing category');",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;
        let upgraded = open_app_database(&temp.path)
            .await
            .expect("upgrade partial profile");
        let fields: (String, Option<String>, Option<String>) = sqlx::query_as(
            "SELECT category, output_length, example_input_output FROM tones WHERE id = 'partial-style'",
        ).fetch_one(&upgraded).await.unwrap();
        assert_eq!(fields, ("Existing category".into(), None, None));
        upgraded.close().await;
    }

    #[tokio::test]
    async fn failed_consolidation_preserves_values_and_migration_records_for_retry() {
        let temp = TempDb::new();
        let pool = intermediate_pool(&temp.path).await;
        let snapshots = profile_snapshots(&pool).await;
        // Fail after rebuilding tables, while retiring the old migration rows.
        sqlx::raw_sql(
            "CREATE TRIGGER reject_retirement BEFORE DELETE ON _sqlx_migrations
            WHEN OLD.version = 87 BEGIN SELECT RAISE(ABORT, 'retirement blocked'); END;",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;
        let error = open_app_database(&temp.path)
            .await
            .expect_err("retirement must fail");
        assert!(error.contains("retirement blocked"), "{error}");

        let original = connect_pool(&temp.path).await.unwrap();
        assert_profile_snapshots(&original, &snapshots).await;
        let versions: Vec<i64> = sqlx::query_scalar(
            "SELECT version FROM _sqlx_migrations WHERE version IN (69, 75, 87) ORDER BY version",
        )
        .fetch_all(&original)
        .await
        .unwrap();
        assert_eq!(versions, vec![75, 87]);
        let mode: String = sqlx::query_scalar(
            "SELECT transcription_mode FROM user_preferences WHERE user_id = 'intermediate-user'",
        )
        .fetch_one(&original)
        .await
        .unwrap();
        assert_eq!(mode, "cloud");
        sqlx::query("DROP TRIGGER reject_retirement")
            .execute(&original)
            .await
            .unwrap();
        original.close().await;

        let retried = open_app_database(&temp.path)
            .await
            .expect("retry consolidation");
        assert_profile_snapshots(&retried, &snapshots).await;
        retried.close().await;
    }

    #[tokio::test]
    async fn checksum_failure_does_not_retire_intermediate_records() {
        let temp = TempDb::new();
        let pool = intermediate_pool(&temp.path).await;
        sqlx::query("UPDATE _sqlx_migrations SET checksum = x'badbad' WHERE version = 1")
            .execute(&pool)
            .await
            .unwrap();
        let error = apply_migrations(&pool).await.expect_err("invalid checksum");
        // `Other`, not `Integrity`: the file is readable and only the ledger
        // disagrees, so this must be repairable in place rather than quarantined.
        assert!(
            matches!(error, OpenError::Other(_)),
            "a checksum mismatch is not file damage, got: {error:?}"
        );
        let versions: Vec<i64> = sqlx::query_scalar(
            "SELECT version FROM _sqlx_migrations WHERE version IN (69, 75, 87) ORDER BY version",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(versions, vec![75, 87]);
        pool.close().await;
    }

    #[tokio::test]
    async fn consolidated_intermediate_migration_rows_are_retired() {
        // Databases written by intermediate builds recorded the individual
        // migrations (71-87) that the 0.1.6 release folded into step 69.
        // Those rows must retire silently on open — not surface as a
        // downgrade and not quarantine the file. The descriptions are the
        // names those steps actually shipped under, because retirement matches
        // on `(version, description)`.
        let temp = TempDb::new();
        let path = &temp.path;
        let pool = try_open(path).await.expect("initial migrate");
        sqlx::query(
            "INSERT INTO _sqlx_migrations
             (version, description, success, checksum, execution_time)
             VALUES (75, 'expansion_flags', true, x'deadbeef', 0),
                    (87, 'eleven_labs_keyterms_enabled', true, x'feedface', 0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;

        let reopened = open_app_database(path)
            .await
            .expect("intermediate rows retire cleanly");
        let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations")
            .fetch_one(&reopened)
            .await
            .unwrap();
        assert_eq!(total, migrations().len() as i64, "retired rows are gone");
        let ghosts: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations WHERE version IN (75, 87)")
                .fetch_one(&reopened)
                .await
                .unwrap();
        assert_eq!(ghosts, 0);
        reopened.close().await;
        assert_not_quarantined(
            &temp.dir,
            "retiring consolidation-era rows must never quarantine the database",
        );
    }

    #[tokio::test]
    async fn a_colliding_row_at_070_names_the_step_instead_of_reporting_a_downgrade() {
        // 070 used to be one of the three unused numbers in the 070-to-088 range,
        // and this build spends it on `post_process_fallback`. That changes what a
        // foreign ledger row at 70 does, and the doc comment on
        // RETIRED_CONSOLIDATION_ERA_VERSIONS states the new outcome, so pin it
        // here rather than leave it as prose that can rot the way the "three gaps"
        // wording did.
        //
        // While 070 was unused, a row at 70 was absent from the current migration
        // set and surfaced as "is recorded but is not in the current migration
        // set". It is a configured migration now, so that branch cannot fire for
        // it: control reaches the checksum comparison, the stored checksum
        // disagrees, and the open fails naming the number and the step that owns
        // it. Still refuses to open -- only the diagnosis changed.
        let temp = TempDb::new();
        let path = &temp.path;
        let pool = try_open(path).await.expect("initial migrate");
        // UPDATE, not INSERT: `try_open` has already applied this build's 070, so
        // the row is there and 70 is the primary key. Replacing its recorded
        // history is also the faithful shape of the collision -- some other line
        // really did record a step of its own under this number.
        sqlx::query(
            "UPDATE _sqlx_migrations
             SET description = 'never_shipped', checksum = x'deadbeef'
             WHERE version = ?1",
        )
        .bind(70_i64)
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;

        let error = open_app_database(path)
            .await
            .expect_err("a checksum disagreement at 70 must not open silently");
        assert!(
            !error.contains("not in the current migration set"),
            "70 is a configured migration now, so it must not be reported as a downgrade, got: {error}"
        );
        assert!(
            error.contains(
                "migration 70 (post_process_fallback) was previously applied but has been modified"
            ),
            "the open must name the step that owns the number, got: {error}"
        );
        assert_not_quarantined(
            &temp.dir,
            "a checksum disagreement is a repairable disagreement about history, not corruption",
        );
    }

    /// The upgrade path for a database the released 0.1.6 actually wrote.
    ///
    /// The names below are transcribed from `0.1.6`'s own migration registrations, NOT from
    /// `RETIRED_CONSOLIDATION_ERA_VERSIONS` -- transcribing them from the list would make
    /// this agree with any typo in it, which is how `073` and `074` shipped names with a
    /// leading `add_` and a list without it, and the retirement tests stayed green because
    /// the fixture they used covered only 075 and 087.
    ///
    /// The failure this covers is not subtle and not survivable: the open is refused before
    /// any migration runs, and the refusal path deliberately does not quarantine, so the
    /// file stays where it is and the app reports it cannot open the database.
    #[tokio::test]
    async fn a_database_written_by_the_released_0_1_6_upgrades() {
        for (version, description) in [
            (71_i64, "remove_cloud_modes"),
            (72_i64, "drop_is_enterprise"),
            (73_i64, "add_pill_reset_monitor_strategy"),
            (74_i64, "add_always_request_admin_on_startup"),
        ] {
            let temp = TempDb::new();
            let path = &temp.path;
            let pool = try_open(path).await.expect("initial migrate");
            sqlx::query(
                "INSERT INTO _sqlx_migrations
                 (version, description, success, checksum, execution_time)
                 VALUES (?1, ?2, true, x'deadbeef', 0)",
            )
            .bind(version)
            .bind(description)
            .execute(&pool)
            .await
            .unwrap();
            pool.close().await;

            let opened = open_app_database(path).await.unwrap_or_else(|error| {
                panic!(
                    "a database recording {version} as {description:?} is one the released \
                     0.1.6 wrote, so this build must open it; got: {error}"
                )
            });

            // Retired, not left behind: the row is deleted rather than deleted-along-with,
            // so a later merge from one of the colliding branches cannot re-run its step.
            let survivors: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations WHERE version = ?1")
                    .bind(version)
                    .fetch_one(&opened)
                    .await
                    .unwrap();
            assert_eq!(
                survivors, 0,
                "version {version} was retired from the set but its row survived"
            );
            opened.close().await;
            assert_not_quarantined(
                &temp.dir,
                "a folded consolidation-era row is not damage and must never quarantine",
            );
        }
    }

    #[tokio::test]
    async fn unretired_consolidation_era_numbers_surface_as_a_downgrade() {
        // 080 and 088 are the numbers in the 070 to 088 range that no ref has
        // used. A ledger row for one of them is not a folded consolidation
        // step, so it must be surfaced and left in place. Hard-deleting it
        // would hide a database written by a release this build knows nothing
        // about, which is what widening the retired list back to a range would
        // do.
        //
        // 070 is not in this list any more. It was the third unused number when
        // the list was written, and this build now spends it on the
        // post_process_fallback step, so a row for it is a real configured
        // migration that gets applied rather than a downgrade to surface. If
        // that step is ever folded into the consolidation step instead, 070
        // belongs in RETIRED_CONSOLIDATION_ERA_VERSIONS and this loop goes back
        // to three.
        for version in [80_i64, 88] {
            let temp = TempDb::new();
            let path = &temp.path;
            let pool = try_open(path).await.expect("initial migrate");
            sqlx::query(
                "INSERT INTO _sqlx_migrations
                 (version, description, success, checksum, execution_time)
                 VALUES (?1, 'never_shipped', true, x'deadbeef', 0)",
            )
            .bind(version)
            .execute(&pool)
            .await
            .unwrap();
            pool.close().await;

            let error = open_app_database(path)
                .await
                .expect_err("an unused version must not open silently");
            assert!(
                error.contains(&format!("migration {version} is recorded"))
                    && error.contains("not in the current migration set"),
                "version {version} must surface as a downgrade, got: {error}"
            );

            let check = connect_pool(path).await.expect("reconnect");
            let survivors: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations WHERE version = ?1")
                    .bind(version)
                    .fetch_one(&check)
                    .await
                    .unwrap();
            assert_eq!(
                survivors, 1,
                "the row for version {version} must survive, not be deleted"
            );
            check.close().await;
            assert_not_quarantined(
                &temp.dir,
                "surfacing version {version} must never quarantine the database",
            );
        }
    }

    #[tokio::test]
    async fn colliding_consolidation_era_number_with_a_foreign_description_is_not_retired() {
        // This is the whole point of keying retirement on (version, description)
        // rather than on the number alone. Other long-lived branches in this
        // repository reuse 076-079 for unrelated schemas — git history carries
        // `076_api_key_transcription_path`, `076_feature_preferences` and
        // `076_meetings`, and likewise `077_spoken_commands_enabled`,
        // `077_webhooks`, `078_snippets` and `079_translations` — and those
        // databases hold real rows. Retiring one of those rows by number would
        // delete the ledger record of what happened to a database holding real
        // meetings, webhook, snippet or translation rows, and any `ALTER TABLE`
        // in the folded-in step would then hard-fail the open.
        //
        // So for each of those numbers: a foreign description must surface as a
        // downgrade with the row left in place, while the description this build
        // actually retired must still retire silently, proving the tuple match
        // did not narrow retirement by accident.
        let collisions = [
            (76_i64, "api_key_transcription_path", "meetings"),
            (77, "pill_placement_and_hands_free_delay", "webhooks"),
            (78, "post_process_attribution", "snippets"),
            (79, "interaction_feedback_volume", "translations"),
        ];

        for (version, retired_description, foreign_description) in collisions {
            let temp = TempDb::new();
            let path = &temp.path;
            let pool = try_open(path).await.expect("initial migrate");
            sqlx::query(
                "INSERT INTO _sqlx_migrations
                 (version, description, success, checksum, execution_time)
                 VALUES (?1, ?2, true, x'deadbeef', 0)",
            )
            .bind(version)
            .bind(foreign_description)
            .execute(&pool)
            .await
            .unwrap();
            pool.close().await;

            let error = open_app_database(path)
                .await
                .expect_err("a colliding version must not be retired by number alone");
            assert!(
                error.contains(&format!("migration {version} is recorded"))
                    && error.contains("not in the current migration set"),
                "version {version} ({foreign_description}) must surface as a downgrade, got: {error}"
            );
            assert!(
                !error.contains("has been modified"),
                "version {version} ({foreign_description}) must be surfaced as a downgrade, \
                 not mistaken for a checksum mismatch: {error}"
            );

            let check = connect_pool(path).await.expect("reconnect");
            let survivors: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM _sqlx_migrations WHERE version = ?1 AND description = ?2",
            )
            .bind(version)
            .bind(foreign_description)
            .fetch_one(&check)
            .await
            .unwrap();
            assert_eq!(
                survivors, 1,
                "the row for version {version} ({foreign_description}) must survive, not be deleted"
            );
            check.close().await;
            assert_not_quarantined(
                &temp.dir, "surfacing version {version} ({foreign_description}) must never quarantine the database",
            );

            let temp = TempDb::new();
            let path = &temp.path;
            let pool = try_open(path).await.expect("initial migrate");
            sqlx::query(
                "INSERT INTO _sqlx_migrations
                 (version, description, success, checksum, execution_time)
                 VALUES (?1, ?2, true, x'deadbeef', 0)",
            )
            .bind(version)
            .bind(retired_description)
            .execute(&pool)
            .await
            .unwrap();
            pool.close().await;

            let reopened = open_app_database(path)
                .await
                .expect("the genuinely retired description still retires cleanly");
            let ghosts: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations WHERE version = ?1")
                    .bind(version)
                    .fetch_one(&reopened)
                    .await
                    .unwrap();
            assert_eq!(
                ghosts, 0,
                "version {version} ({retired_description}) is a folded consolidation step and must retire"
            );
            reopened.close().await;
        }
    }

    #[tokio::test]
    async fn non_integrity_errors_do_not_quarantine() {
        let temp = TempDb::new();
        // A non-integrity failure: pass a directory as the database path.
        let dir_as_db = temp.dir.join("not-a-file");
        std::fs::create_dir_all(&dir_as_db).unwrap();
        let result = open_app_database(&dir_as_db).await;
        assert!(result.is_err());
        assert_not_quarantined(&temp.dir, "the database must not be quarantined");
    }

    // The History list query decodes rows through row_to_transcription, which
    // reads post_process_fallback. This runs against a real migrated database
    // on purpose: a test that built its own table out of TRANSCRIPTION_COLUMNS
    // would still pass if the column had no migration behind it.
    #[tokio::test]
    async fn transcription_list_loads_against_the_migrated_schema() {
        let temp = TempDb::new();
        let pool = try_open(&temp.path).await.expect("migrate to head");
        sqlx::query(
            "INSERT INTO transcriptions (id, transcript, timestamp, post_process_fallback)
             VALUES ('flagged', 'hello', 1, 1), ('legacy', 'hi', 2, NULL)",
        )
        .execute(&pool)
        .await
        .unwrap();

        let rows = crate::db::transcription_queries::fetch_transcriptions(pool, 10, 0)
            .await
            .unwrap();

        assert_eq!(rows.len(), 2);
        let flagged = rows.iter().find(|row| row.id == "flagged").unwrap();
        let legacy = rows.iter().find(|row| row.id == "legacy").unwrap();
        assert_eq!(flagged.post_process_fallback, Some(true));
        assert_eq!(legacy.post_process_fallback, None);
    }
}
