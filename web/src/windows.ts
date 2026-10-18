/** How long each signature stays valid, in seconds. */
export const WINDOWS = {
  /** The Contributor's one-signature Deposit. An unused one can be submitted until then. */
  deposit: 600,
  /** The Maintainer's proof of wallet control. The Keeper keeps no nonces, so it works until then. */
  bindingProof: 1800,
  /** The Maintainer's Forfeit. */
  verdict: 3600,
  /** The Maintainer's one-signature funding of their Bounty wallet. Their own wallet sends it at once. */
  bountyFund: 600,
  /** The Maintainer's signed Payout, which the Keeper or anyone relays. */
  payout: 3600,
} as const;
