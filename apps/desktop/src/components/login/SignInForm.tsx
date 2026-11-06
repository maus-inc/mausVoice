import { LoginCredentialsFields } from "./LoginCredentialsFields";
import { Button, Link, Stack } from "@mui/material";
import { FormattedMessage } from "react-intl";
import { setMode, submitSignIn } from "../../actions/login.actions";
import { useAppStore } from "../../store";
import {
  getCanSubmitLogin,
  getShouldShowEmailForm,
} from "../../utils/login.utils";
import { useState } from "react";

export const SignInForm = () => {
  const [passwordVisible, setPasswordVisible] = useState(false);

  const canSubmit = useAppStore((state) => getCanSubmitLogin(state));
  const showEmailForm = useAppStore((state) => getShouldShowEmailForm(state));

  const handleClickReset = () => {
    setMode("resetPassword");
  };

  const handleClickRegister = () => {
    setMode("signUp");
  };

  const handleSubmit = async () => {
    await submitSignIn();
  };

  return (
    <Stack spacing={2}>
      {showEmailForm && (
        <>
          <LoginCredentialsFields
            passwordVisible={passwordVisible}
            onTogglePasswordVisibility={() => setPasswordVisible((v) => !v)}
          />

          <Button
            variant="contained"
            fullWidth
            disabled={!canSubmit}
            onClick={handleSubmit}
          >
            <FormattedMessage defaultMessage="Log in" />
          </Button>

          <Stack
            direction="row"
            spacing={1}
            sx={{
              justifyContent: "space-between",
            }}
          >
            <Link component="button" onClick={handleClickReset}>
              <FormattedMessage defaultMessage="Forgot?" />
            </Link>
            <Link component="button" onClick={handleClickRegister}>
              <FormattedMessage defaultMessage="Create account" />
            </Link>
          </Stack>
        </>
      )}
    </Stack>
  );
};
