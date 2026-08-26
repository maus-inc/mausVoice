use sqlx::{Row, SqlitePool};

use crate::domain::{preferences::DEFAULT_DICTATION_LIMIT_MINUTES, UserPreferences};
const SEP: &str = "::";

fn serialize_additional_languages(languages: &Option<Vec<String>>) -> Option<String> {
    languages.as_ref().map(|languages| languages.join(SEP))
}

fn deserialize_additional_languages(value: Option<String>) -> Option<Vec<String>> {
    value.map(|v| {
        if v.is_empty() {
            Vec::new()
        } else {
            v.split(SEP).map(|s| s.to_owned()).collect()
        }
    })
}

pub async fn upsert_user_preferences(
    pool: SqlitePool,
    preferences: &UserPreferences,
) -> Result<UserPreferences, sqlx::Error> {
    sqlx::query(
        "INSERT INTO user_preferences (
             user_id,
             transcription_mode,
             transcription_api_key_id,
             transcription_device,
             transcription_model_size,
             post_processing_mode,
             post_processing_api_key_id,
             post_processing_ollama_url,
             post_processing_ollama_model,
             agent_mode,
             agent_mode_api_key_id,
             openclaw_gateway_url,
             openclaw_token,
             active_tone_id,
             got_started_at,
             gpu_enumeration_enabled,
             paste_keybind,
             last_seen_feature,
             language_switch_enabled,
             secondary_dictation_language,
             active_dictation_language,
             additional_dictation_languages,
             preferred_microphone,
              ignore_update_dialog,
              incognito_mode_enabled,
             incognito_mode_include_in_stats,
             preserve_audio_on_failure,
              dictation_limit_minutes,
             dictation_pill_visibility,
             use_new_backend,
             realtime_output_enabled,
             remote_output_enabled,
             remote_target_device_id,
             remote_receiver_port,
             remote_receiver_auto_start,
             dictation_audio_dim,
             menu_bar_icon_hidden,
             insertion_method,
             typing_speed_ms,
             pill_reset_monitor_strategy,
             always_request_admin_on_startup,
             pill_placement,
             hands_free_delay_ms,
             in_dictation_style_switching_enabled,
             hallucination_filter_enabled,
             review_before_insert,
             agent_enabled_tools,
             agent_max_iterations,
             agent_permission_timeout_ms,
             spoken_commands_enabled,
             auto_learn_dictionary_enabled
          )
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32, ?33, ?34, ?35, ?36, ?37, ?38, ?39, ?40, ?41, ?42, ?43, ?44, ?45, ?46, ?47, ?48, ?49, ?50, ?51)
         ON CONFLICT(user_id) DO UPDATE SET
            transcription_mode = excluded.transcription_mode,
            transcription_api_key_id = excluded.transcription_api_key_id,
            transcription_device = excluded.transcription_device,
            transcription_model_size = excluded.transcription_model_size,
            post_processing_mode = excluded.post_processing_mode,
            post_processing_api_key_id = excluded.post_processing_api_key_id,
            post_processing_ollama_url = excluded.post_processing_ollama_url,
            post_processing_ollama_model = excluded.post_processing_ollama_model,
            agent_mode = excluded.agent_mode,
            agent_mode_api_key_id = excluded.agent_mode_api_key_id,
            openclaw_gateway_url = excluded.openclaw_gateway_url,
            openclaw_token = excluded.openclaw_token,
            active_tone_id = excluded.active_tone_id,
            got_started_at = excluded.got_started_at,
            gpu_enumeration_enabled = excluded.gpu_enumeration_enabled,
            paste_keybind = excluded.paste_keybind,
            last_seen_feature = excluded.last_seen_feature,
            language_switch_enabled = excluded.language_switch_enabled,
            secondary_dictation_language = excluded.secondary_dictation_language,
            active_dictation_language = excluded.active_dictation_language,
            additional_dictation_languages = excluded.additional_dictation_languages,
            preferred_microphone = excluded.preferred_microphone,
            ignore_update_dialog = excluded.ignore_update_dialog,
            incognito_mode_enabled = excluded.incognito_mode_enabled,
             incognito_mode_include_in_stats = excluded.incognito_mode_include_in_stats,
             preserve_audio_on_failure = excluded.preserve_audio_on_failure,
            dictation_limit_minutes = excluded.dictation_limit_minutes,
            dictation_pill_visibility = excluded.dictation_pill_visibility,
            use_new_backend = excluded.use_new_backend,
            realtime_output_enabled = excluded.realtime_output_enabled,
            remote_output_enabled = excluded.remote_output_enabled,
            remote_target_device_id = excluded.remote_target_device_id,
            remote_receiver_port = excluded.remote_receiver_port,
            remote_receiver_auto_start = excluded.remote_receiver_auto_start,
            dictation_audio_dim = excluded.dictation_audio_dim,
            menu_bar_icon_hidden = excluded.menu_bar_icon_hidden,
            insertion_method = excluded.insertion_method,
            typing_speed_ms = excluded.typing_speed_ms,
            pill_reset_monitor_strategy = excluded.pill_reset_monitor_strategy,
            always_request_admin_on_startup = excluded.always_request_admin_on_startup,
            pill_placement = excluded.pill_placement,
            hands_free_delay_ms = excluded.hands_free_delay_ms,
            in_dictation_style_switching_enabled = excluded.in_dictation_style_switching_enabled,
            hallucination_filter_enabled = excluded.hallucination_filter_enabled,
            review_before_insert = excluded.review_before_insert,
            agent_enabled_tools = excluded.agent_enabled_tools,
            agent_max_iterations = excluded.agent_max_iterations,
            agent_permission_timeout_ms = excluded.agent_permission_timeout_ms,
            spoken_commands_enabled = excluded.spoken_commands_enabled,
            auto_learn_dictionary_enabled = excluded.auto_learn_dictionary_enabled",
        )
    .bind(&preferences.user_id)
    .bind(&preferences.transcription_mode)
    .bind(&preferences.transcription_api_key_id)
    .bind(&preferences.transcription_device)
    .bind(&preferences.transcription_model_size)
    .bind(&preferences.post_processing_mode)
    .bind(&preferences.post_processing_api_key_id)
    .bind(&preferences.post_processing_ollama_url)
    .bind(&preferences.post_processing_ollama_model)
    .bind(&preferences.agent_mode)
    .bind(&preferences.agent_mode_api_key_id)
    .bind(&preferences.openclaw_gateway_url)
    .bind(&preferences.openclaw_token)
    .bind(&preferences.active_tone_id)
    .bind(preferences.got_started_at)
    .bind(preferences.gpu_enumeration_enabled)
    .bind(&preferences.paste_keybind)
    .bind(&preferences.last_seen_feature)
    .bind(preferences.language_switch_enabled)
    .bind(&preferences.secondary_dictation_language)
    .bind(&preferences.active_dictation_language)
    .bind(serialize_additional_languages(&preferences.additional_dictation_languages))
    .bind(&preferences.preferred_microphone)
    .bind(preferences.ignore_update_dialog)
    .bind(preferences.incognito_mode_enabled)
    .bind(preferences.incognito_mode_include_in_stats)
    .bind(preferences.preserve_audio_on_failure)
    .bind(preferences.dictation_limit_minutes)
    .bind(&preferences.dictation_pill_visibility)
    .bind(preferences.use_new_backend)
    .bind(preferences.realtime_output_enabled)
    .bind(preferences.remote_output_enabled)
    .bind(&preferences.remote_target_device_id)
    .bind(preferences.remote_receiver_port)
    .bind(preferences.remote_receiver_auto_start)
    .bind(preferences.dictation_audio_dim)
    .bind(preferences.menu_bar_icon_hidden)
    .bind(&preferences.insertion_method)
    .bind(preferences.typing_speed_ms)
    .bind(&preferences.pill_reset_monitor_strategy)
    .bind(preferences.always_request_admin_on_startup)
    .bind(&preferences.pill_placement)
    .bind(preferences.hands_free_delay_ms)
    .bind(preferences.in_dictation_style_switching_enabled)
    .bind(preferences.hallucination_filter_enabled)
    .bind(preferences.review_before_insert)
    .bind(&preferences.agent_enabled_tools)
    .bind(preferences.agent_max_iterations)
    .bind(preferences.agent_permission_timeout_ms)
    .bind(preferences.spoken_commands_enabled)
    .bind(preferences.auto_learn_dictionary_enabled)
    .execute(&pool)
    .await?;

    Ok(preferences.clone())
}

