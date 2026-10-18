// The contracts' enums in order: a value's index is its code on-chain.

/** The escrow's Deposit Status. */
export const DEPOSIT_STATUSES = ["none", "active", "refunded", "forfeited"] as const;
export type DepositStatus = (typeof DEPOSIT_STATUSES)[number];

/** A Bounty wallet's Bounty Status. */
export const BOUNTY_STATUSES = ["none", "open", "paid", "cancelled"] as const;
export type BountyStatus = (typeof BOUNTY_STATUSES)[number];

/** A Bounty wallet's Method: who paid a Payout. */
export const PAYOUT_METHODS = ["keeper", "signature", "owner"] as const;
export type PayoutMethod = (typeof PAYOUT_METHODS)[number];
