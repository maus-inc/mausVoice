import type { IntlShape, MessageDescriptor } from "react-intl";

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
type ReactIntlModule = typeof import("react-intl");

const useIntlMock = (): IntlShape => {
  const formatMessage: IntlShape["formatMessage"] = ((
    descriptor: MessageDescriptor,
  ) => descriptor.defaultMessage ?? "") as IntlShape["formatMessage"];
  const formatDate = ((): string => "date") as IntlShape["formatDate"];
  const formatTime = ((): string => "time") as IntlShape["formatTime"];
  return {
    formatMessage,
    formatDate,
    formatTime,
  } as IntlShape;
};

const FormattedMessageMock = ((props: { defaultMessage: string }): string =>
  props.defaultMessage) as never;

export const reactIntlMockModule = async (
  importOriginal: () => Promise<ReactIntlModule>,
): Promise<ReactIntlModule> => {
  const actual = await importOriginal();
  return {
    ...actual,
    useIntl: useIntlMock as ReactIntlModule["useIntl"],
    FormattedMessage:
      FormattedMessageMock as ReactIntlModule["FormattedMessage"],
  };
};