pub async fn fetch_user_preferences(
    pool: SqlitePool,
    user_id: &str,
) -> Result<Option<UserPreferences>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT
            user_id,
            transcription_mode,
            transcription_api_key_id,
            transcription_device,
            transcription_model_size,
            post_processing_mode,
            post_processing_api_key_id,
            post_processing_ollama_url,
            post_processing_ollama_model,
            agent_mode,
            agent_mode_api_key_id,
            openclaw_gateway_url,
            openclaw_token,
            active_tone_id,
            got_started_at,
            gpu_enumeration_enabled,
            paste_keybind,
            last_seen_feature,
            language_switch_enabled,
            secondary_dictation_language,
            active_dictation_language,
            additional_dictation_languages,
            preferred_microphone,
            ignore_update_dialog,
            incognito_mode_enabled,
            incognito_mode_include_in_stats,
            preserve_audio_on_failure,
            dictation_limit_minutes,
            dictation_pill_visibility,
            use_new_backend,
            realtime_output_enabled,
            remote_output_enabled,
            remote_target_device_id,
            remote_receiver_port,
            remote_receiver_auto_start,
            dictation_audio_dim,
            menu_bar_icon_hidden,
            insertion_method,
            typing_speed_ms,
            pill_reset_monitor_strategy,
            always_request_admin_on_startup,
            pill_placement,
            hands_free_delay_ms,
            in_dictation_style_switching_enabled,
            hallucination_filter_enabled,
            review_before_insert,
            agent_enabled_tools,
            agent_max_iterations,
            agent_permission_timeout_ms,
            spoken_commands_enabled,
            auto_learn_dictionary_enabled
         FROM user_preferences
         WHERE user_id = ?1
         LIMIT 1",
    )
    .bind(user_id)
    .fetch_optional(&pool)
    .await?;

    let preferences = row.map(|row| UserPreferences {
        user_id: row.get::<String, _>("user_id"),
        transcription_mode: row
            .try_get::<Option<String>, _>("transcription_mode")
            .unwrap_or(None),
        transcription_api_key_id: row
            .try_get::<Option<String>, _>("transcription_api_key_id")
            .unwrap_or(None),
        transcription_device: row
            .try_get::<Option<String>, _>("transcription_device")
            .unwrap_or(None),
        transcription_model_size: row
            .try_get::<Option<String>, _>("transcription_model_size")
            .unwrap_or(None),
        post_processing_mode: row
            .try_get::<Option<String>, _>("post_processing_mode")
            .unwrap_or(None),
        post_processing_api_key_id: row
            .try_get::<Option<String>, _>("post_processing_api_key_id")
            .unwrap_or(None),
        post_processing_ollama_url: row
            .try_get::<Option<String>, _>("post_processing_ollama_url")
            .unwrap_or(None),
        post_processing_ollama_model: row
            .try_get::<Option<String>, _>("post_processing_ollama_model")
            .unwrap_or(None),
        agent_mode: row
            .try_get::<Option<String>, _>("agent_mode")
            .unwrap_or(None),
        agent_mode_api_key_id: row
            .try_get::<Option<String>, _>("agent_mode_api_key_id")
            .unwrap_or(None),
        openclaw_gateway_url: row
            .try_get::<Option<String>, _>("openclaw_gateway_url")
            .unwrap_or(None),
        openclaw_token: row
            .try_get::<Option<String>, _>("openclaw_token")
            .unwrap_or(None),
        active_tone_id: row
            .try_get::<Option<String>, _>("active_tone_id")
            .unwrap_or(None),
        got_started_at: row
            .try_get::<Option<i64>, _>("got_started_at")
            .unwrap_or(None),
        gpu_enumeration_enabled: row
            .try_get::<i64, _>("gpu_enumeration_enabled")
            .map(|v| v != 0)
            .unwrap_or(false),
        paste_keybind: row
            .try_get::<Option<String>, _>("paste_keybind")
            .unwrap_or(None),
        last_seen_feature: row
            .try_get::<Option<String>, _>("last_seen_feature")
            .unwrap_or(None),
        language_switch_enabled: row
            .try_get::<i64, _>("language_switch_enabled")
            .map(|v| v != 0)
            .unwrap_or(false),
        secondary_dictation_language: row
            .try_get::<Option<String>, _>("secondary_dictation_language")
            .unwrap_or(None),
        active_dictation_language: row
            .try_get::<Option<String>, _>("active_dictation_language")
            .unwrap_or(None),
        additional_dictation_languages: deserialize_additional_languages(
            row.try_get::<Option<String>, _>("additional_dictation_languages")
                .unwrap_or(None),
        ),
        preferred_microphone: row
            .try_get::<Option<String>, _>("preferred_microphone")
            .unwrap_or(None),
        ignore_update_dialog: row
            .try_get::<i64, _>("ignore_update_dialog")
            .map(|v| v != 0)
            .unwrap_or(false),
        incognito_mode_enabled: row
            .try_get::<i64, _>("incognito_mode_enabled")
            .map(|v| v != 0)
            .unwrap_or(false),
        incognito_mode_include_in_stats: row
            .try_get::<i64, _>("incognito_mode_include_in_stats")
            .map(|v| v != 0)
            .unwrap_or(false),
        preserve_audio_on_failure: row
            .try_get::<i64, _>("preserve_audio_on_failure")
            .map(|v| v != 0)
            .unwrap_or(true),
        dictation_limit_minutes: row
            .try_get::<i64, _>("dictation_limit_minutes")
            .unwrap_or(DEFAULT_DICTATION_LIMIT_MINUTES),
        dictation_pill_visibility: row
            .try_get::<String, _>("dictation_pill_visibility")
            .unwrap_or_else(|_| "while_active".to_string()),
        use_new_backend: row
            .try_get::<i64, _>("use_new_backend")
            .map(|v| v != 0)
            .unwrap_or(false),
        realtime_output_enabled: row
            .try_get::<i64, _>("realtime_output_enabled")
            .map(|v| v != 0)
            .unwrap_or(false),
        remote_output_enabled: row
            .try_get::<i64, _>("remote_output_enabled")
            .map(|v| v != 0)
            .unwrap_or(false),
        remote_target_device_id: row
            .try_get::<Option<String>, _>("remote_target_device_id")
            .unwrap_or(None),
        remote_receiver_port: row
            .try_get::<Option<i64>, _>("remote_receiver_port")
            .unwrap_or(None),
        remote_receiver_auto_start: row
            .try_get::<i64, _>("remote_receiver_auto_start")
            .map(|v| v != 0)
            .unwrap_or(false),
        dictation_audio_dim: row.try_get::<f64, _>("dictation_audio_dim").unwrap_or(1.0),
        menu_bar_icon_hidden: row
            .try_get::<i64, _>("menu_bar_icon_hidden")
            .map(|v| v != 0)
            .unwrap_or(false),
        insertion_method: row
            .try_get::<Option<String>, _>("insertion_method")
            .unwrap_or(None),
        typing_speed_ms: row
            .try_get::<Option<i64>, _>("typing_speed_ms")
            .unwrap_or(None),
        pill_reset_monitor_strategy: row
            .try_get::<String, _>("pill_reset_monitor_strategy")
            .unwrap_or_else(|_| "current".to_string()),
        always_request_admin_on_startup: row
            .try_get::<i64, _>("always_request_admin_on_startup")
            .map(|v| v != 0)
            .unwrap_or(false),
        pill_placement: row
            .try_get::<String, _>("pill_placement")
            .unwrap_or_else(|_| "bottom".to_string()),
        hands_free_delay_ms: row
            .try_get::<Option<i64>, _>("hands_free_delay_ms")
            .unwrap_or(None),
        in_dictation_style_switching_enabled: row
            .try_get::<i64, _>("in_dictation_style_switching_enabled")
            .map(|v| v != 0)
            .unwrap_or(false),
        hallucination_filter_enabled: row
            .try_get::<i64, _>("hallucination_filter_enabled")
            .map(|v| v != 0)
            .unwrap_or(true),
        review_before_insert: row
            .try_get::<Option<i64>, _>("review_before_insert")
            .ok()
            .flatten()
            .map(|v| v != 0),
        agent_enabled_tools: row
            .try_get::<Option<String>, _>("agent_enabled_tools")
            .unwrap_or(None),
        agent_max_iterations: row
            .try_get::<i64, _>("agent_max_iterations")
            .unwrap_or(20),
        agent_permission_timeout_ms: row
            .try_get::<i64, _>("agent_permission_timeout_ms")
            .unwrap_or(60_000),
        spoken_commands_enabled: row
            .try_get::<i64, _>("spoken_commands_enabled")
            .map(|v| v != 0)
            .unwrap_or(true),
        auto_learn_dictionary_enabled: row
            .try_get::<i64, _>("auto_learn_dictionary_enabled")
            .map(|v| v != 0)
            .unwrap_or(true),
    });

    Ok(preferences)
}

pub async fn clear_missing_active_tones(pool: SqlitePool) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE user_preferences
         SET active_tone_id = NULL
         WHERE active_tone_id IS NOT NULL
           AND active_tone_id NOT IN (SELECT id FROM tones)",
    )
    .execute(&pool)
    .await?;

    Ok(())
}

pub const LOCAL_USER_ID: &str = "local-user-id";

pub async fn fetch_transcription_mode(pool: SqlitePool) -> Result<Option<String>, sqlx::Error> {
    let row: Option<Option<String>> = sqlx::query_scalar(
        "SELECT transcription_mode FROM user_preferences WHERE user_id = ?1 LIMIT 1",
    )
    .bind(LOCAL_USER_ID)
    .fetch_optional(&pool)
    .await?;

    Ok(row.flatten())
}
