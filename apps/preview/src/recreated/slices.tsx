/**
 * Presentational slices of store/native-bound components.
 *
 * ToneSelect — recreated: store (toneById, prefs) + actions (openToneEditor).
 *   Render code copied verbatim from components/tones/ToneSelect.tsx; fixture
 *   tones stand in for the store. TranscriptionToneMenu is a MenuPopoverBuilder
 *   of the same rows — the demo composes the REAL MenuPopoverBuilder +
 *   ListTile with the same Add labels.
 * MicrophoneSelector — recreated: native device enumeration via
 *   @maus-inc/desktop-native-apis (tauri invoke). Render code copied verbatim
 *   from components/microphone/MicrophoneSelector.tsx; fixture devices.
 *   MicrophoneTester pairs the selector with the REAL AudioWaveform.
 */
import { Add, Edit, Public } from "@mui/icons-material";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Tooltip,
  Typography,
  type SelectChangeEvent,
  type SxProps,
  type Theme,
} from "@mui/material";
import { useState } from "react";
import { AudioWaveform } from "@desktop/components/common/AudioWaveform";

// ─── ToneSelect ───────────────────────────────────────────────────

export type ToneFixture = { id: string; name: string; isGlobal?: boolean; isSystem?: boolean };

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
        {tones.map((tone) => (
          <MenuItem key={tone.id} value={tone.id}>
            <Stack
              direction="row"
              sx={{ alignItems: "center", justifyContent: "space-between", width: "100%" }}
            >
              <div>{tone.name}</div>
              {tone.isGlobal ? (
                <Tooltip title="This is a global style and cannot be edited">
                  <Public fontSize="small" sx={{ color: "text.secondary" }} />
                </Tooltip>
              ) : !tone.isSystem ? (
                <IconButton
                  size="small"
                  onClick={(event) => {
                    event.stopPropagation();
                    event.preventDefault();
                    setMenuOpen(false);
                  }}
                >
                  <Edit fontSize="small" />
                </IconButton>
              ) : null}
            </Stack>
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

export const MIC_FIXTURES: MicOption[] = [
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
            <Stack direction="row" spacing={1} sx={{ justifyContent: "space-between", alignItems: "center" }}>
              <Typography>Automatic</Typography>
              <Chip size="small" label="Recommended" color="primary" variant="filled" />
            </Stack>
          </MenuItem>
          <Divider sx={{ my: 0.5 }} />
          {options.map((option) => (
            <MenuItem key={option.value} value={option.value}>
              <Stack direction="row" spacing={2} sx={{ justifyContent: "space-between", width: "100%" }}>
                <Box sx={{ display: "flex", flexDirection: "column" }}>
                  <Typography>{option.label}</Typography>
                  {option.unavailable ? (
                    <Typography variant="caption" sx={{ color: "warning.main" }}>
                      Currently unavailable
                    </Typography>
                  ) : option.caution ? (
                    <Typography variant="caption" sx={{ color: "text.secondary" }}>
                      May provide lower audio quality
                    </Typography>
                  ) : null}
                </Box>
                <Stack direction="row" spacing={0.75} sx={{ alignItems: "center" }}>
                  {option.isDefault && (
                    <Chip size="small" label="Default" color="primary" variant="outlined" />
                  )}
                  {option.caution && !option.unavailable && (
                    <Chip size="small" label="Caution" color="warning" variant="outlined" />
                  )}
                </Stack>
              </Stack>
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
export const MicrophoneTesterPreview = ({ active = true }: { active?: boolean }) => {
  const [levels, setLevels] = useState<number[]>([]);
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
        <Button
          variant="flat"
          size="small"
          onClick={() => {
            const id = setInterval(() => {
              setLevels(Array.from({ length: 24 }, () => Math.random()));
            }, 120);
            setTimeout(() => {
              clearInterval(id);
              setLevels([]);
            }, 3000);
          }}
        >
          Simulate input
        </Button>
      </Box>
    </Stack>
  );
};
