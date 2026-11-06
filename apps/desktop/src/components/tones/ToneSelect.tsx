import { Add } from "@mui/icons-material";
import {
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  SelectChangeEvent,
  Stack,
  type SxProps,
  type Theme,
} from "@mui/material";
import type { Tone } from "@maus-inc/types";
import { getRec } from "@maus-inc/utilities";
import { useCallback, useMemo, useState } from "react";
import { FormattedMessage } from "react-intl";
import { setLocalStorageValue } from "../../actions/local-storage.actions";
import { openToneEditorDialog } from "../../actions/tone.actions";
import { useAppStore } from "../../store";
import { getSortedToneIds } from "../../utils/tone.utils";
import { getMyUserPreferences } from "../../utils/user.utils";
import { ToneOptionContent } from "./ToneOptionContent";

const ADD_TONE_MENU_VALUE = "__add_tone_option__";

const DefaultToneLabel = ({ name }: { name?: string }) =>
  name !== undefined ? (
    <FormattedMessage
      defaultMessage="Default ({toneName})"
      values={{ toneName: name }}
    />
  ) : (
    <FormattedMessage defaultMessage="Default" />
  );

export const ToneSelect = ({
  value,
  onToneChange,
  addToneTargetId = null,
  disabled = false,
  formControlSx,
  selectSize = "small",
  label,
  trueDefault,
}: {
  value: string | null | undefined;
  onToneChange: (toneId: string | null) => void;
  addToneTargetId?: string | null;
  disabled?: boolean;
  formControlSx?: SxProps<Theme>;
  selectSize?: "small" | "medium";
  label?: string;
  trueDefault?: boolean;
}) => {
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

  const resolvedValue = getRec(toneById, value)?.id ?? "";
  const defaultLabel = (
    <DefaultToneLabel name={trueDefault ? undefined : defaultTone?.name} />
  );

  return (
    <FormControl size={selectSize} sx={formControlSx}>
      {label && <InputLabel shrink>{label}</InputLabel>}
      <Select
        open={menuOpen}
        onOpen={handleSelectOpen}
        onClose={handleSelectClose}
        value={resolvedValue}
        displayEmpty
        onChange={handleToneChange}
        size={selectSize}
        disabled={disabled}
        label={label}
        renderValue={(selected) => {
          if (!selected) {
            return defaultLabel;
          }

          return toneById[selected]?.name ?? selected;
        }}
      >
        <MenuItem value={ADD_TONE_MENU_VALUE}>
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
        <MenuItem value="">{defaultLabel}</MenuItem>
        {tones.map((tone) => (
          <MenuItem key={tone.id} value={tone.id}>
            <ToneOptionContent
              name={tone.name}
              isGlobal={tone.isGlobal}
              isSystem={tone.isSystem}
              onEdit={() => {
                setMenuOpen(false);
                openToneEditorDialog({ mode: "edit", toneId: tone.id });
              }}
            />
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );
};
