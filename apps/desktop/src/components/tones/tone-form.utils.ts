import type { Tone } from "@maus-inc/types";
import { defineMessage } from "react-intl";

export const PREVIEW_SAMPLE_MESSAGE = defineMessage({
  id: "i_just_got_back_from_the_store_and_uh_we_need_milk_eggs_and",
  defaultMessage:
    "i just got back from the store and uh we need milk eggs and bread also can you remind me to call mom tomorrow",
});

export const MAX_NAME_LEN = 120;
export const MAX_CATEGORY_LEN = 80;
export const MAX_OUTPUT_LEN = 120;
export const MAX_EXAMPLE_LEN = 1200;
export const MAX_PROMPT_LEN = 8000;

export const countLabel = (value: string, max: number) =>
  `${value.length}/${max}`;

const DRAFT_FIELDS = [
  "name",
  "promptTemplate",
  "category",
  "outputLength",
  "exampleInputOutput",
] as const;
type ToneDraft = Pick<Tone, (typeof DRAFT_FIELDS)[number]>;

// Optional empty fields have identical editable meaning. Other metadata is
// preserved from the live record when saving, not copied from an old draft.
export const sameToneDraft = (left: ToneDraft, right: ToneDraft): boolean =>
  DRAFT_FIELDS.every((field) => (left[field] ?? "") === (right[field] ?? ""));
