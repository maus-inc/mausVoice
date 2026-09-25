import { useMemo } from "react";
import { useIntl } from "react-intl";
import { Breadcrumb } from "../components/common/Breadcrumb";
import { useSetHeaderContent } from "./header.hooks";

/**
 * Puts Home / leaf into the header left slot. The node is memoized so
 * useSetHeaderContent does not loop.
 */
export const useDashboardBreadcrumb = (leafLabel: string) => {
  const intl = useIntl();
  const homeLabel = intl.formatMessage({ defaultMessage: "Home" });
  const content = useMemo(
    () => (
      <Breadcrumb
        items={[{ label: homeLabel, href: "/dashboard" }, { label: leafLabel }]}
      />
    ),
    [homeLabel, leafLabel],
  );
  useSetHeaderContent(content);
};
