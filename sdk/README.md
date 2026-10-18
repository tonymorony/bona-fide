# @bona-fide/sdk

Typed building blocks for Bona Fide's contracts on [Arc](https://arc.io): the ABIs, the ids and keys
the contracts compute, every EIP-712 message they check a signature on, the same signature check
they run, and where they are deployed. It is what the Bona Fide App, its MCP server and its pages
use, built on [viem](https://viem.sh) and nothing else.

Use it to read a repo's terms and Deposits, to let a wallet or an agent sign a one-signature
Deposit, to check a Maintainer's signature before you relay it, or to build your own app on the
same escrow and Bounty wallets. Terms such as Binding, Deposit and Forfeit are defined in
[CONTEXT.md](https://github.com/tonymorony/bona-fide/blob/main/CONTEXT.md).

## Install

```shell
npm install @bona-fide/sdk viem
```

Inside this repository, `npm ci` at the root links it for the App, the agent and the pages, which
import its TypeScript source directly.

## What's in it

| Export | What it is |
|---|---|
| `escrowAbi`, `routerAbi`, `bountyFactoryAbi`, `bountyWalletAbi` | Each contract's whole ABI, generated from the Foundry artifacts, so viem infers every argument and result |
| `usdcAbi`, `ARC_USDC`, `USDC_DECIMALS` | The parts of Arc's USDC the flows use |
| `arcMainnet`, `arcTestnet`, `chainOf` | Each network's addresses, deploy blocks, RPC and explorer, and the network as a viem chain |
| `repoIdOf`, `keyOf`, `KINDS`, `kindCode`, `authorizationNonce` | The ids the contracts compute: a repo's id, a PR's or issue's Deposit key, and the nonce that ties a USDC authorization to one key |
| `depositAuthorization`, `forfeitVerdict`, `bindingProof`, `payoutSignature`, `bountyFundAuthorization` | Typed data for each signature, ready for viem's `signTypedData` or `hashTypedData` |
| `escrowDomain`, `usdcDomain`, `bountyDomain` and the `*_TYPES` | Their EIP-712 domains and types, for other signers |
| `isValidSignatureNow` | The contracts' own signature check: ECDSA for a plain wallet, ERC-1271 for a smart account |
| `DEPOSIT_STATUSES`, `BOUNTY_STATUSES`, `PAYOUT_METHODS` | The contracts' enums, in order |
| `relayDepositRoute`, `forfeitRoute`, `bindingProofRoute`, `bountyPayoutRoute`, `decisionsRoute`, `APP_PATHS` | The Bona Fide App's HTTP routes: each one's path, its request body encoded and decoded, and its answer |
| `refusalIn`, `REFUSAL_CODES` | Why the App refused a request, read by its `code` rather than its text |
| `depositRequestIn`, `depositRequestBlock`, `APP_SLUG` | The Deposit request for AI agents that the App hides in its check and comment, and the App whose check or comment it must come from |

## Read a PR's Deposit

```ts
import { createPublicClient, http } from "viem";
import { arcMainnet, chainOf, DEPOSIT_STATUSES, escrowAbi, keyOf, repoIdOf } from "@bona-fide/sdk";

const client = createPublicClient({ chain: chainOf(arcMainnet), transport: http() });

const deposit = await client.readContract({
  address: arcMainnet.escrow,
  abi: escrowAbi,
  functionName: "depositOf",
  args: [keyOf(repoIdOf("tonymorony/lottie-squeeze"), "pr", 1)],
});
console.log(DEPOSIT_STATUSES[deposit.status], deposit.amount, deposit.depositor);
```

`activeConfig(repoId)` gives the repo's Binding: the Maintainer, the amount, the forfeit share and
the Timeout. An all-zero answer means the repo has none.

## Sign a one-signature Deposit

The Contributor signs USDC's `ReceiveWithAuthorization` once. Anyone can then submit it with the
escrow's `depositWithAuthorization`, so the Contributor pays no gas. The nonce binds the signature
to one PR or issue: submitted for any other, it fails.

```ts
import { createWalletClient, custom, toHex } from "viem";
import "viem/window"; // types window.ethereum
import { arcMainnet, chainOf, depositAuthorization, escrowAbi, kindCode, repoIdOf } from "@bona-fide/sdk";

const wallet = createWalletClient({ chain: chainOf(arcMainnet), transport: custom(window.ethereum!) });
const [from] = await wallet.requestAddresses();

const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
const validBefore = BigInt(Math.floor(Date.now() / 1000) + 600);
const typedData = depositAuthorization({
  chainId: arcMainnet.chainId,
  usdc: arcMainnet.usdc,
  escrow: arcMainnet.escrow,
  repo: "owner/name",
  kind: "pr",
  number: 42,
  from: from!,
  value: 1_000_000n, // the repo's active amount: 1 USDC
  salt,
  validBefore,
});
const signature = await wallet.signTypedData({ account: from!, ...typedData });

// Any account can send this; the Bona Fide App's POST /relay/deposit does it for the pages.
await wallet.writeContract({
  account: from!,
  address: arcMainnet.escrow,
  abi: escrowAbi,
  functionName: "depositWithAuthorization",
  args: [repoIdOf("owner/name"), kindCode("pr"), 42n, from!, 0n, validBefore, salt, signature],
});
```

The value must equal the repo's active amount, and the Refund always goes back to `from`.

## Check a signature before you relay it

```ts
import { hashTypedData, type Hex, type PublicClient } from "viem";
import { arcMainnet, forfeitVerdict, isValidSignatureNow } from "@bona-fide/sdk";

// The Maintainer's verdict on the Deposit with this key and Serial, as the escrow's forfeit() checks it.
async function isMaintainersVerdict(
  client: PublicClient,
  verdict: { maintainer: Hex; key: Hex; serial: bigint; sigDeadline: bigint; signature: Hex },
) {
  const { maintainer, key, serial, sigDeadline, signature } = verdict;
  const typedData = forfeitVerdict({ chainId: arcMainnet.chainId, escrow: arcMainnet.escrow, key, serial, sigDeadline });
  return isValidSignatureNow(client, maintainer, hashTypedData(typedData), signature);
}
```

`true` means the escrow accepts the signature: the same rule, for plain wallets and smart accounts.

## Follow the escrow's events

```ts
import { getAbiItem } from "viem";

const deposits = await client.getLogs({
  address: arcMainnet.escrow,
  event: getAbiItem({ abi: escrowAbi, name: "Deposited" }),
  fromBlock: BigInt(arcMainnet.escrowFromBlock),
});
```

Arc's public RPC serves at most 10,000 blocks per `getLogs` call: page through longer ranges.

## The contracts

The escrow, the Charity router and the Bounty wallets are separate, immutable contracts with no
owner and no upgrade. [contracts/README.md](https://github.com/tonymorony/bona-fide/blob/main/contracts/README.md) says what each one guarantees and
how to use them from Solidity.

## Develop

```shell
npm test          # the ids, the ABIs, and each signature accepted by the real contracts on anvil
npm run abi       # rewrites src/abi.ts after a contract changes: run forge build in contracts/ first
npm run build     # the npm package, in dist/; publish it with: npm publish ./dist
```

The tests need [Foundry](https://getfoundry.sh) and the contracts' submodules
(`git submodule update --init --recursive`).
