import {
  Edit,
  LanguageOutlined,
  MoreVertOutlined,
  WarningAmberOutlined,
} from "@mui/icons-material";
import {
  Box,
  Button,
  IconButton,
  Link,
  MenuItem,
  Select,
  Tooltip,
  type SelectChangeEvent,
} from "@mui/material";
import { FormattedMessage, useIntl } from "react-intl";
import { loadTones } from "../../actions/tone.actions";
import { setPreferredLanguage } from "../../actions/user.actions";
import { produceAppState, useAppStore } from "../../store";
import { getAdditionalLanguageEntries } from "../../utils/keyboard.utils";
import {
  DICTATION_LANGUAGE_OPTIONS,
  KEYBOARD_LAYOUT_LANGUAGE,
  WHISPER_LANGUAGES,
} from "../../utils/language.utils";
import { logOnRejection } from "../../utils/promise.utils";
import {
  getDetectedSystemLocale,
  getGenerativePrefs,
  getMyUser,
} from "../../utils/user.utils";
import { ListTile } from "../common/ListTile";

export const DictationLanguageSetting = ({
  openPostProcessingDialog,
}: {
  openPostProcessingDialog: () => void;
}) => {
  const intl = useIntl();
  const dictationLanguage = useAppStore((state) => {
    const user = getMyUser(state);
    return user?.preferredLanguage ?? getDetectedSystemLocale();
  });

  const dictationLanguageWarning = useAppStore((state) => {
    const hasPostProcessingEnabled = getGenerativePrefs(state).mode !== "none";
    if (hasPostProcessingEnabled) {
      return null;
    }

    if (dictationLanguage === KEYBOARD_LAYOUT_LANGUAGE) {
      return null;
    }

    const isWhisperLang = dictationLanguage in WHISPER_LANGUAGES;
    if (!isWhisperLang) {
      return intl.formatMessage({
        defaultMessage:
          "Be sure to enable AI post processing when using this language for the best results.",
      });
    }

    return null;
  });

  const hasAdditionalLanguages = useAppStore(
    (state) => getAdditionalLanguageEntries(state).length > 0,
  );

  const openDictationLanguageDialog = () => {
    produceAppState((draft) => {
      draft.settings.dictationLanguageDialogOpen = true;
    });
  };

  const handleDictationLanguageChange = (event: SelectChangeEvent<string>) => {
    const nextValue = event.target.value;
    // The action reports errors and rethrows, so handle the rejected promise.
    logOnRejection(
      setPreferredLanguage(nextValue).then(() => {
        // The tone list is provider-dependent, so a rejection here is reported
        // through the same path as the language write.
        logOnRejection(loadTones(), "settings: reload tones");
      }),
      "settings: setPreferredLanguage",
    );
  };

  return (
    <>
      {hasAdditionalLanguages ? (
        <ListTile
          title={<FormattedMessage defaultMessage="Dictation language" />}
          leading={<LanguageOutlined />}
          onClick={openDictationLanguageDialog}
          trailing={
            <Button
              variant="outlined"
              size="small"
              endIcon={<Edit sx={{ fontSize: 16 }} />}
              onClick={openDictationLanguageDialog}
              sx={{ textTransform: "none", py: 0.5, px: 1.5, fontWeight: 400 }}
            >
              <FormattedMessage defaultMessage="Multiple languages" />
            </Button>
          }
        />
      ) : (
        <ListTile
          title={<FormattedMessage defaultMessage="Dictation language" />}
          leading={<LanguageOutlined />}
          disableRipple
          trailing={
            <Box
              onClick={(event) => event.stopPropagation()}
              sx={{
                minWidth: 200,
                display: "flex",
                alignItems: "center",
                gap: 1,
              }}
            >
              {dictationLanguageWarning && (
                <Tooltip
                  title={
                    <Box>
                      {dictationLanguageWarning}{" "}
                      <Link
                        component="button"
                        color="inherit"
                        sx={{ verticalAlign: "baseline" }}
                        onClick={openPostProcessingDialog}
                      >
                        <FormattedMessage defaultMessage="Fix issue" />
                      </Link>
                    </Box>
                  }
                  slotProps={{
                    popper: {
                      modifiers: [
                        { name: "offset", options: { offset: [0, -8] } },
                      ],
                    },
                  }}
                >
                  <WarningAmberOutlined color="warning" fontSize="small" />
                </Tooltip>
              )}
              <Tooltip
                title={
                  <FormattedMessage defaultMessage="Set up multiple languages with different hotkeys" />
                }
              >
                <IconButton size="small" onClick={openDictationLanguageDialog}>
                  <MoreVertOutlined fontSize="small" />
                </IconButton>
              </Tooltip>
              <Select
                value={dictationLanguage}
                onChange={handleDictationLanguageChange}
                size="small"
                variant="outlined"
                fullWidth
                inputProps={{ "aria-label": "Dictation language" }}
                MenuProps={{
                  slotProps: {
                    paper: {
                      style: {
                        maxHeight: 300,
                      },
                    },
                  },
                }}
              >
                {DICTATION_LANGUAGE_OPTIONS.map(([value, label]) => (
                  <MenuItem key={value} value={value}>
                    {label}
                  </MenuItem>
                ))}
              </Select>
            </Box>
          }
        />
      )}
    </>
  );
};
