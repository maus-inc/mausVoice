import { LoginCredentialsFields } from "./LoginCredentialsFields";
import { PasswordField } from "./PasswordField";
import { Button, Link, Stack } from "@mui/material";
import { useState } from "react";
import { FormattedMessage } from "react-intl";
import { produceAppState, useAppStore } from "../../store";
import { setMode, submitSignUp } from "../../actions/login.actions";
import {
  getCanSubmitSignUp,
  getShouldShowEmailForm,
  getSignUpConfirmPasswordValidation,
  getSignUpEmailValidation,
  getSignUpPasswordValidation,
} from "../../utils/login.utils";

export const SignUpForm = ({
  hideModeSwitch = false,
}: {
  hideModeSwitch?: boolean;
}) => {
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [confirmPasswordVisible, setConfirmPasswordVisible] = useState(false);

  const confirmPassword = useAppStore((state) => state.login.confirmPassword);
  const canSubmit = useAppStore((state) => getCanSubmitSignUp(state));
  const showEmailForm = useAppStore((state) => getShouldShowEmailForm(state));

  const emailValidation = useAppStore((state) =>
    getSignUpEmailValidation(state),
  );
  const passwordValidation = useAppStore((state) =>
    getSignUpPasswordValidation(state),
  );
  const confirmPasswordValidation = useAppStore((state) =>
    getSignUpConfirmPasswordValidation(state),
  );

  const handleChangeConfirmPassword = (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    produceAppState((state) => {
      state.login.confirmPassword = event.target.value;
    });
  };

  const handleClickLogin = () => {
    setMode("signIn");
  };

  const handleSubmit = async () => {
    await submitSignUp();
  };

  return (
    <Stack spacing={2}>
      {showEmailForm && (
        <>
          <LoginCredentialsFields
            passwordVisible={passwordVisible}
            onTogglePasswordVisibility={() => setPasswordVisible((v) => !v)}
            emailValidation={emailValidation}
            passwordValidation={passwordValidation}
          />
          <PasswordField
            label={<FormattedMessage defaultMessage="Confirm password" />}
            value={confirmPassword}
            onChange={handleChangeConfirmPassword}
            visible={confirmPasswordVisible}
            onToggleVisibility={() => setConfirmPasswordVisible((v) => !v)}
            error={!!confirmPasswordValidation}
            helperText={confirmPasswordValidation}
          />

          <Button
            variant="contained"
            fullWidth
            disabled={!canSubmit}
            onClick={handleSubmit}
          >
            <FormattedMessage defaultMessage="Create account" />
          </Button>
        </>
      )}

      {!hideModeSwitch && (
        <Link
          component="button"
          onClick={handleClickLogin}
          sx={{ alignSelf: "center" }}
        >
          <FormattedMessage defaultMessage="Already have an account? Log in" />
        </Link>
      )}
    </Stack>
  );
};
