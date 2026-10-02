import { useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";

type Inputs = {
  agentRunning: boolean;
  /** Id of the newest message in the conversation, or null when empty. */
  latestMessageId: string | null;
  /** Author of the newest message. Only an assistant reply is announced. */
  latestMessageRole: string | null;
};

/**
 * Decide what to announce, from the previous inputs.
 *
 * `null` means stay silent. Returning one decision from one place is what keeps
 * the two transitions from overwriting each other: with two independent effects
 * writing the same state, whichever ran last won, so a message landing in the
 * same tick as the run starting spoke only the message.
 *
 * Precedence is finish over start over message, because the settled state is
 * the one a screen-reader user most needs to know.
 */
export const nextAnnouncement = (
  previous: Inputs,
  current: Inputs,
  messages: {
    replying: string;
    finished: string;
    newMessage: string;
  },
): string | null => {
  if (previous.agentRunning && !current.agentRunning) {
    return messages.finished;
  }
  if (!previous.agentRunning && current.agentRunning) {
    return messages.replying;
  }
  if (current.latestMessageId === previous.latestMessageId) {
    return null;
  }
  // The first id seen is history being loaded, not a reply arriving. Counting
  // messages instead of tracking ids announced every saved message as new the
  // moment a conversation opened.
  if (previous.latestMessageId === null) {
    return null;
  }
  // The user's own send is not news to them.
  if (current.latestMessageRole !== "assistant") {
    return null;
  }
  return messages.newMessage;
};

/**
 * Announces conversation events to assistive technology.
 *
 * A streaming reply arrives by mutating one message in place, so nothing in the
 * DOM announces it: a screen reader is told a run started and then nothing, with
 * no signal that a reply landed. This renders a polite live region that speaks
 * each meaningful transition exactly once.
 *
 * Deliberately not announced: token-level text growth. Streaming chunks would
 * queue dozens of utterances and make the region unusable, so only the run
 * start, the run finish, and a newly arrived message are spoken.
 */
export const AgentLiveAnnouncer = ({
  agentRunning,
  latestMessageId,
  latestMessageRole,
}: Inputs) => {
  const intl = useIntl();
  const [announcement, setAnnouncement] = useState("");
  const previous = useRef<Inputs>({
    agentRunning,
    latestMessageId,
    latestMessageRole,
  });
  // Two identical replies in a row must both be spoken. React skips a state
  // update whose value is unchanged, which would leave the live region's text
  // identical and the second arrival unheard, so a repeat is padded with an
  // invisible character the reader ignores but the DOM still distinguishes.
  const repeat = useRef(0);

  useEffect(() => {
    const current = { agentRunning, latestMessageId, latestMessageRole };
    const decided = nextAnnouncement(previous.current, current, {
      replying: intl.formatMessage({
        defaultMessage: "Assistant is replying.",
      }),
      finished: intl.formatMessage({
        defaultMessage: "Assistant finished replying.",
      }),
      newMessage: intl.formatMessage({
        defaultMessage: "New message received.",
      }),
    });
    previous.current = current;
    if (decided === null) {
      return;
    }
    if (decided === announcement) {
      repeat.current += 1;
      setAnnouncement(decided + "\u200A".repeat(repeat.current % 4 || 1));
      return;
    }
    repeat.current = 0;
    setAnnouncement(decided);
  }, [agentRunning, latestMessageId, latestMessageRole, announcement, intl]);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      style={{
        position: "absolute",
        width: 1,
        height: 1,
        margin: -1,
        padding: 0,
        overflow: "hidden",
        clip: "rect(0 0 0 0)",
        whiteSpace: "nowrap",
        border: 0,
      }}
    >
      {announcement}
    </div>
  );
};
