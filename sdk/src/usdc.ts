import { parseAbi } from "viem";

/** Arc's USDC, the same ERC-20 address on mainnet and testnet. Arc pays gas in USDC too. */
export const ARC_USDC = "0x3600000000000000000000000000000000000000";

/** The ERC-20 USDC's decimals. Arc's native USDC balance, the gas token, has 18. */
export const USDC_DECIMALS = 6;

/** The parts of USDC the Bona Fide flows use. One-signature Deposits sign typed data instead: see depositAuthorization. */
export const usdcAbi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
]);
