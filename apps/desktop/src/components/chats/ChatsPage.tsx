import { ArrowLeft, Plus } from "lucide-react";
import {
  Box,
  Button,
  Chip,
  Divider,
  Stack,
  Typography,
  useMediaQuery,
} from "@mui/material";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useSearchParams } from "react-router-dom";
import {
  canReuseEmptyConversation,
  deleteConversation,
  loadChatMessages,
  requestNewConversation,
  resolveReusableEmptyConversation,
} from "../../actions/chat.actions";
import { showErrorSnackbar } from "../../actions/app.actions";
import { useAppStore } from "../../store";
import { createId } from "../../utils/id.utils";
import { getLogger } from "../../utils/log.utils";
import { ChatsSideEffects } from "./ChatsSideEffects";
import { ConversationLayout } from "./ConversationLayout";
import { ConversationListLayout } from "./ConversationListLayout";
import { prepareChatDeleteFocus } from "./chat-delete-focus";

const usePaneFocus = ({
  compact,
  selectedId,
  listVisible,
  closeList,
}: {
  compact: boolean;
  selectedId: string | null;
  listVisible: boolean;
  closeList: () => void;
}) => {
  const lastFocused = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const focused = document.activeElement;
    const restoreFocus =
      compact && selectedId && focused && listRef.current?.contains(focused);
    closeList();
    if (restoreFocus) {
      requestAnimationFrame(() => {
        if (
          document.activeElement === focused ||
          document.activeElement === document.body
        ) {
          backRef.current?.focus();
        }
      });
    }
  }, [selectedId]);

  useLayoutEffect(() => {
    const prior = lastFocused.current;
    // A focused pane can disappear at the breakpoint. Restore only if focus
    // actually belonged to that pane and has not moved elsewhere.
    if (
      prior &&
      (!prior.isConnected || prior.getClientRects().length === 0) &&
      (document.activeElement === document.body ||
        document.activeElement === prior)
    ) {
      const listTarget = listRef.current?.querySelector<HTMLElement>(
        '[aria-current="true"]',
      );
      const target = compact && !listVisible ? backRef.current : listTarget;
      target?.focus();
    }
  }, [compact]);

  const focusIfUnmoved = (
    previous: Element | null,
    target: () => HTMLElement | null,
  ) => {
    requestAnimationFrame(() => {
      if (
        document.activeElement === previous ||
        document.activeElement === document.body
      )
        target()?.focus();
    });
  };

  return { listRef, backRef, lastFocused, focusIfUnmoved };
};

type PendingNewChatTarget = {
  intent: number;
  selectionAtStart: string | null;
  keyboard: boolean;
  focused: Element | null;
};

