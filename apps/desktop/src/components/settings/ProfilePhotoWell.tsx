import { CameraAltOutlined, DeleteOutlineOutlined } from "@mui/icons-material";
import { Alert, Box, Button, Stack, Typography } from "@mui/material";
import { useRef } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import {
  AVATAR_FILE_ACCEPT,
  type AvatarReadError,
} from "../../utils/avatar.utils";
import { UserAvatar } from "../common/UserAvatar";

const AVATAR_PREVIEW_SIZE = 96;

/**
 * One sentence per way an image can be refused.
 *
 * The editor answers the file it was handed rather than the person's mistake,
 * so "that one is too big" names the limit instead of leaving someone to guess
 * what went wrong.
 */
const AVATAR_ERROR_COPY: Record<AvatarReadError, React.ReactNode> = {
  "unsupported-type": (
    <FormattedMessage defaultMessage="Choose a PNG, JPG, or WebP image." />
  ),
  "too-large": (
    <FormattedMessage defaultMessage="That image is larger than 5 MB. Choose a smaller one." />
  ),
  // The file itself is small; its dimensions are not. Saying "larger than
  // 5 MB" would send someone looking for a byte count that is already fine.
  "too-many-pixels": (
    <FormattedMessage defaultMessage="That image is too big to open. Choose a smaller one." />
  ),
  unreadable: (
    <FormattedMessage defaultMessage="That image could not be read. Try another file." />
  ),
};

/**
 * The camera that fades in over the photo while it is hovered or focused.
 *
 * Decorative: the button under it already carries the label, so this only makes
 * the circle look editable.
 */
const AvatarHoverScrim = () => (
  <Box
    aria-hidden
    className="avatar-edit-scrim"
    sx={{
      position: "absolute",
      inset: 0,
      borderRadius: "50%",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      color: "common.white",
      bgcolor: "rgba(0, 0, 0, 0.45)",
      opacity: 0,
      transition: "opacity 150ms ease",
    }}
  >
    <CameraAltOutlined fontSize="small" />
  </Box>
);

/**
 * The small camera badge pinned to the corner of the photo.
 *
 * It is the affordance that reads at rest, when the scrim is invisible, and it
 * is what makes the circle look like a file picker rather than a picture.
 */
const AvatarCameraBadge = () => (
  <Box
    aria-hidden
    sx={{
      position: "absolute",
      right: 0,
      bottom: 0,
      width: 28,
      height: 28,
      borderRadius: "50%",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      bgcolor: "primary.main",
      color: "primary.contrastText",
      border: 2,
      // Matches the well it sits on, not the dialog behind it, so the badge
      // reads as attached to the photo.
      borderColor: "level2",
    }}
  >
    <CameraAltOutlined sx={{ fontSize: 15 }} />
  </Box>
);

type ProfilePhotoWellProps = {
  /** The photo being edited: the saved one, or the one just picked. */
  image: string | null;
  /** The saved name, which is what the circle falls back to when there is no photo. */
  name: string;
  /** The line under the photo: the format note until there is news to report. */
  status: string;
  error: AvatarReadError | null;
  saving: boolean;
  onFile: (file: File | undefined) => void;
  onRemove: () => void;
};

/**
 * The photo input: a large circle, one line of status, and the two verbs.
 *
 * The well is set apart from the field below it because the two are different
 * kinds of input, and the preview is the stored image rather than the file that
 * was picked, so the circle someone approves is the circle they get everywhere
 * else. A native file input cannot be styled or labelled usefully, so it is
 * hidden behind the circle and the button beside it.
 */
export const ProfilePhotoWell = ({
  image,
  name,
  status,
  error,
  saving,
  onFile,
  onRemove,
}: ProfilePhotoWellProps) => {
  const intl = useIntl();
  const fileInput = useRef<HTMLInputElement | null>(null);
  const pickFile = () => fileInput.current?.click();

  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 0.5,
        px: 2,
        py: 2.5,
        // One step of the theme radius: the same 14px the app's cards use,
        // rather than a pixel literal.
        borderRadius: 1,
        bgcolor: "level2",
      }}
    >
      <Box sx={{ position: "relative", mb: 1 }}>
        <Box
          component="button"
          type="button"
          onClick={pickFile}
          disabled={saving}
          aria-label={intl.formatMessage({
            defaultMessage: "Change profile photo",
          })}
          sx={{
            display: "block",
            p: 0,
            border: 0,
            borderRadius: "50%",
            background: "none",
            cursor: saving ? "not-allowed" : "pointer",
            opacity: saving ? 0.6 : 1,
            "&:hover .avatar-edit-scrim, &:focus-visible .avatar-edit-scrim": {
              opacity: 1,
            },
            "&:focus-visible": {
              outline: "2px solid",
              outlineColor: "primary.main",
              outlineOffset: 2,
            },
          }}
        >
          <UserAvatar name={name} src={image} size={AVATAR_PREVIEW_SIZE} />
          <AvatarHoverScrim />
        </Box>
        <AvatarCameraBadge />
      </Box>
      {/* One line, always present, so the picker's outcome is announced without
          reserving an empty row: it carries the format note until there is a
          status to report instead. It sits directly under the photo it
          describes, ahead of the buttons. */}
      <Typography
        role="status"
        aria-live="polite"
        variant="caption"
        sx={{
          color: "text.secondary",
          textAlign: "center",
          minHeight: "1.25em",
        }}
      >
        {status || (
          <FormattedMessage defaultMessage="PNG, JPG, or WebP, up to 5 MB. Cropped to a square." />
        )}
      </Typography>
      {/* Both verbs are spelled out rather than left to the circle, and they
          share a line so the removal appearing after a pick cannot shove the
          dialog around. */}
      <Stack direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
        <Button
          size="small"
          color="inherit"
          startIcon={<CameraAltOutlined sx={{ fontSize: 18 }} />}
          onClick={pickFile}
          disabled={saving}
        >
          <FormattedMessage defaultMessage="Change photo" />
        </Button>
        {image && (
          <Button
            size="small"
            color="inherit"
            startIcon={<DeleteOutlineOutlined sx={{ fontSize: 18 }} />}
            onClick={onRemove}
            disabled={saving}
          >
            <FormattedMessage defaultMessage="Remove photo" />
          </Button>
        )}
      </Stack>
      <input
        ref={fileInput}
        type="file"
        accept={AVATAR_FILE_ACCEPT}
        hidden
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          onFile(event.target.files?.[0]);
          // Clearing lets the same file be chosen twice in a row, which is
          // otherwise a no-op because no change event fires.
          event.target.value = "";
        }}
      />
      {error && (
        <Alert
          severity="error"
          variant="outlined"
          sx={{
            mt: 1,
            py: 0,
            alignItems: "center",
            "& .MuiAlert-message": { py: 1 },
          }}
        >
          {AVATAR_ERROR_COPY[error]}
        </Alert>
      )}
    </Box>
  );
};
