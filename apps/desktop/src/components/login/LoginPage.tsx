import { Button, Card, Stack } from "@mui/material";
import { ArrowLeft } from "lucide-react";
import { FormattedMessage } from "react-intl";
import { Link } from "react-router-dom";
import { hairline } from "../../styles/shadows";
import { LoginForm } from "./LoginForm";

export default function LoginPage() {
  return (
    <Stack sx={{ p: 2, minHeight: "100%", pb: { xs: 4, md: 8 } }}>
      <Stack
        spacing={2}
        sx={{
          alignItems: "center",
          m: "auto",
          width: "100%",
          maxWidth: 520,
        }}
      >
        <Card
          sx={{
            p: { xs: 2, sm: 4 },
            boxShadow: "none",
            border: (theme) =>
              theme.palette.mode === "dark"
                ? hairline.dark()
                : hairline.light(),
            width: "100%",
            overflow: "hidden",
            borderRadius: 2.5,
          }}
        >
          <LoginForm />
        </Card>
        <Button
          component={Link}
          to="/"
          startIcon={<ArrowLeft size={16} strokeWidth={2} />}
        >
          <FormattedMessage defaultMessage="Go back" />
        </Button>
      </Stack>
    </Stack>
  );
}
