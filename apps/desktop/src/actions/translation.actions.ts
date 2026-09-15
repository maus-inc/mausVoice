import { getGenerateTextRepo, getTranslationRepo } from "../repos";
import { isExpansionFeatureEnabled } from "../features/featureFlags";
import { isPersistenceAllowed } from "../utils/incognito.utils";
import { getLogger } from "../utils/log.utils";

const ensureTranslationsEnabled = (): void => {
  if (!isExpansionFeatureEnabled("translationsEnabled")) {
    throw new Error("Translations feature is not enabled");
  }
};

export const translateText = async (params: {
  sourceText: string;
  sourceLanguage: string;
  targetLanguage: string;
}): Promise<string> => {
  ensureTranslationsEnabled();
  if (!params.sourceText.trim()) {
    throw new Error("Source text must not be empty");
  }
  const { repo: genRepo } = getGenerateTextRepo();
  if (!genRepo) {
    throw new Error("No LLM provider configured for translation");
  }
  const prompt = `Translate the following text from ${params.sourceLanguage} to ${params.targetLanguage}. Return only the translated text, no explanation:\n\n${params.sourceText}`;
  const output = await genRepo.generateText({ prompt });
  const translatedText = output.text.trim();
  if (isPersistenceAllowed()) {
    try {
      await getTranslationRepo().insert({
        sourceText: params.sourceText,
        translatedText,
        sourceLanguage: params.sourceLanguage,
        targetLanguage: params.targetLanguage,
      });
    } catch (error) {
      getLogger().warning(
        `Failed to persist translation history: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }
  }
  return translatedText;
};

export const listTranslations = async (limit = 20) => {
  ensureTranslationsEnabled();
  return getTranslationRepo().list(limit);
};

export const searchTranslations = async (query: string, limit = 20) => {
  ensureTranslationsEnabled();
  return getTranslationRepo().search(query, limit);
};
