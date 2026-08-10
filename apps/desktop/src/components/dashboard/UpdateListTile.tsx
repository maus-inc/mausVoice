import { ArrowUpwardOutlined } from "@mui/icons-material";
import { FormattedMessage } from "react-intl";
import { openUpdateDialog } from "../../actions/updater.actions";
import { ListTile } from "../common/ListTile";

export const UpdateListTile = () => {
  return (
    <ListTile
      onClick={() => openUpdateDialog()}
      leading={<ArrowUpwardOutlined />}
      title={<FormattedMessage defaultMessage="Update ready" />}
      sx={{
        position: "relative",
        borderRadius: 1,
        border:
          "1px solid color-mix(in srgb, var(--app-palette-blue) 30%, transparent)",
        overflow: "hidden",
        "&::before": {
          content: '""',
          position: "absolute",
          inset: 0,
          borderRadius: "inherit",
          padding: "1px",
          background:
            "linear-gradient(90deg, transparent, color-mix(in srgb, var(--app-palette-blue) 60%, transparent), transparent)",
          backgroundSize: "200% 100%",
          animation: "shimmer 3s ease-in-out infinite",
          willChange: "transform",
          mask: "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
          maskComposite: "exclude",
          WebkitMask:
            "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
          WebkitMaskComposite: "xor",
          pointerEvents: "none",
        },
        "@keyframes shimmer": {
          "0%": { backgroundPosition: "200% 0" },
          "100%": { backgroundPosition: "-200% 0" },
        },
      }}
    />
  );
};
