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
 * Name and photo, in one dialog.
 *
 * The photo sits above the name because it is the thing people come here to
 * change and it needs the room: a large circle reads as the subject of the
 * dialog, and the camera badge on its corner is the affordance that says it is
 * editable. The preview is the stored image rather than the file that was
 * picked, so the circle someone approves is the circle they get everywhere
 * else, including the title bar behind the dialog.
 *
 * Edits are held until Save, so Cancel leaves both the name and the photo as
 * they were, and the file input is hidden behind the avatar button because a
 * native file input cannot be styled or labelled usefully.
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
  const fileInput = useRef<HTMLInputElement | null>(null);

  // Re-seed on every open: the dialog is mounted for the life of the app, so
  // without this a cancelled edit would come back the next time it is opened.
  useEffect(() => {
    if (!open) {
      return;
    }
    setName(initialName);
    setImage(initialImage);
    setImageError(null);
    setImageStatus("");
    setSaveFailed(false);
    setSaving(false);
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
      setImageError(null);
      const result = await readAvatarFile(file);
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
            {/* The photo gets its own well: it is a different kind of input
                from the field below it, and setting it apart stops the dialog
                reading as one centred column of loose pieces. */}
            <Box
              sx={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 0.5,
                px: 2,
                py: 2.5,
                // One step of the theme radius: the same 14px the app's cards
                // use, rather than a pixel literal.
                borderRadius: 1,
                bgcolor: "level2",
              }}
            >
              <Box sx={{ position: "relative", mb: 1 }}>
                <Box
                  component="button"
                  type="button"
                  onClick={() => fileInput.current?.click()}
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
                    "&:hover .avatar-edit-scrim, &:focus-visible .avatar-edit-scrim":
                      {
                        opacity: 1,
                      },
                    "&:focus-visible": {
                      outline: "2px solid",
                      outlineColor: "primary.main",
                      outlineOffset: 2,
                    },
                  }}
                >
                  <UserAvatar
                    name={initialName}
                    src={image}
                    size={AVATAR_PREVIEW_SIZE}
                  />
                  {/* Decorative: the button already carries the label, so the
                      overlay is only there to make the circle look editable. */}
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
                </Box>
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
                    // Matches the well it sits on, not the dialog behind it, so
                    // the badge reads as attached to the photo.
                    borderColor: "level2",
                  }}
                >
                  <CameraAltOutlined sx={{ fontSize: 15 }} />
                </Box>
              </Box>
              {/* One line, always present, so the picker's outcome is announced
                  without reserving an empty row: it carries the format note
                  until there is a status to report instead. It sits directly
                  under the photo it describes, ahead of the buttons. */}
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
                {imageStatus || (
                  <FormattedMessage defaultMessage="PNG, JPG, or WebP, up to 5 MB. Cropped to a square." />
                )}
              </Typography>
              {/* Both verbs are spelled out rather than left to the circle, and
                  they share a line so the removal appearing after a pick cannot
                  shove the dialog around. */}
              <Stack
                direction="row"
                spacing={0.5}
                sx={{ alignItems: "center" }}
              >
                <Button
                  size="small"
                  color="inherit"
                  startIcon={<CameraAltOutlined sx={{ fontSize: 18 }} />}
                  onClick={() => fileInput.current?.click()}
                  disabled={saving}
                >
                  <FormattedMessage defaultMessage="Change photo" />
                </Button>
                {image && (
                  <Button
                    size="small"
                    color="inherit"
                    startIcon={<DeleteOutlineOutlined sx={{ fontSize: 18 }} />}
                    onClick={handleRemove}
                    disabled={saving}
                  >
                    <FormattedMessage defaultMessage="Remove photo" />
                  </Button>
                )}
              </Stack>
            </Box>
            <input
              ref={fileInput}
              type="file"
              accept={AVATAR_FILE_ACCEPT}
              hidden
              tabIndex={-1}
              aria-hidden
              onChange={(event) => {
                void handlePick(event.target.files?.[0]);
                // Clearing lets the same file be chosen twice in a row, which is
                // otherwise a no-op because no change event fires.
                event.target.value = "";
              }}
            />
            {imageError && (
              <Alert
                severity="error"
                variant="outlined"
                sx={{
                  py: 0,
                  alignItems: "center",
                  "& .MuiAlert-message": { py: 1 },
                }}
              >
                {AVATAR_ERROR_COPY[imageError]}
              </Alert>
            )}
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
