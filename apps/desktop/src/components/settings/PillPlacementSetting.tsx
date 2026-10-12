import type { PillPlacement } from "@maus-inc/types";
import { FormattedMessage, useIntl } from "react-intl";
import { setPillPlacement } from "../../actions/user.actions";
import { isWindows } from "../../utils/env.utils";
import { useAppStore } from "../../store";
import { logOnRejection } from "../../utils/promise.utils";
import { getMyUserPreferences } from "../../utils/user.utils";
import { SegmentedControl } from "../common/SegmentedControl";
import { SettingRow } from "./SettingRow";

/**
 * Whether the native pill implements the `pill_placement` IPC message.
 *
 * Only the native Windows pill does. The GTK pill drops it as an unknown
 * message and the macOS pill ignores it, so on those platforms the row is not
 * rendered. The same predicate belongs in the settings availability snapshot,
 * which is what search and `?setting=` deep links read, or the setting stays
 * searchable and deep-linkable on platforms that have no such control.
 */
export const isPillPlacementAvailable = (): boolean => isWindows();

export const PillPlacementSetting = () => {
  const intl = useIntl();
  const placement = useAppStore(
    (state) => getMyUserPreferences(state)?.pillPlacement ?? "bottom",
  );

  // See `isPillPlacementAvailable` for why the control is Windows-only.
  if (!isPillPlacementAvailable()) {
    return null;
  }

  const handleChange = (next: PillPlacement) => {
    // `setPillPlacement` shows its own localized snackbar and then rethrows, so
    // the rejection is already reported. A bare `void` would leave it as an
    // unhandled rejection on top of that toast.
    logOnRejection(
      setPillPlacement(next),
      "pill placement setting: setPillPlacement",
    );
  };

  return (
    <SettingRow
      settingKey="pill_placement"
      title={<FormattedMessage defaultMessage="Pill placement" />}
      description={
        <FormattedMessage defaultMessage="Whether the dictation pill anchors to the top or the bottom of the screen." />
      }
      control={
        <SegmentedControl<PillPlacement>
          value={placement}
          onChange={handleChange}
          options={[
            {
              value: "top",
              label: intl.formatMessage({ defaultMessage: "Top" }),
            },
            {
              value: "bottom",
              label: intl.formatMessage({ defaultMessage: "Bottom" }),
            },
          ]}
          ariaLabel={intl.formatMessage({ defaultMessage: "Pill placement" })}
        />
      }
    />
  );
};
