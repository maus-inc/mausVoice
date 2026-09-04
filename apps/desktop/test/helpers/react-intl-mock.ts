/**
 * Shared react-intl mock for jsdom component tests. Descriptors only carry
 * defaultMessage until the formatjs babel plugin injects ids at build time,
 * so raw react-intl throws here. Formatted dates and times return fixed
 * strings so caption assertions stay stable. Loaded from inside the
 * vi.mock factory, since the factory runs before static imports resolve.
 *
 * Usage from a jsdom component test:
 *
 *   vi.mock("react-intl", async (importOriginal) => {
 *     const { reactIntlMockModule } =
 *       await import("../../../test/helpers/react-intl-mock");
 *     return reactIntlMockModule(importOriginal);
 *   });
 */
export const reactIntlMockModule = async <T>(
  importOriginal: () => Promise<T>,
): Promise<T> => {
  const actual = await importOriginal();
  return {
    ...actual,
    useIntl: () => ({
      formatMessage: ({ defaultMessage }: { defaultMessage: string }) =>
        defaultMessage,
      formatDate: () => "date",
      formatTime: () => "time",
    }),
    FormattedMessage: ({ defaultMessage }: { defaultMessage: string }) =>
      defaultMessage,
  };
};
