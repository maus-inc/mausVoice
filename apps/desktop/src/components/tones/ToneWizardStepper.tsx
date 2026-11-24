import { Step, StepButton, StepLabel, Stepper } from "@mui/material";
import { useIntl } from "react-intl";

type ToneWizardStepperProps = {
  step: number;
  maxReached: number;
  disabled: boolean;
  onGoTo: (step: number) => void;
};

export const ToneWizardStepper = ({
  step,
  maxReached,
  disabled,
  onGoTo,
}: ToneWizardStepperProps) => {
  const intl = useIntl();
  const labels = [
    intl.formatMessage({ defaultMessage: "Define" }),
    intl.formatMessage({ defaultMessage: "Tune" }),
    intl.formatMessage({ defaultMessage: "Test and review" }),
  ];

  return (
    <Stepper activeStep={step} sx={{ mb: 3 }}>
      {labels.map((label, index) => (
        <Step key={label} completed={index < step}>
          {index <= maxReached ? (
            <StepButton disabled={disabled} onClick={() => onGoTo(index)}>
              {label}
            </StepButton>
          ) : (
            <StepLabel>{label}</StepLabel>
          )}
        </Step>
      ))}
    </Stepper>
  );
};
