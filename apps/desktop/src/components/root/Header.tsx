import {
  AccountCircleOutlined,
  RocketLaunchOutlined,
} from "@mui/icons-material";
import { Avatar, Box, Button, Stack, Typography } from "@mui/material";
import { getIdentifier } from "@tauri-apps/api/app";
import { useMemo, useState } from "react";
import { FormattedMessage } from "react-intl";
import { openUpgradePlanDialog } from "../../actions/pricing.actions";
import { useAsyncData } from "../../hooks/async.hooks";
import { useHeaderPortal } from "../../hooks/header.hooks";
import { useIsOnboarded } from "../../hooks/user.hooks";
import { produceAppState, useAppStore } from "../../store";
import {
  getEffectivePlan,
  getIsOnTrial,
  getIsPro,
  planToDisplayName,
} from "../../utils/member.utils";
import { getInitials } from "../../utils/string.utils";
import { getMyUser } from "../../utils/user.utils";
import { FreeWordsRemaining } from "../common/FreeWordsRemaining";
import {
  MenuPopoverBuilder,
  type MenuPopoverItem,
} from "../common/MenuPopover";
import { TrialCountdown } from "../common/TrialCountdown";
import { maybeArrayElements } from "../settings/AIPostProcessingConfiguration";
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
  return (
    <Stack
      direction="row"
      justifyContent="space-between"
      alignItems="center"
      sx={{
        py: 0.75,
        px: { xs: 1.5, sm: 2 },
        minHeight: 52,
        borderRadius: 2.5,
        mx: { xs: 0.5, sm: 1 },
        mb: 0.5,
        bgcolor: (theme) =>
          theme.palette.mode === "dark"
            ? "rgba(20,22,27,0.55)"
            : "rgba(255,255,255,0.72)",
        border: (theme) =>
          theme.palette.mode === "dark"
            ? "1px solid rgba(255,255,255,0.05)"
            : "1px solid rgba(15,18,25,0.05)",
        boxShadow: (theme) =>
          theme.palette.mode === "dark"
            ? "inset 0 1px 0 rgba(255,255,255,0.06), 0 8px 20px rgba(0,0,0,0.25)"
            : "inset 0 1px 0 rgba(255,255,255,0.9), inset 0 2px 0 rgba(255,255,255,0.35), 0 6px 16px rgba(15,18,25,0.06)",
        backdropFilter: "blur(12px)",
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
  const isPro = useAppStore(getIsPro);
  const isOnTrial = useAppStore(getIsOnTrial);
  const plan = useAppStore((state) => getEffectivePlan(state));
  const planName = useAppStore((state) => {
    const plan = getEffectivePlan(state);
    if (plan === "enterprise") {
      const orgName = state.enterpriseLicense?.org.trim();
      return orgName || planToDisplayName(plan);
    }

    // Only show the tenant name if the user is actually occupying one of the
    // tenant's paid seats. Members without a seat fall back to their personal
    // plan label.
    if (state.myTenant?.hasSeat) {
      const tenantName = state.myTenant.tenant.name.trim();
      if (tenantName) {
        return tenantName;
      }
    }

    return planToDisplayName(plan);
  });

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
    ...maybeArrayElements<MenuPopoverItem>(!isPro, [
      {
        kind: "listItem",
        title: <FormattedMessage defaultMessage="Upgrade to Pro" />,
        onClick: ({ close }) => {
          openUpgradePlanDialog();
          close();
        },
        leading: <RocketLaunchOutlined />,
      },
    ]),
  ];

  let rightContent: React.ReactNode;
  if (isOnboarded) {
    rightContent = (
      <Stack direction="row" alignItems="center" gap={1.5}>
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
        {plan === "free" && <FreeWordsRemaining />}
        {isOnTrial && <TrialCountdown />}
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
                  width: 32,
                  height: 32,
                  fontSize: 14,
                }}
              >
                {myInitials}
              </Avatar>
              <Stack textAlign="left" spacing={0.5}>
                <Typography variant="subtitle1" fontWeight={700} lineHeight={1}>
                  {myName}
                </Typography>
                <Typography
                  variant="caption"
                  color="textSecondary"
                  lineHeight={1}
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
    <Stack direction="row" alignItems="center" spacing={1.25} sx={{ minWidth: 0 }}>
      <SenderReceiverChip />
      {leftContent}
    </Stack>
  );

  return (
    <>
      <BaseHeader
        leftContent={left}
        rightContent={rightContent}
      />
      <GpuMigrationDialog
        open={gpuMigrationDialogOpen}
        onClose={() => setGpuMigrationDialogOpen(false)}
      />
    </>
  );
};
