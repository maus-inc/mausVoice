import { useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";

type Inputs = {
  agentRunning: boolean;
  messageCount: number;
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
  if (current.messageCount > previous.messageCount) {
    return messages.newMessage;
  }
  return null;
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
export const AgentLiveAnnouncer = ({ agentRunning, messageCount }: Inputs) => {
  const intl = useIntl();
  const [announcement, setAnnouncement] = useState("");
  const previous = useRef<Inputs>({ agentRunning, messageCount });

  useEffect(() => {
    const current = { agentRunning, messageCount };
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
    if (decided !== null) {
      setAnnouncement(decided);
    }
  }, [agentRunning, messageCount, intl]);

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
