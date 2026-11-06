import { TextField } from "@mui/material";
import { FormattedMessage } from "react-intl";
import { produceAppState, useAppStore } from "../../store";
import { PasswordField } from "./PasswordField";

export const LoginCredentialsFields = ({
  passwordVisible,
  onTogglePasswordVisibility,
  emailValidation,
  passwordValidation,
}: {
  passwordVisible: boolean;
  onTogglePasswordVisibility: () => void;
  emailValidation?: string | null;
  passwordValidation?: string | null;
}) => {
  const email = useAppStore((state) => state.login.email);
  const password = useAppStore((state) => state.login.password);
  return (
    <>
      <TextField
        label={<FormattedMessage defaultMessage="Email" />}
        type="email"
        fullWidth
        value={email}
        onChange={(event) => {
          produceAppState((state) => {
            state.login.email = event.target.value;
          });
        }}
        error={!!emailValidation}
        helperText={emailValidation}
        size="small"
      />
      <PasswordField
        label={<FormattedMessage defaultMessage="Password" />}
        value={password}
        onChange={(event) => {
          produceAppState((state) => {
            state.login.password = event.target.value;
          });
        }}
        visible={passwordVisible}
        onToggleVisibility={onTogglePasswordVisibility}
        error={!!passwordValidation}
        helperText={passwordValidation}
      />
    </>
  );
};
