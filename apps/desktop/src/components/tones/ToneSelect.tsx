import { Add, Edit, Public } from "@mui/icons-material";
import { Check } from "lucide-react";
import {
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  SelectChangeEvent,
  Stack,
  Tooltip,
  type SxProps,
  type Theme,
} from "@mui/material";
import type { Tone } from "@maus-inc/types";
import { getRec } from "@maus-inc/utilities";
import { useCallback, useId, useMemo, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { setLocalStorageValue } from "../../actions/local-storage.actions";
import { openToneEditorDialog } from "../../actions/tone.actions";
import {
  chromeMenuItemSx,
  chromeSelectMenuItemSx,
  chromeStyleSelectMenuProps,
} from "../common/chromeMenu";
import { useAppStore } from "../../store";
import { getSortedToneIds } from "../../utils/tone.utils";
import { getMyUserPreferences } from "../../utils/user.utils";

const ADD_TONE_MENU_VALUE = "__add_tone_option__";

type ToneSelectProps = {
  value: string | null | undefined;
  onToneChange: (toneId: string | null) => void;
  addToneTargetId?: string | null;
  disabled?: boolean;
  formControlSx?: SxProps<Theme>;
  selectSize?: "small" | "medium";
  label?: string;
  trueDefault?: boolean;
};

export const ToneSelect = ({
  value,
  onToneChange,
  addToneTargetId = null,
  disabled = false,
  formControlSx,
  selectSize = "small",
  label,
  trueDefault,
}: ToneSelectProps) => {
  const intl = useIntl();
  const labelId = useId();
  const toneById = useAppStore((state) => state.toneById);
  const defaultTone = useAppStore((state) => {
    const userPreferences = getMyUserPreferences(state);
    return getRec(state.toneById, userPreferences?.activeToneId);
  });

  const sortedToneIds = useAppStore((state) => getSortedToneIds(state));
  const tones = useMemo(
    () => sortedToneIds.map((id) => toneById[id]).filter(Boolean) as Tone[],
    [sortedToneIds, toneById],
  );

  const [menuOpen, setMenuOpen] = useState(false);

  const handleToneChange = useCallback(
    (event: SelectChangeEvent<string>) => {
      if (event.target.value === ADD_TONE_MENU_VALUE) {
        setMenuOpen(false);
        openToneEditorDialog({ mode: "create", targetId: addToneTargetId });
        return;
      }

      const toneId = event.target.value === "" ? null : event.target.value;
      setLocalStorageValue("mausvoice:checklist-writing-style", true);
      onToneChange(toneId);
    },
    [addToneTargetId, onToneChange],
  );

  const handleSelectOpen = useCallback(() => setMenuOpen(true), []);
  const handleSelectClose = useCallback(() => setMenuOpen(false), []);

  const resolvedValue = getRec(toneById, value)?.id ?? "default";

  return (
    <FormControl size={selectSize} sx={formControlSx}>
      {label && (
        <InputLabel id={labelId} shrink>
          {label}
        </InputLabel>
      )}
      <Select
        open={menuOpen}
        onOpen={handleSelectOpen}
        onClose={handleSelectClose}
        labelId={label ? labelId : undefined}
        value={resolvedValue}
        displayEmpty
        onChange={handleToneChange}
        size={selectSize}
        disabled={disabled}
        label={label}
        MenuProps={chromeStyleSelectMenuProps}
        renderValue={(selected) => {
          if (!selected) {
            return defaultTone && !trueDefault ? (
              <FormattedMessage
                defaultMessage="Default ({toneName})"
                values={{ toneName: defaultTone.name }}
              />
            ) : (
              <FormattedMessage defaultMessage="Default" />
            );
          }

          return toneById[selected]?.name ?? selected;
        }}
      >
        <MenuItem value={ADD_TONE_MENU_VALUE} sx={chromeMenuItemSx}>
          <Stack
            direction="row"
            spacing={1}
            sx={{
              alignItems: "center",
            }}
          >
            <Add fontSize="small" />
            <div>
              <FormattedMessage defaultMessage="New style" />
            </div>
          </Stack>
        </MenuItem>
        {tones.map((tone) => (
          <MenuItem key={tone.id} value={tone.id} sx={chromeSelectMenuItemSx}>
            <Stack
              direction="row"
              sx={{
                alignItems: "center",
                justifyContent: "space-between",
                width: "100%",
              }}
            >
              <div>{tone.name}</div>
              <Stack
                direction="row"
                spacing={0.5}
                sx={{ alignItems: "center" }}
              >
                {tone.id === resolvedValue ? (
                  <Check size={16} strokeWidth={2} aria-hidden="true" />
                ) : null}
                {tone.isGlobal ? (
                  <Tooltip
                    title={intl.formatMessage({
                      defaultMessage:
                        "This is a global style and cannot be edited",
                    })}
                  >
                    <Public fontSize="small" sx={{ color: "text.secondary" }} />
                  </Tooltip>
                ) : !tone.isSystem ? (
                  <IconButton
                    size="small"
                    onClick={(event) => {
                      event.stopPropagation();
                      event.preventDefault();
                      setMenuOpen(false);
                      openToneEditorDialog({ mode: "edit", toneId: tone.id });
                    }}
                  >
                    <Edit fontSize="small" />
                  </IconButton>
                ) : null}
              </Stack>
            </Stack>
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );
};
