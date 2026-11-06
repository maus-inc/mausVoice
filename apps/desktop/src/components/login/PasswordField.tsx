import { Visibility, VisibilityOff } from "@mui/icons-material";
import { IconButton, TextField } from "@mui/material";
import type { ChangeEvent, ReactNode } from "react";
import { useIntl } from "react-intl";

export const PasswordField = ({
  label,
  value,
  onChange,
  visible,
  onToggleVisibility,
  error,
  helperText,
}: {
  label: ReactNode;
  value: string;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  visible: boolean;
  onToggleVisibility: () => void;
  error?: boolean;
  helperText?: ReactNode;
}) => {
  const intl = useIntl();
  return (
    <TextField
      label={label}
      type={visible ? "text" : "password"}
      fullWidth
      value={value}
      onChange={onChange}
      error={error}
      helperText={helperText}
      size="small"
      slotProps={{
        input: {
          endAdornment: (
            <IconButton
              aria-label={
                visible
                  ? intl.formatMessage({
                      id: "hide_password",
                      defaultMessage: "Hide password",
                    })
                  : intl.formatMessage({
                      id: "show_password",
                      defaultMessage: "Show password",
                    })
              }
              onClick={onToggleVisibility}
              size="small"
            >
              {!visible ? <VisibilityOff /> : <Visibility />}
            </IconButton>
          ),
        },
      }}
    />
  );
};
