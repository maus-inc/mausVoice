import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createIntl } from "react-intl";
import manifest from "./manifest.json";
import { PREVIEW_SAMPLE_MESSAGE } from "../components/tones/tone-form.utils";

/**
 * Localization completeness contract: a message that is copied verbatim into
 * every non-English catalog has silently shipped untranslated UI. Model names
 * with sizes, brand fragments, and identifiers are expected to stay identical
 * and are allow-listed; anything else must be flagged here (translate it or
 * consciously allow-list it).
 */
const UNIVERSAL_SAFE = [
  // Model catalogs: brand + version + size tuples never translate. Placeholder
  // sentences (e.g. "Version {version} is available.") MUST still be
  // translated, so ICU placeholders are not an exemption.
  /^(SenseVoice|NVIDIA|Whisper)\b/,
];

// These user-facing controls and feedback messages must not fall back to
// English in any supported locale.
const REQUIRED_TRANSLATION_MESSAGES = [
  "keep_the_audio_snapshot_with_a_failed_transcription_so_you_c",
  "preserve_audio_on_failure",
  "fast_styling_left_the_last_droppedchars_characters_of_that_d",
  "fast_styling_left_the_last_droppedchars_characters_of_the_au",
  "fast_styling_left_the_last_droppedchars_characters_unstyled",
  "online_styling_could_not_be_used_for_this_dictation",
  "online_styling_failed_because_reason_your_local_style_was_ap",
  "styling_failed_because_reason",
  "styling_failed_because_reason_history_does_not_contain_the_r",
  "styling_failed_because_reason_the_app_did_not_insert_the_tra",
  "styling_failed_because_reason_the_raw_transcript_is_saved_in",
  "the_incomplete_styling_reply_was_discarded_at_the_model_s_ou",
  "the_invalid_styling_reply_was_discarded_and_the_raw_transcri",
  "the_online_styling_reply_was_unusable_history_does_not_conta",
  "the_original_transcript_was_saved_because_the_online_styling",
  "the_post_processing_provider_returned_an_error",
  "the_provider_could_not_be_reached",
  "the_provider_rate_limit_was_reached",
  "the_provider_rejected_authentication_or_access",
  "the_provider_reply_was_unusable_so_the_previous_transcript_w",
  "the_provider_reply_was_unusable_so_the_raw_transcript_was_sa",
  "the_provider_reply_was_unusable_the_raw_transcript_is_availa",
  "the_provider_reported_a_quota_or_billing_issue",
  "the_provider_request_or_usage_limit_was_reached",
  "the_request_timed_out",
  "the_request_was_cancelled",
  "the_truncated_styling_reply_was_discarded_at_the_model_s_out",
  "the_unreadable_styling_reply_was_discarded_leaving_the_previ",
] as const;

const REQUIRED_MESSAGE_PLACEHOLDERS: Record<string, readonly string[]> = {
  fast_styling_left_the_last_droppedchars_characters_of_that_d: [
    "droppedChars",
  ],
  fast_styling_left_the_last_droppedchars_characters_of_the_au: [
    "droppedChars",
  ],
  fast_styling_left_the_last_droppedchars_characters_unstyled: ["droppedChars"],
  online_styling_failed_because_reason_your_local_style_was_ap: ["reason"],
  styling_failed_because_reason: ["reason"],
  styling_failed_because_reason_history_does_not_contain_the_r: ["reason"],
  styling_failed_because_reason_the_app_did_not_insert_the_tra: ["reason"],
  styling_failed_because_reason_the_raw_transcript_is_saved_in: ["reason"],
};

type Messages = Record<string, string>;

const loadLocales = (): Record<string, Messages> => {
  const locales: Record<string, Messages> = {};
  for (const locale of manifest.supportedLocales as string[]) {
    locales[locale] = JSON.parse(
      readFileSync(
        new URL(`./locales/${locale}.json`, import.meta.url),
        "utf8",
      ),
    );
  }
  return locales;
};

/**
 * The message table for one locale.
 *
 * `loadLocales` only fills in the locales the manifest lists, so a lookup that
 * comes up empty means the manifest and these assertions disagree -- worth a
 * message naming both. These reads used to be `locales[locale]!`, which handed
 * the next line `undefined` and surfaced as a `TypeError` naming neither.
 */
const messagesFor = (
  locales: Record<string, Messages>,
  locale: string,
): Messages => {
  const messages = locales[locale];
  if (!messages) {
    throw new Error(
      `Expected the manifest to list "${locale}", loaded: ${Object.keys(locales).join(", ")}`,
    );
  }
  return messages;
};

/** `react-intl` types a descriptor's `id` as optional; these fixtures need it. */
const messageId = (descriptor: { id?: string }): string => {
  if (!descriptor.id) {
    throw new Error(
      `Expected the message descriptor to carry an id, got ${JSON.stringify(descriptor)}`,
    );
  }
  return descriptor.id;
};

