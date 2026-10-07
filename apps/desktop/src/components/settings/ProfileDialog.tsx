import { CameraAltOutlined, DeleteOutlineOutlined } from "@mui/icons-material";
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { setMyProfileImage, setUserName } from "../../actions/user.actions";
import { useMyProfileImage, useMyUser } from "../../hooks/user.hooks";
import { produceAppState, useAppStore } from "../../store";
import {
  AVATAR_FILE_ACCEPT,
  readAvatarFile,
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
const ProfilePhotoWell = ({
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

/**
 * Name and photo, in one dialog.
 *
 * The photo sits above the name because it is the thing people come here to
 * change and it needs the room: a large circle reads as the subject of the
 * dialog, and the camera badge on its corner is the affordance that says it is
 * editable.
 *
 * Edits are held until Save, so Cancel leaves both the name and the photo as
 * they were.
 */
export const ProfileDialog = () => {
  const intl = useIntl();
  const open = useAppStore((state) => state.settings.profileDialogOpen);
  const user = useMyUser();
  const initialName = user?.name ?? "";
  const initialImage = useMyProfileImage();

  const [name, setName] = useState(initialName);
  const [image, setImage] = useState<string | null>(initialImage);
  const [imageError, setImageError] = useState<AvatarReadError | null>(null);
  const [imageStatus, setImageStatus] = useState("");
  const [saveFailed, setSaveFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const wasOpen = useRef(false);
  // Every pick gets a ticket, and a decode only lands if its ticket is still
  // the newest one. A large photo decodes after a smaller one picked a moment
  // later, and the slower file must not replace the newer choice.
  const pickTicket = useRef(0);

  // Re-seed when the dialog opens, and only then. It is mounted for the life of
  // the app, so without this a cancelled edit would come back the next time; and
  // seeding on every change of the saved name would throw the draft away
  // mid-save, because saving the name updates the store this reads.
  useEffect(() => {
    if (open && !wasOpen.current) {
      pickTicket.current += 1;
      setName(initialName);
      setImage(initialImage);
      setImageError(null);
      setImageStatus("");
      setSaveFailed(false);
      setSaving(false);
    }
    wasOpen.current = open;
  }, [open, initialName, initialImage]);

  const close = useCallback(() => {
    produceAppState((draft) => {
      draft.settings.profileDialogOpen = false;
    });
  }, []);

  const handlePick = useCallback(
    async (file: File | undefined) => {
      if (!file) {
        return;
      }
      const ticket = pickTicket.current + 1;
      pickTicket.current = ticket;
      setImageError(null);
      const result = await readAvatarFile(file);
      if (ticket !== pickTicket.current) {
        // A later pick, or a reopen, has already replaced this one.
        return;
      }
      if (result.ok) {
        setImage(result.dataUrl);
        setImageStatus(
          intl.formatMessage({
            defaultMessage: "New photo ready to save.",
          }),
        );
        return;
      }
      setImageError(result.error);
      setImageStatus("");
    },
    [intl],
  );

  const handleRemove = useCallback(() => {
    setImage(null);
    setImageError(null);
    setImageStatus(
      intl.formatMessage({ defaultMessage: "Photo will be removed on save." }),
    );
  }, [intl]);

  const trimmed = useMemo(() => name.trim(), [name]);
  const canSave = useMemo(() => {
    if (!user || saving || trimmed.length === 0) {
      return false;
    }
    return trimmed !== initialName.trim() || image !== initialImage;
  }, [user, saving, trimmed, initialName, image, initialImage]);

  const handleSave = useCallback(async () => {
    if (!canSave) {
      return;
    }
    setSaving(true);
    setSaveFailed(false);
    try {
      if (trimmed !== initialName.trim()) {
        await setUserName(trimmed);
      }
      if (image !== initialImage) {
        setMyProfileImage(image);
      }
      close();
    } catch {
      setSaveFailed(true);
      setSaving(false);
    }
  }, [canSave, trimmed, initialName, image, initialImage, close]);

  return (
    <Dialog open={open} onClose={close} maxWidth="xs" fullWidth>
      {/* A form, not a stack of fields: with one text field in a dialog, Enter
          is the expected way to commit, and only a real form gives the browser
          that behaviour for free. */}
      <Box
        component="form"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSave();
        }}
      >
        <DialogTitle sx={{ pb: 1 }}>
          <FormattedMessage defaultMessage="Edit profile" />
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            <ProfilePhotoWell
              image={image}
              name={initialName}
              status={imageStatus}
              error={imageError}
              saving={saving}
              onFile={(file) => void handlePick(file)}
              onRemove={handleRemove}
            />
            <TextField
              label={<FormattedMessage defaultMessage="Name" />}
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={!user || saving}
              size="small"
              fullWidth
              autoComplete="name"
              helperText={
                <FormattedMessage defaultMessage="Used when mausVoice writes on your behalf." />
              }
            />
            {saveFailed && (
              <Alert severity="error" variant="outlined">
                <FormattedMessage defaultMessage="Could not save your profile. Please try again." />
              </Alert>
            )}
          </Stack>
        </DialogContent>
        <DialogActions
          sx={{ px: 3, py: 2, borderTop: 1, borderColor: "divider", gap: 1 }}
        >
          <Button onClick={close} disabled={saving} color="inherit">
            <FormattedMessage defaultMessage="Cancel" />
          </Button>
          <Button
            type="submit"
            disabled={!canSave}
            variant="contained"
            aria-busy={saving || undefined}
          >
            {saving ? (
              <FormattedMessage defaultMessage="Saving..." />
            ) : (
              <FormattedMessage defaultMessage="Save" />
            )}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
};
