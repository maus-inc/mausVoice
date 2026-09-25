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

const useIntlMock = (): Partial<IntlShape> => {
  const formatMessage: IntlShape["formatMessage"] = ((
    descriptor: MessageDescriptor,
  ) => descriptor.defaultMessage ?? "") as IntlShape["formatMessage"];
  const formatDate = ((): string => "date") as IntlShape["formatDate"];
  const formatTime = ((): string => "time") as IntlShape["formatTime"];
  return {
    formatMessage,
    formatDate,
    formatTime,
  };
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

/** Keep real locale formatting, adding only the IDs injected by the Vite build. */
export const reactIntlWithIdsModule = async (
  importOriginal: () => Promise<ReactIntlModule>,
): Promise<ReactIntlModule> => {
  const actual = await importOriginal();
  const { createElement } = await import("react");
  const { formatjsOverrideIdFn } =
    await import("../../scripts/formatjs-id.mjs");
  const withId = (descriptor: MessageDescriptor): MessageDescriptor => ({
    ...descriptor,
    id: formatjsOverrideIdFn(
      descriptor.id,
      typeof descriptor.defaultMessage === "string"
        ? descriptor.defaultMessage
        : undefined,
    ),
  });
  return {
    ...actual,
    FormattedMessage: (props) =>
      createElement(actual.FormattedMessage, { ...props, ...withId(props) }),
    useIntl: () => {
      const intl = actual.useIntl();
      const formatMessage = ((
        ...args: Parameters<IntlShape["formatMessage"]>
      ) =>
        intl.formatMessage(
          withId(args[0]),
          args[1],
          args[2],
        )) as IntlShape["formatMessage"];
      return { ...intl, formatMessage };
    },
  };
};
