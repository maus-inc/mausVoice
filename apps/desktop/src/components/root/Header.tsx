import { AccountCircleOutlined } from "@mui/icons-material";
import { getIdentifier } from "@tauri-apps/api/app";
import { Avatar, Box, Button, Stack, Typography } from "@mui/material";
import { useMemo, useState } from "react";
import { FormattedMessage } from "react-intl";
import { useAsyncData } from "../../hooks/async.hooks";
import { useHeaderPortal } from "../../hooks/header.hooks";
import { useIsOnboarded } from "../../hooks/user.hooks";
import { produceAppState, useAppStore } from "../../store";
import { getEffectivePlan, planToDisplayName } from "../../utils/member.utils";
import { getInitials } from "../../utils/string.utils";
import { getMyUser } from "../../utils/user.utils";
import {
  MenuPopoverBuilder,
  type MenuPopoverItem,
} from "../common/MenuPopover";
import { GpuMigrationDialog } from "./GpuMigrationDialog";
import { SenderReceiverChip } from "./SenderReceiverChip";

export type BaseHeaderProps = {
  logo?: React.ReactNode;
  leftContent?: React.ReactNode;
  rightContent?: React.ReactNode;
};

export const BaseHeader = ({
  logo,
  leftContent,
  rightContent,
}: BaseHeaderProps) => {
  const hasContent = logo || leftContent || rightContent;
  if (!hasContent) {
    return null;
  }

  return (
    <Stack
      direction="row"
      justifyContent="space-between"
      alignItems="center"
      sx={{
        py: 0.4,
        px: { xs: 1, sm: 1.5 },
        minHeight: 36,
        mx: { xs: 0.5, sm: 1 },
        mb: 0.4,
      }}
    >
      {logo ? <Box sx={{ py: 0.25, pr: 1 }}>{logo}</Box> : null}
      {leftContent}
      <Box sx={{ flexGrow: 1 }} />
      {rightContent}
    </Stack>
  );
};

export const AppHeader = () => {
  const { leftContent } = useHeaderPortal();
  const isOnboarded = useIsOnboarded();
  const planName = useAppStore((state) =>
    planToDisplayName(getEffectivePlan(state)),
  );

  const myName = useAppStore((state) => {
    const user = getMyUser(state);
    return user?.name ?? "Unknown";
  });

  const myInitials = useMemo(() => getInitials(myName), [myName]);
  const identifierData = useAsyncData(getIdentifier, []);
  const isGpuBuild =
    identifierData.state === "success" &&
    identifierData.data.split(".").includes("gpu");
  const [gpuMigrationDialogOpen, setGpuMigrationDialogOpen] = useState(false);

  const sharedRightMenuItems: MenuPopoverItem[] = [
    {
      kind: "listItem",
      title: <FormattedMessage defaultMessage="My profile" />,
      onClick: ({ close }) => {
        produceAppState((draft) => {
          draft.settings.profileDialogOpen = true;
        });
        close();
      },
      leading: <AccountCircleOutlined />,
    },
  ];

  let rightContent: React.ReactNode;
  if (isOnboarded) {
    rightContent = (
      <Stack direction="row" alignItems="center" gap={1}>
        {isGpuBuild && (
          <Button
            onClick={() => setGpuMigrationDialogOpen(true)}
            variant="contained"
            sx={{
              fontWeight: 600,
              fontSize: 13,
              px: 1.5,
              py: 0.75,
            }}
          >
            <FormattedMessage defaultMessage="GPU App Deprecation | Upgrade Now" />
          </Button>
        )}
        <MenuPopoverBuilder
          anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
          transformOrigin={{ vertical: "top", horizontal: "right" }}
          items={sharedRightMenuItems}
        >
          {({ ref, open }) => (
            <Button
              ref={ref}
              onClick={open}
              sx={{
                display: { xs: "none", sm: "flex" },
                flexShrink: 0,
                flexDirection: "row",
                alignItems: "center",
                gap: 1.5,
              }}
            >
              <Avatar
                sx={{
                  width: 24,
                  height: 24,
                  fontSize: 12,
                }}
              >
                {myInitials}
              </Avatar>
              <Stack textAlign="left" spacing={0.5}>
                <Typography
                  variant="subtitle1"
                  fontWeight={500}
                  sx={{
                    fontFamily: "var(--font-display)",
                    fontSize: "0.85rem",
                    letterSpacing: "0.01em",
                    lineHeight: 1,
                  }}
                >
                  {myName}
                </Typography>
                <Typography
                  variant="caption"
                  color="textSecondary"
                  sx={{ fontSize: "0.68rem", lineHeight: 1 }}
                >
                  {planName}
                </Typography>
              </Stack>
            </Button>
          )}
        </MenuPopoverBuilder>
      </Stack>
    );
  }

  const left = (
    <Stack
      direction="row"
      alignItems="center"
      spacing={1.25}
      sx={{ minWidth: 0 }}
    >
      <SenderReceiverChip />
      {leftContent}
    </Stack>
  );

  return (
    <>
      <BaseHeader leftContent={left} rightContent={rightContent} />
      <GpuMigrationDialog
        open={gpuMigrationDialogOpen}
        onClose={() => setGpuMigrationDialogOpen(false)}
      />
    </>
  );
};
