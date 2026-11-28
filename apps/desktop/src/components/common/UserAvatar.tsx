import { Avatar, type SxProps, type Theme } from "@mui/material";
import { getInitials } from "../../utils/string.utils";

/**
 * The one avatar in the app: the person's photo when they have set one, their
 * initials otherwise.
 *
 * Two places draw the person's face (the title bar chip and the account row)
 * and both used to compute initials themselves, which is how they could
 * disagree. MUI's `Avatar` keeps the initials under the image and falls back to
 * them if the stored image fails to decode, so a replaced or corrupted photo
 * degrades to initials rather than to an empty circle.
 *
 * Two details keep it from reading as a stock component. A hairline ring draws
 * the edge on both schemes, which matters once a photo is in it: without one the
 * circle bleeds into the surface it sits on. And the initials state is tinted
 * with the accent rather than the default grey disc, so an account with no photo
 * looks deliberate instead of unset.
 */
export const UserAvatar = ({
  name,
  src,
  size = 24,
  sx,
}: {
  name: string;
  src?: string | null;
  /** Edge length in pixels, so callers size one thing rather than two. */
  size?: number;
  sx?: SxProps<Theme>;
}) => (
  <Avatar
    src={src ?? undefined}
    alt=""
    sx={[
      (theme) => ({
        width: size,
        height: size,
        fontSize: Math.round(size * 0.42),
        fontWeight: 600,
        letterSpacing: "0.01em",
        border: "1px solid",
        borderColor: "divider",
        ...(src
          ? {}
          : {
              bgcolor: `rgb(${theme.vars?.palette?.primary.mainChannel} / 0.14)`,
              color: "primary.main",
            }),
      }),
      ...(Array.isArray(sx) ? sx : [sx]),
    ]}
  >
    {getInitials(name)}
  </Avatar>
);
