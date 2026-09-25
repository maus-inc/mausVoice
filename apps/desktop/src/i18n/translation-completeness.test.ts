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

// These user-facing controls were added with the failed-transcription audio
// preservation setting. Unlike a model identifier, they must not fall back to
// English in any supported locale.
const FAILURE_AUDIO_MESSAGES = [
  "keep_the_audio_snapshot_with_a_failed_transcription_so_you_c",
  "preserve_audio_on_failure",
] as const;

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
        "installed",
        "join_beta",
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
        locales[locale][PREVIEW_SAMPLE_MESSAGE.id!],
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
    const keyedEnglish = locales[manifest.defaultLocale]!;
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

  it("translates failed-transcription audio controls in every locale", () => {
    const locales = loadLocales();
    const keyedEnglish = locales[manifest.defaultLocale]!;
    const translatedCodes = (manifest.supportedLocales as string[]).filter(
      (code) => code !== manifest.defaultLocale,
    );

    for (const key of FAILURE_AUDIO_MESSAGES) {
      for (const locale of translatedCodes) {
        const translation = locales[locale]?.[key];
        expect(translation, `${locale}:${key} must exist`).toBeTypeOf("string");
        expect(translation, `${locale}:${key}`).not.toBe(keyedEnglish[key]);
      }
    }
  });
});
