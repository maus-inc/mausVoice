import { useCallback, useMemo, useState } from "react";
import { Button, Stack, useMediaQuery } from "@mui/material";
import { useIntl } from "react-intl";
import { showErrorSnackbar, showSnackbar } from "../../actions/app.actions";
import {
  editAndResend,
  laterMessagesHaveToolActivity,
} from "../../actions/chat.actions";
import { getPendingPasteReview } from "../../actions/pending-paste-review.actions";
import { noHoverQuery } from "../../styles/motion";
import { getLogger } from "../../utils/log.utils";
import { useAppStore } from "../../store";
import {
  isEditableTarget,
  useContextMenu,
  type ContextMenuItem,
} from "../common/ContextMenu";
import { PendingPasteReviewBubble } from "./PendingPasteReviewBubble";
import { ToolResultPart, useMessageParts } from "./ChatMessageParts";
import {
  ChatMessageContent,
  MessageEditForm,
  shouldRenderMessage,
} from "./ChatMessageContent";

/**
 * Visible per-message actions.
 *
 * These used to live only in the right-click menu, which made them
 * undiscoverable and unreachable without a pointer. The context menu is kept
 * for the same actions, but this row is the primary affordance: it appears on
 * hover, on keyboard focus, and at rest under `noHoverQuery` so a touch device
 * is not left with an invisible control.
 */
const MessageActions = ({
  items,
}: {
  items: ReadonlyArray<{ key: string; label: string; run: () => void }>;
}) => {
  const noHover = useMediaQuery(noHoverQuery);
  const [visible, setVisible] = useState(false);
  return (
    <Stack
      direction="row"
      spacing={0.25}
      sx={{
        mt: 0.5,
        // Revealed rather than unmounted so keyboard focus can reach it, and so
        // a touch device sees it at rest. `visibility` keeps it out of the
        // pointer path while hidden but preserves it in the accessibility tree.
        visibility: visible || noHover ? "visible" : "hidden",
        opacity: visible || noHover ? 1 : 0,
        transition: "opacity 120ms ease",
      }}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onFocus={() => setVisible(true)}
      onBlur={() => setVisible(false)}
    >
      {items.map((item) => (
        <Button
          key={item.key}
          size="small"
          variant="text"
          sx={{ minWidth: 0, px: 0.75, py: 0.25, color: "text.secondary" }}
          onClick={item.run}
        >
          {item.label}
        </Button>
      ))}
    </Stack>
  );
};

type ChatMessageBubbleProps = { id: string };

export const ChatMessageBubble = ({ id }: ChatMessageBubbleProps) => {
  const intl = useIntl();
  const ctxMenu = useContextMenu();
  const { message, parts, permissions, canRetry } = useMessageParts(id);
  const isStreaming = useAppStore((s) => Boolean(s.streamingMessageById[id]));
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [confirmDrop, setConfirmDrop] = useState(false);

  const content = message?.content ?? "";
  const copyAction = useMemo(() => {
    if (!content.trim()) return null;
    return async () => {
      try {
        await navigator.clipboard.writeText(content);
        showSnackbar(
          intl.formatMessage({ defaultMessage: "Copied successfully" }),
          { mode: "success" },
        );
      } catch (error) {
        showErrorSnackbar(error);
      }
    };
  }, [content, intl]);

  const startEdit = useCallback(() => {
    setDraft(content);
    setConfirmDrop(false);
    setEditing(true);
  }, [content]);

  const actions = useMemo(
    () =>
      [
        copyAction
          ? {
              key: "copy",
              label: intl.formatMessage({ defaultMessage: "Copy message" }),
              run: copyAction,
            }
          : null,
        message?.role === "user"
          ? {
              key: "edit",
              label: intl.formatMessage({ defaultMessage: "Edit and resend" }),
              run: startEdit,
            }
          : null,
      ].filter((item): item is NonNullable<typeof item> => item !== null),
    [copyAction, intl, message?.role, startEdit],
  );

  // Both affordances read from one list, so they cannot drift apart.
  const contextMenuItems = useMemo<ContextMenuItem[]>(
    () =>
      actions.map((action) => ({
        label: action.label,
        onClick: () => void action.run(),
      })),
    [actions],
  );

  if (!message) {
    return null;
  }

  const onlyPart = parts.length === 1 ? parts[0] : undefined;
  if (onlyPart?.kind === "tool-result") {
    return <ToolResultPart part={onlyPart} />;
  }

  // The saved Paste review owns its whole row: it is stored as an empty system
  // message, so both the empty-message guards below and the generic content
  // renderer would leave it invisible. Routed ahead of both, and before the
  // context menu, which offers nothing meaningful for a message the user cannot
  // edit and whose content is empty.
  const pendingPasteReview = getPendingPasteReview(message.metadata);
  if (pendingPasteReview) {
    return <PendingPasteReviewBubble message={message} />;
  }

  if (!shouldRenderMessage(message, parts, isStreaming, canRetry)) return null;

  const saveEdit = () => {
    const text = draft.trim();
    if (!text) return;
    if (
      !confirmDrop &&
      laterMessagesHaveToolActivity(message.conversationId, id)
    ) {
      setConfirmDrop(true);
      return;
    }
    setEditing(false);
    setConfirmDrop(false);
    void editAndResend(message.conversationId, id, text).catch((error) => {
      // The edit already left the UI; surface the failure instead of a silent
      // rejection, and reopen the editor so the text is not lost.
      getLogger().error("Failed to edit and resend message");
      showErrorSnackbar(error);
      setDraft(text);
      setEditing(true);
    });
  };

  return (
    <Stack
      onContextMenu={(e) => {
        // Yield right-clicks on editable text to the provider's clipboard menu.
        if (isEditableTarget(e.target)) return;
        if (contextMenuItems.length === 0) return;
        ctxMenu.handleContextMenu(e.nativeEvent, contextMenuItems);
      }}
    >
      <ChatMessageContent
        parts={parts}
        permissions={permissions}
        isStreaming={isStreaming}
        isMe={message.role === "user"}
        canRetry={canRetry}
        conversationId={message.conversationId}
        editor={
          editing ? (
            <MessageEditForm
              draft={draft}
              confirmDrop={confirmDrop}
              onChange={(value) => {
                setDraft(value);
                setConfirmDrop(false);
              }}
              onCancel={() => {
                setEditing(false);
                setConfirmDrop(false);
              }}
              onSave={saveEdit}
            />
          ) : null
        }
      />
      {editing ? null : actions.length > 0 ? (
        <MessageActions items={actions} />
      ) : null}
      {ctxMenu.renderMenu()}
    </Stack>
  );
};
