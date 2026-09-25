let enabled = false;

export const enable = async (): Promise<void> => {
  enabled = true;
};
export const disable = async (): Promise<void> => {
  enabled = false;
};
export const isEnabled = async (): Promise<boolean> => enabled;
