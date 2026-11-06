/**
 * Presentational slices of store/native-bound components.
 *
 * ToneSelect — recreated: store (toneById, prefs) + actions (openToneEditor).
 *   Render code copied verbatim from components/tones/ToneSelect.tsx; fixture
 *   tones stand in for the store. The demo also shows a generic menu built
 *   with the real MenuPopoverBuilder.
 * MicrophoneSelector — recreated: native device enumeration via
 *   @maus-inc/desktop-native-apis (tauri invoke); fixture devices drive the
 *   recreated selector. Option rows and the tester use real desktop components.
 */
import { MicrophoneOptionContent } from "@desktop/components/microphone/MicrophoneOptionContent";
import { useSimulatedLevels } from "../lib/simulated-levels";
import { Add } from "@mui/icons-material";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Typography,
  type SelectChangeEvent,
  type SxProps,
  type Theme,
} from "@mui/material";
import { useState } from "react";
import { AudioWaveform } from "@desktop/components/common/AudioWaveform";
import { ToneOptionContent } from "@desktop/components/tones/ToneOptionContent";

// ─── ToneSelect ───────────────────────────────────────────────────

export type ToneFixture = {
  id: string;
  name: string;
  isGlobal?: boolean;
  isSystem?: boolean;
};

export const TONE_FIXTURES: ToneFixture[] = [
  { id: "tone-concise", name: "Concise", isSystem: true },
  { id: "tone-formal", name: "Formal memo" },
  { id: "tone-global", name: "Company voice", isGlobal: true },
];

export const ToneSelectPreview = ({
  tones = TONE_FIXTURES,
  value: controlled,
  label,
  disabled,
  formControlSx,
}: {
  tones?: ToneFixture[];
  value?: string;
  label?: string;
  disabled?: boolean;
  formControlSx?: SxProps<Theme>;
}) => {
  const [value, setValue] = useState(controlled ?? "");
  const [menuOpen, setMenuOpen] = useState(false);
  const resolved = controlled ?? value;
  const toneById = Object.fromEntries(tones.map((t) => [t.id, t]));

  const handleChange = (event: SelectChangeEvent<string>) => {
    if (event.target.value === "__add__") return;
    setValue(event.target.value);
  };

  return (
    <FormControl size="medium" sx={formControlSx} fullWidth>
      {label && <InputLabel shrink>{label}</InputLabel>}
      <Select
        open={menuOpen}
        onOpen={() => setMenuOpen(true)}
        onClose={() => setMenuOpen(false)}
        value={resolved}
        displayEmpty
        onChange={handleChange}
        disabled={disabled}
        label={label}
        renderValue={(selected) => {
          if (!selected) return <>Default</>;
          return toneById[selected]?.name ?? selected;
        }}
      >
        <MenuItem value="__add__">
          <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
            <Add fontSize="small" />
            <div>New style</div>
          </Stack>
        </MenuItem>
        <MenuItem value="">Default</MenuItem>
        {tones.map((tone) => (
          <MenuItem key={tone.id} value={tone.id}>
            <ToneOptionContent
              name={tone.name}
              isGlobal={tone.isGlobal}
              isSystem={tone.isSystem}
              globalLabel="This is a global style and cannot be edited"
              onEdit={() => setMenuOpen(false)}
            />
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );
};

// ─── MicrophoneSelector ───────────────────────────────────────────

export type MicOption = {
  value: string;
  label: string;
  unavailable?: boolean;
  caution?: boolean;
  isDefault?: boolean;
};

const MIC_FIXTURES: MicOption[] = [
  { value: "macbook-mic", label: "MacBook Pro Microphone", isDefault: true },
  { value: "usb-yeti", label: "Yeti USB Microphone" },
  { value: "bt-airpods", label: "AirPods Pro", caution: true },
  { value: "old-webcam", label: "USB Webcam Mic", unavailable: true },
];

export const MicrophoneSelectorPreview = ({
  options = MIC_FIXTURES,
  disabled,
  loading,
  error,
}: {
  options?: MicOption[];
  disabled?: boolean;
  loading?: boolean;
  error?: string | null;
}) => {
  const [selectValue, setSelectValue] = useState("auto");
  const [spinning, setSpinning] = useState(false);
  const busy = loading || spinning;

  return (
    <Stack spacing={1.5}>
      <FormControl fullWidth size="small" disabled={disabled || busy}>
        <InputLabel id="microphone-select-label">Microphone</InputLabel>
        <Select
          labelId="microphone-select-label"
          value={selectValue}
          label="Microphone"
          onChange={(e) => setSelectValue(e.target.value)}
        >
          <MenuItem value="auto">
            <Stack
              direction="row"
              spacing={1}
              sx={{ justifyContent: "space-between", alignItems: "center" }}
            >
              <Typography>Automatic</Typography>
              <Chip
                size="small"
                label="Recommended"
                color="primary"
                variant="filled"
              />
            </Stack>
          </MenuItem>
          <Divider sx={{ my: 0.5 }} />
          {options.map((option) => (
            <MenuItem key={option.value} value={option.value}>
              <MicrophoneOptionContent
                option={option}
                showUnavailableSuffix={false}
              />
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
        <Button
          variant="text"
          size="small"
          disabled={busy}
          onClick={() => {
            setSpinning(true);
            setTimeout(() => setSpinning(false), 1200);
          }}
        >
          Refresh devices
        </Button>
        {busy && <CircularProgress size={18} />}
      </Stack>

      {error && <Alert severity="error">{error}</Alert>}
    </Stack>
  );
};

/** Tester: selector + live waveform (real AudioWaveform with simulated levels). */
export const MicrophoneTesterPreview = ({
  active = true,
}: {
  active?: boolean;
}) => {
  const { levels, feed } = useSimulatedLevels(24, 120, 3000);
  return (
    <Stack spacing={2}>
      <MicrophoneSelectorPreview />
      <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
        <AudioWaveform
          levels={levels}
          active={active}
          width={220}
          height={48}
        />
        <Button variant="flat" size="small" onClick={feed}>
          Simulate input
        </Button>
      </Box>
    </Stack>
  );
};
