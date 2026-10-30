import { getIntl } from "../i18n";
import { getPostProcessMaxTokens } from "../utils/prompt.utils";
import { getGenerateTextRepo } from "../repos";

export const applyVoiceEditInstruction = async (args: {
  text: string;
  instruction: string;
}): Promise<string> => {
  const { repo } = getGenerateTextRepo();
  if (!repo) {
    // The composer copies `error.message` straight into `editError` and renders
    // it, so the sentence has to come from the intl layer rather than being
    // written out here.
    throw new Error(
      getIntl().formatMessage({
        defaultMessage:
          "Configure a text-generation provider to use Edit Mode.",
      }),
    );
  }

  const result = await repo.generateText({
    system:
      "You edit dictated text. Return only the edited text, with no explanation or surrounding quotes.",
    prompt: `Text to edit:\n${args.text}\n\nEditing instruction:\n${args.instruction}`,
    // Without an explicit budget the provider default decides how much of a
    // long transcript comes back, and a cut-off rewrite was inserted as
    // truncated text. The editor rewrites whole passages, so it needs the same
    // transcript-sized budget the post-processing calls use.
    maxTokens: getPostProcessMaxTokens(args.text),
  });
  return result.text.trim();
};
