export type TranslationStatus =
  "pending" | "in_progress" | "completed" | "failed";

export type Translation = {
  id: string;
  createdAt: string;
  createdByUserId: string;
  sourceLanguage: string;
  targetLanguage: string;
  sourceText: string;
  translatedText: string | null;
  status: TranslationStatus;
  errorMessage: string | null;
  isDeleted: boolean;
};
