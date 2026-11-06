import { FormControl, InputLabel, MenuItem, Select } from "@mui/material";
import type { Tone } from "@maus-inc/types";
import { Check } from "lucide-react";
import { FormattedMessage, useIntl } from "react-intl";
import {
  AUTO_LANGUAGE,
  DICTATION_LANGUAGES,
  type DictationLanguageCode,
  ORDERED_DICTATION_LANGUAGES,
} from "../../utils/language.utils";
import {
  chromeMenuItemSx,
  chromeSelectMenuProps,
  selectedOptionLabel,
} from "../common/chromeMenu";

const languageOptions = (
  [
    AUTO_LANGUAGE,
    ...ORDERED_DICTATION_LANGUAGES,
  ] satisfies DictationLanguageCode[]
).map((code) => ({ code, label: DICTATION_LANGUAGES[code] }));

/** Shared style and language choices for importing and retranscribing audio. */
export const TranscriptionOptions = ({
  tones,
  styleSelectionAvailable,
  selectedToneId,
  onToneChange,
  selectedLanguage,
  onLanguageChange,
}: {
  tones: Tone[];
  styleSelectionAvailable: boolean;
  selectedToneId: string | null;
  onToneChange: (toneId: string | null) => void;
  selectedLanguage: DictationLanguageCode;
  onLanguageChange: (language: DictationLanguageCode) => void;
}) => {
  const intl = useIntl();
  return (
    <>
      {styleSelectionAvailable && (
        <FormControl fullWidth size="small">
          <InputLabel>
            <FormattedMessage defaultMessage="Style" />
          </InputLabel>
          <Select
            label={intl.formatMessage({ defaultMessage: "Style" })}
            value={selectedToneId ?? ""}
            onChange={(event) => onToneChange(event.target.value || null)}
            MenuProps={chromeSelectMenuProps}
            renderValue={(value) =>
              selectedOptionLabel(
                value,
                tones,
                (tone) => tone.id,
                (tone) => tone.name,
              )
            }
          >
            {tones.map((tone) => (
              <MenuItem key={tone.id} value={tone.id} sx={chromeMenuItemSx}>
                {tone.name}
                {tone.id === selectedToneId ? (
                  <Check size={16} strokeWidth={2} />
                ) : null}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      )}
      <FormControl fullWidth size="small">
        <InputLabel>
          <FormattedMessage defaultMessage="Language" />
        </InputLabel>
        <Select
          label={intl.formatMessage({ defaultMessage: "Language" })}
          value={selectedLanguage}
          onChange={(event) =>
            onLanguageChange(event.target.value as DictationLanguageCode)
          }
          MenuProps={chromeSelectMenuProps}
          renderValue={(value) =>
            selectedOptionLabel(
              value,
              languageOptions,
              (option) => option.code,
              (option) => option.label,
            )
          }
        >
          {languageOptions.map(({ code, label }) => (
            <MenuItem key={code} value={code} sx={chromeMenuItemSx}>
              {label}
              {code === selectedLanguage ? (
                <Check size={16} strokeWidth={2} />
              ) : null}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
    </>
  );
};
