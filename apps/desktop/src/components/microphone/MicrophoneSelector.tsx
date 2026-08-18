import {
  Alert,
  Button,
  Box,
  Chip,
  CircularProgress,
  Divider,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  SelectChangeEvent,
  Stack,
  Typography,
} from "@mui/material";
import { Nullable } from "@maus-inc/types";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FormattedMessage } from "react-intl";
import { commands } from "@maus-inc/desktop-native-apis";
import { subscribeDeviceChange } from "../../utils/device-change.utils";

const AUTO_OPTION_VALUE = "__microphone_auto__";

export type MicrophoneOption = {
  value: string;
  label: string;
  isDefault?: boolean;
  caution?: boolean;
  unavailable?: boolean;
};

export type MicrophoneSelectorProps = {
  value: Nullable<string>;
  onChange: (value: Nullable<string>) => void;
  microphones?: MicrophoneOption[];
  disabled?: boolean;
};

export const MicrophoneSelector = ({
  value,
  onChange,
  microphones,
  disabled = false,
}: MicrophoneSelectorProps) => {
  const [devices, setDevices] = useState<MicrophoneOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (microphones) {
      setDevices(microphones);
    }
  }, [microphones]);

  const loadDevices = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // The backend disambiguates devices that report the same name, so `label`
      // doubles as the stable key the preference is stored under.
      const result = await commands.listMicrophones();
      const mapped: MicrophoneOption[] = result.map((device) => ({
        value: device.label,
        label: device.label,
        isDefault: device.isDefault,
        caution: device.caution,
      }));
      setDevices(mapped);
    } catch (err) {
      console.error("Failed to load microphones", err);
      setError("Unable to fetch microphones. Please try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!microphones) {
      void loadDevices();
    }
  }, [loadDevices, microphones]);

  useEffect(() => {
    if (microphones || typeof navigator === "undefined") {
      return;
    }
    return subscribeDeviceChange(navigator.mediaDevices, () => {
      void loadDevices();
    });
  }, [loadDevices, microphones]);

  const selectValue = value ?? AUTO_OPTION_VALUE;

  const options = useMemo(() => {
    const base = [...devices];
    if (value && !base.some((device) => device.value === value)) {
      base.push({
        value,
        label: `${value} (unavailable)`,
        caution: true,
        unavailable: true,
      });
    }
    return base;
  }, [devices, value]);

  const handleSelectChange = useCallback(
    (event: SelectChangeEvent<string>) => {
      const nextValue = event.target.value;
      const normalized = nextValue === AUTO_OPTION_VALUE ? null : nextValue;
      onChange(normalized);
    },
    [onChange],
  );

  const handleRefresh = useCallback(() => {
    if (!loading) {
      void loadDevices();
    }
  }, [loadDevices, loading]);

  return (
    <Stack spacing={1.5}>
      <FormControl fullWidth size="small" disabled={disabled || loading}>
        <InputLabel id="microphone-select-label">
          <FormattedMessage defaultMessage="Microphone" />
        </InputLabel>
        <Select
          labelId="microphone-select-label"
          value={selectValue}
          label={<FormattedMessage defaultMessage="Microphone" />}
          onChange={handleSelectChange}
        >
          <MenuItem value={AUTO_OPTION_VALUE}>
            <Stack
              direction="row"
              spacing={1}
              sx={{
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <Typography>
                <FormattedMessage defaultMessage="Automatic" />
              </Typography>
              <Chip
                size="small"
                label={<FormattedMessage defaultMessage="Recommended" />}
                color="primary"
                variant="filled"
              />
            </Stack>
          </MenuItem>
          <Divider sx={{ my: 0.5 }} />
          {options.map((option) => (
            <MenuItem key={option.value} value={option.value}>
              <Stack
                direction="row"
                spacing={2}
                sx={{
                  justifyContent: "space-between",
                  width: "100%",
                }}
              >
                <Box
                  sx={{
                    display: "flex",
                    flexDirection: "column",
                  }}
                >
                  <Typography>{option.label}</Typography>
                  {option.unavailable ? (
                    <Typography
                      variant="caption"
                      sx={{
                        color: "warning.main",
                      }}
                    >
                      <FormattedMessage defaultMessage="Currently unavailable" />
                    </Typography>
                  ) : option.caution ? (
                    <Typography
                      variant="caption"
                      sx={{
                        color: "text.secondary",
                      }}
                    >
                      <FormattedMessage defaultMessage="May provide lower audio quality" />
                    </Typography>
                  ) : null}
                </Box>
                <Stack
                  direction="row"
                  spacing={0.75}
                  sx={{
                    alignItems: "center",
                  }}
                >
                  {option.isDefault && (
                    <Chip
                      size="small"
                      label={<FormattedMessage defaultMessage="Default" />}
                      color="primary"
                      variant="outlined"
                    />
                  )}
                  {option.caution && !option.unavailable && (
                    <Chip
                      size="small"
                      label={<FormattedMessage defaultMessage="Caution" />}
                      color="warning"
                      variant="outlined"
                    />
                  )}
                </Stack>
              </Stack>
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      <Stack
        direction="row"
        spacing={1}
        sx={{
          alignItems: "center",
        }}
      >
        <Button
          variant="text"
          onClick={handleRefresh}
          size="small"
          disabled={loading}
        >
          <FormattedMessage defaultMessage="Refresh devices" />
        </Button>
        {loading && <CircularProgress size={18} />}
      </Stack>

      {error && <Alert severity="error">{error}</Alert>}
    </Stack>
  );
};