describe("i18n catalogs", () => {
  it.each(manifest.supportedLocales.filter((locale) => locale !== "en"))(
    "localizes %s controls identified in accepted feedback",
    (locale) => {
      const locales = loadLocales();
      const keys = [
        "allowed",
        "denied",
        "basics",
        "fix_the_grammar_in_my_last_dictation",
        "summarize_my_last_dictation_briefly",
        "preview_failed",
        "this_style_changed_elsewhere_close_and_reopen_the_editor_bef",
        "i_just_got_back_from_the_store_and_uh_we_need_milk_eggs_and",
        "behavior",
        "define",
        "discard",
        "discard_changes",
        "examples",
        "first_name",
        "installed",
        "join_beta",
        "last_name",
        "remote",
        "review",
        "run_preview",
        "stable",
        "test_style",
        "try_it",
        "tune",
        "update_channel",
        "writing_tips",
        "describe_how_the_style_should_sound",
        "give_the_style_a_name",
        "name_the_voice_first_then_the_rules_one_sentence_of_example",
        "no_text_generation_provider_is_configured_so_the_preview_can",
        "sample_dictation_to_restyle",
        "styling_the_sample",
        "test_and_review",
        "the_prompt_runs_as_the_style_instruction_on_every_post_proce",
        "you_have_unsaved_changes_closing_now_loses_them",
      ];
      for (const key of keys) {
        expect(locales[locale][key]?.trim(), `${locale}:${key}`).toBeTruthy();
        // "Stable" is also the French name of the stable release channel.
        if (locale === "fr" && key === "stable") {
          expect(locales[locale][key]).toBe("Stable");
        } else {
          expect(locales[locale][key], `${locale}:${key}`).not.toBe(
            locales.en[key],
          );
        }
      }
    },
  );

  it.each(manifest.supportedLocales)(
    "formats distinct style hints and provider guidance in %s",
    (locale) => {
      const locales = loadLocales();
      const intl = createIntl({
        locale,
        messages: locales[locale],
        onError: (error) => {
          throw error;
        },
      });
      expect(intl.formatMessage(PREVIEW_SAMPLE_MESSAGE)).toBe(
        messagesFor(locales, locale)[messageId(PREVIEW_SAMPLE_MESSAGE)],
      );
      const dualKey =
        "use_backwardhotkey_or_forwardhotkey_while_dictating_to_switc";
      const singleKey =
        "choose_different_writing_styles_to_change_how_you_sound_whil";
      const dual = intl.formatMessage(
        { id: dualKey },
        {
          backwardHotkey: "Ctrl+Left",
          forwardHotkey: "Ctrl+Right",
        },
      );
      expect(dual).toContain("Ctrl+Left");
      expect(dual).toContain("Ctrl+Right");
      expect(
        intl.formatMessage({ id: singleKey }, { hotkey: "Ctrl+Down" }),
      ).toContain("Ctrl+Down");
      for (const key of [
        dualKey,
        "you_can_create_this_style_without_a_preview_configure_a_text",
      ]) {
        expect(locales[locale][key]?.trim(), `${locale}:${key}`).toBeTruthy();
        if (locale !== "en")
          expect(locales[locale][key]).not.toBe(locales.en[key]);
      }
    },
  );

  it("localizes the dashboard navigation landmark and page list", () => {
    const locales = loadLocales();
    for (const locale of manifest.supportedLocales.filter(
      (value) => value !== "en",
    )) {
      expect(locales[locale].dashboard_navigation?.trim()).toBeTruthy();
      expect(locales[locale].dashboard_navigation).not.toBe(
        locales.en.dashboard_navigation,
      );
      // "Pages" is also the correct French translation.
      expect(locales[locale].pages?.trim()).toBeTruthy();
    }
  });

  it("localizes the monitor selector and its accessible name in every translated catalog", () => {
    const locales = loadLocales();
    for (const locale of Object.keys(locales).filter(
      (value) => value !== "en",
    )) {
      for (const key of [
        "current_monitor",
        "cursor_monitor",
        "reset_pill_position_monitor",
      ]) {
        expect(locales[locale][key]?.trim(), `${locale}:${key}`).toBeTruthy();
        expect(locales[locale][key], `${locale}:${key}`).not.toBe(
          locales.en[key],
        );
      }
    }
  });

  it("translates changelog failures and retains the status placeholder", () => {
    const locales = loadLocales();
    for (const [locale, messages] of Object.entries(locales)) {
      for (const key of [
        "could_not_load_the_changelog",
        "could_not_reach_the_release_history",
        "the_release_history_had_an_unexpected_response",
        "the_release_history_returned_status_status",
      ]) {
        expect(messages[key]?.trim(), `${locale}:${key}`).toBeTruthy();
        if (locale !== "en")
          expect(messages[key], `${locale}:${key}`).not.toBe(locales.en[key]);
      }
      expect(messages.the_release_history_returned_status_status).toContain(
        "{status}",
      );
    }
    const source = readFileSync(
      new URL("../components/root/ChangelogDialog.tsx", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/id="changelog\./);
  });

  it("manifest and on-disk locale files agree", () => {
    const onDisk = readdirSync(new URL("./locales/", import.meta.url))
      .filter((file) => file.endsWith(".json"))
      .map((file) => file.replace(/\.json$/, ""));
    expect([...onDisk].sort()).toEqual(
      [...(manifest.supportedLocales as string[])].sort(),
    );
  });

  it("flags messages still English in every translated locale", () => {
    const locales = loadLocales();
    const keyedEnglish = messagesFor(locales, manifest.defaultLocale);
    const translatedCodes = (manifest.supportedLocales as string[]).filter(
      (code) => code !== manifest.defaultLocale,
    );

    const untranslatedEverywhere: string[] = [];
    for (const [key, message] of Object.entries(keyedEnglish)) {
      if (UNIVERSAL_SAFE.some((re) => re.test(message))) continue;
      const allIdentical = translatedCodes.every(
        (code) => locales[code]?.[key] === message,
      );
      // A one-word label ("Notes", "Bullets") may legitimately coincide with
      // its translation, but a sentence never does.
      if (allIdentical && message.trim().split(/\s+/).length > 2) {
        untranslatedEverywhere.push(key);
      }
    }

    expect(
      untranslatedEverywhere,
      `These keys are untranslated in ALL locales (translate them or extend UNIVERSAL_SAFE):\n${untranslatedEverywhere.join("\n")}`,
    ).toEqual([]);
  });

  it("names the transcript as text in ko, not as captured audio", () => {
    // The Korean catalog carried two spellings of one concept. 녹음 내용 reads as
    // the original *audio*, which is not what these messages are about, and
    // 트랜스크립트 was a third spelling of the same thing. The catalog already
    // said 텍스트 for the text in copy_transcript, delete_transcript and
    // final_transcript_unavailable, so that is the word these now use too.
    //
    // Asserted against the English rather than as a fixed key list, so a new
    // message that mistranslates "transcript" the same way fails here rather
    // than waiting for a native reader to notice.
    const locales = loadLocales();
    const english = messagesFor(locales, manifest.defaultLocale);
    const korean = messagesFor(locales, "ko");
    const audioWording = /녹음\s*내용|트랜스크립트/u;

    const mistranslated = Object.keys(english).filter((key) => {
      const source = english[key] ?? "";
      const translation = korean[key];
      return (
        /transcript/i.test(source) &&
        typeof translation === "string" &&
        audioWording.test(translation)
      );
    });

    expect(
      mistranslated,
      "these ko messages say transcript with a word that means captured audio",
    ).toEqual([]);

    // And every transcript message is covered, so the guard above cannot pass
    // by those keys falling out of the catalog.
    for (const key of [
      "could_not_open_the_review_window_your_transcript_was_saved_t",
      "review_expired_the_transcript_is_kept_in_your_history",
      "styling_failed_because_reason_the_raw_transcript_is_saved_in",
      "styling_failed_because_reason_the_app_did_not_insert_the_tra",
      "styling_failed_because_reason_history_does_not_contain_the_r",
      "the_online_styling_reply_was_unusable_history_does_not_conta",
      "the_provider_reply_was_unusable_the_raw_transcript_is_availa",
      "could_not_copy_the_transcript_it_is_saved_in_your_history",
    ]) {
      expect(korean[key], `ko:${key} must exist`).toBeTypeOf("string");
      expect(korean[key], `ko:${key}`).not.toMatch(audioWording);
    }
  });

  it("translates audio-preservation controls and fast-style feedback in every locale", () => {
    const locales = loadLocales();
    const keyedEnglish = messagesFor(locales, manifest.defaultLocale);
    const translatedCodes = (manifest.supportedLocales as string[]).filter(
      (code) => code !== manifest.defaultLocale,
    );

    for (const key of REQUIRED_TRANSLATION_MESSAGES) {
      for (const locale of translatedCodes) {
        const translation = locales[locale]?.[key];
        expect(translation, `${locale}:${key} must exist`).toBeTypeOf("string");
        expect(translation, `${locale}:${key}`).not.toBe(keyedEnglish[key]);
        for (const placeholder of REQUIRED_MESSAGE_PLACEHOLDERS[key] ?? []) {
          expect(translation, `${locale}:${key}`).toContain(`{${placeholder}}`);
        }
      }
    }
  });
});
