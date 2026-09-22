export type TranslationRequest = {
  id: string;
  sourceText: string;
  sourceLanguage: string;
  targetLanguage: string;
  createdAt: string;
};

export type TranslationResult = {
  id: string;
  requestId: string;
  translatedText: string;
  sourceLanguage: string;
  targetLanguage: string;
  confidence?: number;
  createdAt: string;
};

export type TranslationHistoryEntry = {
  id: string;
  sourceText: string;
  translatedText: string;
  sourceLanguage: string;
  targetLanguage: string;
  createdAt: string;
};
