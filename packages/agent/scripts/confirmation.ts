import type { Interface } from "node:readline";

/** A shell command runs only after an unambiguous affirmative response. */
export const isExplicitConfirmation = (answer: string): boolean => {
  const normalized = answer.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
};

/** Treat closed stdin as denial; never leave a command awaiting an answer forever. */
export const askForConfirmation = (
  rl: Interface,
  message: string,
): Promise<boolean> =>
  new Promise((resolve) => {
    const onClose = () => resolve(false);
    rl.once("close", onClose);
    try {
      rl.question(`  ${message} [y/n] `, (answer) => {
        rl.off("close", onClose);
        resolve(isExplicitConfirmation(answer));
      });
    } catch {
      rl.off("close", onClose);
      resolve(false);
    }
  });
