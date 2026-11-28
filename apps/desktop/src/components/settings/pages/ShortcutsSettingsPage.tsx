import { KeyRound, Keyboard } from "lucide-react";
import { FormattedMessage } from "react-intl";
import { produceAppState } from "../../../store";
import { SettingGroup, SettingRow } from "../SettingRow";
import { settingGlyphProps } from "../setting-row-chassis";

const openDialog = (key: "shortcutsDialogOpen" | "styleHotkeysDialogOpen") => {
  produceAppState((draft) => {
    draft.settings[key] = true;
  });
};

export default function ShortcutsSettingsPage() {
  return (
    <>
      <SettingGroup title={<FormattedMessage defaultMessage="Dictation" />}>
        <SettingRow
          settingKey="hotkey_shortcuts"
          title={<FormattedMessage defaultMessage="Hotkey shortcuts" />}
          description={
            <FormattedMessage defaultMessage="The key that starts and stops dictation, and every other shortcut mausVoice listens for." />
          }
          icon={<Keyboard {...settingGlyphProps} />}
          onClick={() => openDialog("shortcutsDialogOpen")}
        />
      </SettingGroup>

      <SettingGroup title={<FormattedMessage defaultMessage="Styles" />}>
        <SettingRow
          settingKey="style_hotkeys"
          title={<FormattedMessage defaultMessage="Style hotkeys" />}
          description={
            <FormattedMessage defaultMessage="Bind a key to each writing style, so you can switch without opening the app." />
          }
          icon={<KeyRound {...settingGlyphProps} />}
          onClick={() => openDialog("styleHotkeysDialogOpen")}
        />
      </SettingGroup>
    </>
  );
}
