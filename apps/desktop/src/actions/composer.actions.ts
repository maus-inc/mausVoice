import { getGenerateTextRepo } from "../repos";

export const applyVoiceEditInstruction = async (args: {
  text: string;
  instruction: string;
}): Promise<string> => {
  const { repo } = getGenerateTextRepo();
  if (!repo) {
    throw new Error("Configure a text-generation provider to use Edit Mode.");
  }

  const result = await repo.generateText({
    system:
      "You edit dictated text. Return only the edited text, with no explanation or surrounding quotes.",
    prompt: `Text to edit:\n${args.text}\n\nEditing instruction:\n${args.instruction}`,
  });
  return result.text.trim();
};
