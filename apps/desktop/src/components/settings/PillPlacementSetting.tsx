import type { PillPlacement } from "@maus-inc/types";
import { FormattedMessage } from "react-intl";
import { setPillPlacement } from "../../actions/user.actions";
import { useAppStore } from "../../store";
import { getMyUserPreferences } from "../../utils/user.utils";
import { SegmentedControl } from "../common/SegmentedControl";
import { SettingSection } from "../common/SettingSection";

export const PillPlacementSetting = () => {
  const placement = useAppStore(
    (state) => getMyUserPreferences(state)?.pillPlacement ?? "bottom",
  );

  const handleChange = (next: PillPlacement) => {
    void setPillPlacement(next);
  };

  return (
    <SettingSection
      title={<FormattedMessage defaultMessage="Pill placement" />}
      description={
        <FormattedMessage defaultMessage="Choose whether the dictation pill anchors to the top or bottom of the screen." />
      }
      action={
        <SegmentedControl<PillPlacement>
          value={placement}
          onChange={handleChange}
          options={[
            { value: "top", label: "Top" },
            { value: "bottom", label: "Bottom" },
          ]}
          ariaLabel="Pill placement"
        />
      }
    />
  );
};
