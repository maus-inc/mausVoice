import { invoke } from "@tauri-apps/api/core";
import type { TranslationHistoryEntry } from "../types/translations.types";
import { BaseRepo } from "./base.repo";

type LocalTranslation = {
  id: string;
  sourceText: string;
  translatedText: string;
  sourceLanguage: string;
  targetLanguage: string;
  createdAt: number;
};

const fromLocal = (local: LocalTranslation): TranslationHistoryEntry => ({
  id: local.id,
  sourceText: local.sourceText,
  translatedText: local.translatedText,
  sourceLanguage: local.sourceLanguage,
  targetLanguage: local.targetLanguage,
  createdAt: new Date(local.createdAt).toISOString(),
});

export abstract class BaseTranslationRepo extends BaseRepo {
  abstract insert(entry: {
    sourceText: string;
    translatedText: string;
    sourceLanguage: string;
    targetLanguage: string;
  }): Promise<TranslationHistoryEntry>;
  abstract list(limit?: number): Promise<TranslationHistoryEntry[]>;
  abstract search(query: string, limit?: number): Promise<TranslationHistoryEntry[]>;
}

export class LocalTranslationRepo extends BaseTranslationRepo {
  async insert(entry: {
    sourceText: string;
    translatedText: string;
    sourceLanguage: string;
    targetLanguage: string;
  }): Promise<TranslationHistoryEntry> {
    const created = await invoke<LocalTranslation>("translation_insert", {
      sourceText: entry.sourceText,
      translatedText: entry.translatedText,
      sourceLanguage: entry.sourceLanguage,
      targetLanguage: entry.targetLanguage,
    });
    return fromLocal(created);
  }

  async list(limit = 20): Promise<TranslationHistoryEntry[]> {
    const stored = await invoke<LocalTranslation[]>("translation_list", { limit });
    return stored.map(fromLocal);
  }

  async search(query: string, limit = 20): Promise<TranslationHistoryEntry[]> {
    const stored = await invoke<LocalTranslation[]>("translation_search", {
      query,
      limit,
    });
    return stored.map(fromLocal);
  }
}
