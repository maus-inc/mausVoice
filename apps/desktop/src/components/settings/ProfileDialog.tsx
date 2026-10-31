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
} from "@mui/material";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { setMyProfileImage, setUserName } from "../../actions/user.actions";
import { useMyProfileImage, useMyUser } from "../../hooks/user.hooks";
import { produceAppState, useAppStore } from "../../store";
import { readAvatarFile, type AvatarReadError } from "../../utils/avatar.utils";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { ProfilePhotoWell } from "./ProfilePhotoWell";

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
  const saveInFlight = useRef(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  // A pick is decoding, and there is nothing to save until it lands.
  const [preparing, setPreparing] = useState(false);
  const wasOpen = useRef(false);
  const discardAfterExit = useRef(false);
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
      setDiscardOpen(false);
      discardAfterExit.current = false;
      setPreparing(false);
    }
    wasOpen.current = open;
  }, [open, initialName, initialImage]);

  const close = useCallback(() => {
    produceAppState((draft) => {
      draft.settings.profileDialogOpen = false;
    });
    // The dialog is mounted for the life of the app, so a decode that lands
    // after this would write into a draft nobody is looking at and that the
    // next open would have to undo.
    pickTicket.current += 1;
    setPreparing(false);
    setDiscardOpen(false);
  }, []);

  const handlePick = useCallback(
    async (file: File | undefined) => {
      if (!file) {
        return;
      }
      const ticket = pickTicket.current + 1;
      pickTicket.current = ticket;
      setImageError(null);
      setPreparing(true);
      setImageStatus(
        intl.formatMessage({ defaultMessage: "Preparing photo..." }),
      );
      const result = await readAvatarFile(file);
      if (ticket !== pickTicket.current) {
        // A later pick, a removal, or a close already owns the draft, and the
        // one that owns it is the one that clears the wait.
        return;
      }
      setPreparing(false);
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
    // Removing is a decision about the photo the dialog will save, so it also
    // settles any pick still decoding: without this, a slow decode would put
    // the removed photo back a moment later.
    pickTicket.current += 1;
    setPreparing(false);
    setImage(null);
    setImageError(null);
    setImageStatus(
      intl.formatMessage({ defaultMessage: "Photo will be removed on save." }),
    );
  }, [intl]);

  const trimmed = useMemo(() => name.trim(), [name]);
  const canSave = useMemo(() => {
    // `preparing` is part of the gate rather than a cosmetic state: while a
    // decode is in flight, `image` still holds the previous photo, so a save
    // here would compare it to the stored one, find nothing to do, and drop the
    // photo that is a moment away from being ready.
    if (!user || saving || preparing || trimmed.length === 0) {
      return false;
    }
    return trimmed !== initialName.trim() || image !== initialImage;
  }, [user, saving, preparing, trimmed, initialName, image, initialImage]);

  const requestClose = () => {
    if (saveInFlight.current || saving || discardAfterExit.current) return;
    if (name !== initialName || image !== initialImage || preparing) {
      setDiscardOpen(true);
    } else {
      close();
    }
  };

  const handleSave = useCallback(async () => {
    if (!canSave || saveInFlight.current || discardAfterExit.current) {
      return;
    }
    saveInFlight.current = true;
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
    } finally {
      saveInFlight.current = false;
    }
  }, [canSave, trimmed, initialName, image, initialImage, close]);

  return (
    <>
      <Dialog
        open={open}
        // A save cannot be cancelled once it is being written. Other close
        // requests confirm before discarding a draft or an in-flight photo.
        onClose={saving ? undefined : requestClose}
        maxWidth="xs"
        fullWidth
      >
        {/* A form, not a stack of fields: with one text field in a dialog, Enter
          is the expected way to commit, and only a real form gives the browser
          that behaviour for free. */}
        <Box
          component="form"
          sx={{ display: "flex", flexDirection: "column", minHeight: 0 }}
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
          {/* No rule above the buttons and no local padding: the theme already
            sets this footer's spacing, MUI already spaces the two buttons, and
            every other dialog in the app ends on whitespace. A hairline here
            was the one footer that drew a line the rest of the app does not. */}
          <DialogActions>
            <Button onClick={requestClose} disabled={saving} color="inherit">
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
      <ConfirmDialog
        isOpen={open && discardOpen}
        title={<FormattedMessage defaultMessage="Discard changes?" />}
        content={
          <FormattedMessage defaultMessage="You have unsaved changes. Closing now loses them." />
        }
        onCancel={() => setDiscardOpen(false)}
        onConfirm={() => {
          // Let the confirmation restore focus to the editor before closing
          // the editor, so its own focus trap can restore the original opener.
          discardAfterExit.current = true;
          setDiscardOpen(false);
        }}
        onExited={() => {
          if (discardAfterExit.current) {
            discardAfterExit.current = false;
            close();
          }
        }}
        cancelButtonProps={{ autoFocus: true }}
        confirmLabel={<FormattedMessage defaultMessage="Discard" />}
        confirmButtonProps={{ color: "warning" }}
      />
    </>
  );
};
