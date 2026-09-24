import { useMemo, useState } from "react";
import { Stack } from "@mui/material";
import { useIntl } from "react-intl";
import { showErrorSnackbar, showSnackbar } from "../../actions/app.actions";
import {
  editAndResend,
  laterMessagesHaveToolActivity,
} from "../../actions/chat.actions";
import { getLogger } from "../../utils/log.utils";
import { useAppStore } from "../../store";
import {
  isEditableTarget,
  useContextMenu,
  type ContextMenuItem,
} from "../common/ContextMenu";
import { ToolResultPart, useMessageParts } from "./ChatMessageParts";
import {
  ChatMessageContent,
  MessageEditForm,
  shouldRenderMessage,
} from "./ChatMessageContent";

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
  const contextMenuItems = useMemo<ContextMenuItem[]>(() => {
    const items: ContextMenuItem[] = [];
    if (content.trim()) {
      items.push({
        label: intl.formatMessage({ defaultMessage: "Copy message" }),
        onClick: async () => {
          try {
            await navigator.clipboard.writeText(content);
            showSnackbar(
              intl.formatMessage({ defaultMessage: "Copied successfully" }),
              { mode: "success" },
            );
          } catch (error) {
            showErrorSnackbar(error);
          }
        },
      });
    }
    if (message?.role === "user") {
      items.push({
        label: intl.formatMessage({ defaultMessage: "Edit and resend" }),
        onClick: () => {
          setDraft(content);
          setConfirmDrop(false);
          setEditing(true);
        },
      });
    }
    return items;
  }, [content, intl, message?.role]);

  if (!message) {
    return null;
  }

  const onlyPart = parts.length === 1 ? parts[0] : undefined;
  if (onlyPart?.kind === "tool-result") {
    return <ToolResultPart part={onlyPart} />;
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
      {ctxMenu.renderMenu()}
    </Stack>
  );
};
