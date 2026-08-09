export type PriceInfo = {
  sandboxId: string;
  devId: string;
  prodId: string;
};

export const SUBSCRIPTION_PRICE_KEYS = [] as const;

export type SubscriptionPriceKey = (typeof SUBSCRIPTION_PRICE_KEYS)[number];

export const ONE_TIME_PRICE_KEYS = ["pro_monthly", "pro_yearly"] as const;

export type OneTimePriceKey = (typeof ONE_TIME_PRICE_KEYS)[number];

/** Team (per-seat) subscription prices, used by tenant checkout. */
export const TEAM_PRICE_KEYS = ["team_monthly", "team_yearly"] as const;

export type TeamPriceKey = (typeof TEAM_PRICE_KEYS)[number];

export const PRICE_KEYS = [
  ...SUBSCRIPTION_PRICE_KEYS,
  ...ONE_TIME_PRICE_KEYS,
  ...TEAM_PRICE_KEYS,
] as const;

export type PriceKey = (typeof PRICE_KEYS)[number];

export const Prices: Record<PriceKey, PriceInfo> = {
  pro_monthly: {
    sandboxId: "price_1Smx96RRNItZsxS6WXTeWby3",
    devId: "",
    prodId: "price_1Son5zIp7DaYKUgMEMMuBNcy",
  },
  pro_yearly: {
    sandboxId: "price_1Smx9IRRNItZsxS6BG3XnnhL",
    devId: "",
    prodId: "price_1SmiviIp7DaYKUgMlbjqI23J",
  },
  team_monthly: {
    sandboxId: "price_1TUHWeRRNItZsxS6JLOIaLxc",
    devId: "",
    prodId: "price_1TUFS9Ip7DaYKUgMPORdfzQr",
  },
  team_yearly: {
    sandboxId: "price_1TUHWnRRNItZsxS6YS0MGEw8",
    devId: "",
    prodId: "price_1TUFTAIp7DaYKUgMYQbk4u6A",
  },
};

export const priceKeyById: Record<string, PriceKey> = Object.fromEntries(
  [
    ...Object.entries(Prices).flatMap(([key, value]) =>
      [value.sandboxId, value.devId, value.prodId]
        .filter((id) => id.length > 0)
        .map((id) => [id, key]),
    ),
  ],
) as Record<string, PriceKey>;

/** Reverse map containing only team-tier prices. */
export const teamPriceKeyById: Record<string, TeamPriceKey> =
  Object.fromEntries(
    TEAM_PRICE_KEYS.flatMap((key) =>
      [Prices[key].sandboxId, Prices[key].devId, Prices[key].prodId]
        .filter((id) => id.length > 0)
        .map((id) => [id, key]),
    ),
  ) as Record<string, TeamPriceKey>;
