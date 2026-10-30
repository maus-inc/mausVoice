import {
  InputAdornment,
  MenuItem,
  Select,
  TextField,
  type SelectChangeEvent,
} from "@mui/material";
import { useEffect, useRef } from "react";
import { settingAnchorId } from "./settings-routes";

/**
 * The two controls the settings rows share.
 *
 * Both fill the row's control column, so a select on one row and a number
 * field on the next line up on the same edges instead of each taking whatever
 * width its contents happened to need.
 */

export type SettingSelectOption<Value extends string> = {
  value: Value;
  label: string;
};

export const SettingSelect = <Value extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: Value;
  options: SettingSelectOption<Value>[];
  onChange: (value: Value) => void;
  ariaLabel: string;
}) => (
  <Select<Value>
    size="small"
    fullWidth
    value={value}
    aria-label={ariaLabel}
    onChange={(event: SelectChangeEvent) =>
      onChange(event.target.value as Value)
    }
    MenuProps={{ slotProps: { paper: { style: { maxHeight: 320 } } } }}
  >
    {options.map((option) => (
      <MenuItem key={option.value} value={option.value}>
        {option.label}
      </MenuItem>
    ))}
  </Select>
);

export type SettingNumberFieldProps = {
  /** The owning row supplies the visible label and description. */
  rowKey: string;
  value: string;
  onChange: (value: string) => void;
  /** Committed on blur and on Enter, never on each keystroke. */
  onCommit: () => void;
  /** Unit shown inside the field, so the number is never unitless. */
  unit?: string;
  /** Shown under the field when the value cannot be saved. */
  error?: string | null;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
};

export const SettingNumberField = ({
  rowKey,
  value,
  onChange,
  onCommit,
  unit,
  error,
  min,
  max,
  step = 1,
  disabled,
}: SettingNumberFieldProps) => {
  const rowId = settingAnchorId(rowKey);
  const inputId = `${rowId}-input`;
  const inputRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

  // An error can extend below a short viewport after Enter. Reveal it only
  // while this field still has focus; a blur must not pull the page away from
  // whatever the person clicked next.
  useEffect(() => {
    if (error && document.activeElement === inputRef.current) {
      errorRef.current?.scrollIntoView?.({ block: "nearest" });
    }
  }, [error]);

  return (
    <TextField
      id={inputId}
      inputRef={inputRef}
      size="small"
      fullWidth
      type="number"
      value={value}
      disabled={disabled}
      error={Boolean(error)}
      helperText={error ?? undefined}
      onChange={(event) => onChange(event.target.value)}
      onBlur={onCommit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          onCommit();
        }
      }}
      slotProps={{
        htmlInput: {
          min,
          max,
          step,
          inputMode: "numeric",
          "aria-labelledby": `${rowId}-label`,
          "aria-describedby": `${rowId}-description${error ? ` ${inputId}-helper-text` : ""}`,
        },
        input: unit
          ? {
              endAdornment: (
                <InputAdornment position="end">{unit}</InputAdornment>
              ),
            }
          : undefined,
        formHelperText: error ? { role: "alert", ref: errorRef } : undefined,
      }}
      sx={{
        "& .MuiFormHelperText-root": {
          marginLeft: 0,
          textAlign: "right",
        },
      }}
    />
  );
};
