export type ReviewOpenDecision = {
  action: "open";
  /** The edited text persisted before the app surfaces History. */
  text: string;
};

export type ReviewDecision =
  | { action: "insert"; text: string }
  | { action: "copy" | "cancel"; text: null }
  | ReviewOpenDecision;