const useChatNavigation = ({
  compact,
  selectedId,
  setSearchParams,
  closeList,
  pageRef,
  listRef,
  backRef,
  focusIfUnmoved,
  intl,
}: {
  compact: boolean;
  selectedId: string | null;
  setSearchParams: ReturnType<typeof useSearchParams>[1];
  closeList: () => void;
  pageRef: React.RefObject<HTMLDivElement | null>;
  listRef: React.RefObject<HTMLDivElement | null>;
  backRef: React.RefObject<HTMLButtonElement | null>;
  focusIfUnmoved: (
    previous: Element | null,
    target: () => HTMLElement | null,
  ) => void;
  intl: ReturnType<typeof useIntl>;
}) => {
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const navigationIntent = useRef(0);
  const latestNewChatTargetRef = useRef<PendingNewChatTarget | null>(null);
  const activeNewChatRunRef = useRef<Promise<void> | null>(null);

  const bumpNavigationIntent = () => {
    navigationIntent.current++;
    latestNewChatTargetRef.current = null;
  };

  const finishNewChatSelection = (
    target: Pick<PendingNewChatTarget, "keyboard" | "focused">,
    conversationId?: string,
  ) => {
    if (conversationId && selectedIdRef.current !== conversationId) {
      setSearchParams({ id: conversationId }, { replace: true });
    }
    closeList();
    if (target.keyboard) {
      focusIfUnmoved(target.focused, () => backRef.current);
    }
  };

  const handleSelect = (id: string) => {
    bumpNavigationIntent();
    const focused = document.activeElement;
    const keyboard =
      compact &&
      focused instanceof HTMLElement &&
      focused.matches(":focus-visible");
    setSearchParams({ id }, { replace: true });
    closeList();
    if (keyboard) focusIfUnmoved(focused, () => backRef.current);
  };

  const settleCreatedConversation = async (
    createdConversationId: string,
    targetAtRequest: PendingNewChatTarget,
    settledTarget: PendingNewChatTarget,
  ): Promise<void> => {
    let currentTarget = settledTarget;
    while (
      currentTarget.selectionAtStart !== targetAtRequest.selectionAtStart
    ) {
      const reusable = await resolveReusableEmptyConversation(
        currentTarget.selectionAtStart,
      );
      const latest = latestNewChatTargetRef.current;
      if (
        !pageRef.current ||
        !latest ||
        navigationIntent.current !== latest.intent
      ) {
        return;
      }
      if (latest.intent !== currentTarget.intent) {
        currentTarget = latest;
        continue;
      }
      if (
        selectedIdRef.current !== currentTarget.selectionAtStart &&
        selectedIdRef.current !== createdConversationId
      ) {
        return;
      }
      if (reusable) {
        finishNewChatSelection(currentTarget, reusable.id);
        return;
      }
      break;
    }
    finishNewChatSelection(currentTarget, createdConversationId);
  };

  const isTargetCurrent = (
    target: PendingNewChatTarget | null,
  ): target is PendingNewChatTarget =>
    Boolean(
      pageRef.current && target && navigationIntent.current === target.intent,
    );

  const isSelectionConsistent = (
    target: PendingNewChatTarget,
    resolvedId: string,
  ): boolean =>
    selectedIdRef.current === target.selectionAtStart ||
    selectedIdRef.current === resolvedId;

  const isTargetReadyForCreate = (target: PendingNewChatTarget): boolean =>
    Boolean(
      pageRef.current &&
      latestNewChatTargetRef.current?.intent === target.intent &&
      navigationIntent.current === target.intent,
    );

  const settleNewChatResult = async (
    result: Awaited<ReturnType<typeof requestNewConversation>>,
    target: PendingNewChatTarget,
  ): Promise<"continue" | "done"> => {
    const settledTarget = latestNewChatTargetRef.current;
    if (!isTargetCurrent(settledTarget)) return "done";
    if (!result) {
      return settledTarget.intent !== target.intent ? "continue" : "done";
    }
    if (!result.created && settledTarget.intent !== target.intent) {
      return "continue";
    }
    if (!isSelectionConsistent(settledTarget, result.conversation.id)) {
      return "done";
    }
    if (result.created) {
      await settleCreatedConversation(
        result.conversation.id,
        target,
        settledTarget,
      );
      return "done";
    }
    finishNewChatSelection(settledTarget, result.conversation.id);
    return "done";
  };

  const executeNewChatRun = async () => {
    try {
      while (isTargetCurrent(latestNewChatTargetRef.current)) {
        const target = latestNewChatTargetRef.current;
        const now = new Date().toISOString();
        const result = await requestNewConversation(
          target.selectionAtStart,
          {
            id: createId(),
            title: intl.formatMessage({ defaultMessage: "New conversation" }),
            createdAt: now,
            updatedAt: now,
          },
          {
            shouldCreate: () => isTargetReadyForCreate(target),
          },
        );
        const status = await settleNewChatResult(result, target);
        if (status === "done") return;
      }
    } catch (error) {
      showErrorSnackbar(error);
    } finally {
      latestNewChatTargetRef.current = null;
      activeNewChatRunRef.current = null;
    }
  };

  const handleNewChat = () => {
    const focused = document.activeElement;
    const keyboard =
      compact &&
      focused instanceof HTMLElement &&
      focused.matches(":focus-visible");
    const selectionAtStart = selectedIdRef.current;

    if (canReuseEmptyConversation(selectionAtStart)) {
      bumpNavigationIntent();
      finishNewChatSelection({ keyboard, focused });
      return Promise.resolve();
    }

    const intent = ++navigationIntent.current;
    latestNewChatTargetRef.current = {
      intent,
      selectionAtStart,
      keyboard,
      focused,
    };
    if (activeNewChatRunRef.current) {
      return activeNewChatRunRef.current;
    }

    const run = executeNewChatRun();
    activeNewChatRunRef.current = run;
    return run;
  };

  const handleDelete = async (id: string) => {
    const restoreFocus = prepareChatDeleteFocus(listRef.current, id);
    try {
      await deleteConversation(id);
      if (!pageRef.current) return;
      // The user may have selected another thread while storage was pending.
      if (selectedIdRef.current === id) setSearchParams({}, { replace: true });
      restoreFocus();
    } catch (error) {
      showErrorSnackbar(error);
    }
  };

  return {
    handleSelect,
    handleNewChat,
    handleDelete,
    bumpNavigationIntent,
  };
};

