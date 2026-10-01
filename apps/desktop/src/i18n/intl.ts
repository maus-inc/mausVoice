import {
  createIntl,
  createIntlCache,
  type IntlShape,
  type MessageDescriptor,
} from "react-intl";
import { DEFAULT_LOCALE, Locale, SUPPORTED_LOCALES } from "./config";
import deMessages from "./locales/de.json";
import enMessages from "./locales/en.json";
import esMessages from "./locales/es.json";
import frMessages from "./locales/fr.json";
import itMessages from "./locales/it.json";
import ptBRMessages from "./locales/pt-BR.json";
import ptMessages from "./locales/pt.json";
import zhCNMessages from "./locales/zh-CN.json";
import zhTWMessages from "./locales/zh-TW.json";
import koMessages from "./locales/ko.json";

const LOCALE_MESSAGES: Record<Locale, Record<string, string>> = {
  en: enMessages,
  es: esMessages,
  fr: frMessages,
  de: deMessages,
  pt: ptMessages,
  "pt-BR": ptBRMessages,
  it: itMessages,
  "zh-TW": zhTWMessages,
  "zh-CN": zhCNMessages,
  ko: koMessages,
};

export const matchSupportedLocale = (value?: string | null): Locale | null => {
  if (!value) {
    return null;
  }

  const cleaned = value.replace(/_/g, "-");

  // First check if the full locale (with region) is supported
  if (SUPPORTED_LOCALES.includes(cleaned as Locale)) {
    return cleaned as Locale;
  }

  // Fall back to just the language part
  const [language] = cleaned.toLowerCase().split("-");
  if (SUPPORTED_LOCALES.includes(language as Locale)) {
    return language as Locale;
  }

  return null;
};

export const detectLocale = (): Locale => {
  if (typeof navigator === "undefined") {
    return DEFAULT_LOCALE;
  }

  const candidates = Array.isArray(navigator.languages)
    ? [...navigator.languages]
    : [];

  if (navigator.language) {
    candidates.push(navigator.language);
  }

  for (const candidate of candidates) {
    const match = matchSupportedLocale(candidate);
    if (match) {
      return match;
    }
  }

  return DEFAULT_LOCALE;
};

export const getMessagesForLocale = (locale: Locale) => {
  return LOCALE_MESSAGES[locale] ?? LOCALE_MESSAGES[DEFAULT_LOCALE];
};

export const getIntlConfig = () => {
  const locale = detectLocale();
  return {
    locale,
    defaultLocale: DEFAULT_LOCALE,
    messages: getMessagesForLocale(locale),
  };
};

// Helper to get intl instance for non-React contexts
export function getIntl(locale?: Locale) {
  const cache = createIntlCache();
  const detectedLocale = locale ?? detectLocale();
  const intl = createIntl(
    {
      locale: detectedLocale,
      defaultLocale: DEFAULT_LOCALE,
      messages: getMessagesForLocale(detectedLocale),
    },
    cache,
  );
  return { ...intl, formatMessage: idTolerantFormatMessage(intl) };
}

const idTolerantFormatMessage = (intl: IntlShape) => {
  const rawFormat = intl.formatMessage;
  /**
   * `react-intl` requires an `id` and throws without one, which every call site
   * in this repo omits on purpose (the repo rule is `defaultMessage`, never an
   * `id` prop). The `defaultMessage` is used as the lookup key in its place, and
   * the values are still handed to the formatter, so a descriptor carrying ICU
   * placeholders never ships a literal `{count}` to the user.
   *
   * Nothing else is wrapped. A malformed ICU string or a missing value is a bug
   * in the call site, and catching it here would ship an unformatted sentence
   * with nothing logged; `formatMessage` already reports those through its own
   * `onError` and falls back to the default message.
   */
  const format = <T extends MessageDescriptor>(
    descriptor: T,
    ...rest: unknown[]
  ) =>
    descriptor.id
      ? rawFormat(descriptor, ...(rest as [never, never]))
      : rawFormat(
          { ...descriptor, id: descriptor.defaultMessage },
          ...(rest as [never, never]),
        );
  // Both `IntlShape` overloads are preserved by construction: `format` is
  // generic over the descriptor and forwards the remaining arguments untouched,
  // so the return type is whatever the underlying overload produces.
  return format as IntlShape["formatMessage"];
};
