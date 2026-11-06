import type { LlmMessage } from "@maus-inc/types";
import type { AgentEvent } from "../src/types";

type Context = Parameters<typeof renderAgentEvents>[1];

const describeIteration = (iteration: number) =>
  iteration === 0 ? "Thinking..." : "Thinking more...";
const describeResult = (isError: boolean) =>
  isError ? "  [Error]" : "  [Result]";

/** Render each event while retaining the agent's returned conversation history. */
function renderEvent(
  event: AgentEvent,
  { spinner, output, history }: Context,
): void {
  switch (event.type) {
    case "text-delta":
      spinner.stop();
      output.write(event.text);
      break;
    case "iteration-start":
      spinner.update(describeIteration(event.iteration));
      break;
    case "tool-call-start":
      spinner.stop();
      output.log(
        `\n  [${event.toolName}]`,
        JSON.stringify(event.args).substring(0, 120),
      );
      spinner.update(`Running ${event.toolName}...`);
      break;
    case "tool-call-result":
      spinner.stop();
      output.log(describeResult(event.isError), event.result.substring(0, 200));
      break;
    case "finish":
      spinner.stop();
      output.log();
      history.length = 0;
      history.push(...event.messages);
      break;
  }
}

/** A failed or interrupted stream must not leave a live spinner behind. */
export async function renderAgentEvents(
  events: AsyncIterable<AgentEvent>,
  context: {
    spinner: { update: (message: string) => void; stop: () => void };
    output: {
      write: (text: string) => void;
      log: (...values: unknown[]) => void;
    };
    history: LlmMessage[];
  },
): Promise<void> {
  try {
    for await (const event of events) renderEvent(event, context);
  } finally {
    context.spinner.stop();
  }
}