const ChatListPane = ({
  compact,
  listVisible,
  listRef,
  selectedId,
  onSelect,
  onNewChat,
  onDelete,
}: {
  compact: boolean;
  listVisible: boolean;
  listRef: React.RefObject<HTMLDivElement | null>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onDelete: (id: string) => void;
}) => (
  <Box
    ref={listRef}
    sx={{
      display: compact && !listVisible ? "none" : "flex",
      minWidth: 0,
      flexShrink: 0,
      width: compact ? "100%" : "auto",
    }}
  >
    <ConversationListLayout
      selectedId={selectedId}
      fullWidth={compact}
      onSelect={onSelect}
      onNewChat={onNewChat}
      onDelete={onDelete}
    />
  </Box>
);

const ChatDetailPane = ({
  compact,
  listVisible,
  selectedId,
  title,
  intl,
  backRef,
  onBack,
  onNewChat,
}: {
  compact: boolean;
  listVisible: boolean;
  selectedId: string | null;
  title: string | undefined;
  intl: ReturnType<typeof useIntl>;
  backRef: React.RefObject<HTMLButtonElement | null>;
  onBack: (options: { keyboard: boolean }) => void;
  onNewChat: () => void;
}) => (
  <Stack
    sx={{
      display: listVisible ? "none" : "flex",
      flexGrow: 1,
      minWidth: 0,
      minHeight: 0,
    }}
  >
    {compact && selectedId && (
      <Stack
        direction="row"
        sx={{ alignItems: "center", gap: 1, px: 1.5, pt: 1 }}
      >
        <Button
          ref={backRef}
          size="small"
          startIcon={<ArrowLeft size={16} />}
          onClick={(event) => onBack({ keyboard: event.detail === 0 })}
        >
          <FormattedMessage defaultMessage="Chats" />
        </Button>
        <Typography
          component="h1"
          variant="subtitle2"
          noWrap
          sx={{ minWidth: 0 }}
        >
          {title || intl.formatMessage({ defaultMessage: "New conversation" })}
        </Typography>
      </Stack>
    )}
    {selectedId ? (
      <ConversationLayout
        key={selectedId}
        conversationId={selectedId}
        compact={compact}
      />
    ) : (
      <Stack
        sx={{
          flexGrow: 1,
          minWidth: 0,
          alignItems: "center",
          justifyContent: "center",
          gap: 1.5,
          px: 3,
        }}
      >
        <Typography
          variant="h6"
          // The empty state's title is the only heading on this route and
          // the shell renders no `h1`, so `component` supplies the level
          // while `variant` keeps the display size.
          component="h1"
          sx={{
            fontFamily: "var(--font-display)",
            fontWeight: 500,
            textAlign: "center",
            textWrap: "balance",
          }}
        >
          <FormattedMessage defaultMessage="How can I help you today?" />
        </Typography>
        <Typography
          variant="body2"
          sx={{
            color: "text.secondary",
            textAlign: "center",
          }}
        >
          <FormattedMessage defaultMessage="Start a conversation to get things going" />
        </Typography>
        <Chip
          icon={<Plus size={16} strokeWidth={2} />}
          label={<FormattedMessage defaultMessage="Create new chat" />}
          variant="outlined"
          onClick={onNewChat}
          sx={{ mt: 1, borderRadius: 999 }}
        />
      </Stack>
    )}
  </Stack>
);

export default function ChatsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = searchParams.get("id");
  const conversationIds = useAppStore((s) => s.chat.conversationIds);
  const title = useAppStore((s) =>
    selectedId ? s.conversationById[selectedId]?.title : undefined,
  );
  const compact = useMediaQuery("(max-width: 839px)");
  const [showList, setShowList] = useState(false);
  const pageRef = useRef<HTMLDivElement>(null);
  const listVisible = compact && (showList || !selectedId);

  const { listRef, backRef, lastFocused, focusIfUnmoved } = usePaneFocus({
    compact,
    selectedId,
    listVisible,
    closeList: () => setShowList(false),
  });

  // URL sync only. Writing the param re-renders and hands the new id to the
  // effect below, so loading here as well would read every conversation twice
  // on each cold open.
  useEffect(() => {
    if (!selectedId && conversationIds.length > 0) {
      setSearchParams({ id: conversationIds[0] }, { replace: true });
    }
  }, [selectedId, conversationIds, setSearchParams]);

  // Every load funnels through here. Deep links, back/forward and chat
  // switches all arrive as a new `selectedId`, so the id alone is enough to
  // decide that a read is due.
  useEffect(() => {
    if (selectedId) {
      void loadChatMessages(selectedId).catch((error) => {
        getLogger().error("Failed to load chat messages", error);
      });
    }
  }, [selectedId]);

  const intl = useIntl();
  const { handleSelect, handleNewChat, handleDelete, bumpNavigationIntent } =
    useChatNavigation({
      compact,
      selectedId,
      setSearchParams,
      closeList: () => setShowList(false),
      pageRef,
      listRef,
      backRef,
      focusIfUnmoved,
      intl,
    });

  return (
    <Box
      ref={pageRef}
      onFocusCapture={(event) => {
        if (event.target instanceof HTMLElement)
          lastFocused.current = event.target;
      }}
      onBlurCapture={(event) => {
        if (
          !event.relatedTarget ||
          !(event.relatedTarget instanceof Node) ||
          !pageRef.current?.contains(event.relatedTarget)
        )
          lastFocused.current = null;
      }}
      sx={{ flexGrow: 1, height: "100%", pb: 2, pr: 2 }}
    >
      <ChatsSideEffects />
      <Box
        sx={{
          height: "100%",
          overflow: "hidden",
          bgcolor: "level1",
          display: "flex",
          flexDirection: "row",
          borderRadius: 2,
        }}
      >
        <ChatListPane
          compact={compact}
          listVisible={listVisible}
          listRef={listRef}
          selectedId={selectedId}
          onSelect={handleSelect}
          onNewChat={handleNewChat}
          onDelete={handleDelete}
        />
        {!compact && <Divider orientation="vertical" flexItem />}

        <ChatDetailPane
          compact={compact}
          listVisible={listVisible}
          selectedId={selectedId}
          title={title}
          intl={intl}
          backRef={backRef}
          onBack={({ keyboard }) => {
            bumpNavigationIntent();
            const focused = document.activeElement;
            setShowList(true);
            if (keyboard)
              focusIfUnmoved(
                focused,
                () =>
                  listRef.current?.querySelector<HTMLElement>(
                    '[aria-current="true"]',
                  ) ??
                  listRef.current?.querySelector<HTMLElement>("button") ??
                  null,
              );
          }}
          onNewChat={handleNewChat}
        />
      </Box>
    </Box>
  );
}
