import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createApp } from "../../src/app.ts";
import { createDecisionLog } from "../../src/decisions/log.ts";
import { createEscrowChain } from "../../src/escrow.ts";
import { createKeeperEscrow, type KeeperEscrow } from "../../src/keeper/escrow.ts";
import { createKeeper } from "../../src/keeper/keeper.ts";
import { createKeeperRoutes } from "../../src/keeper/routes.ts";
import type { Decision } from "../../src/ports.ts";
import { createWebhookHandler } from "../../src/webhook.ts";
import { startAnvil, type Anvil } from "./anvil.ts";
import { FakeGitHub } from "./fake-github.ts";
import { DEPOSIT_PAGE, SETUP_PAGE, SIGN_PAGE } from "./harness.ts";
import { REPO, SECRET, signed } from "./webhooks.ts";

export { SIGN_PAGE };
/** The address the harness's requests to the Keeper's endpoints come from. */
export const CLIENT_IP = "203.0.113.9";

// The Keeper against the real escrow on anvil; only GitHub is faked. Its key is generated for
// each run and never leaves the test process.

export async function startKeeperAnvil(): Promise<{ anvil: Anvil; keeperKey: `0x${string}` }> {
  const keeperKey = generatePrivateKey();
  const anvil = await startAnvil({ keeper: privateKeyToAccount(keeperKey).address });
  return { anvil, keeperKey };
}

interface HarnessOptions {
  /** The text of .github/bona-fide.yml. */
  config?: string;
  /** Wraps the escrow, such as to make something happen on-chain right before a Keeper transaction. */
  escrow?: (escrow: KeeperEscrow) => KeeperEscrow;
}

export function keeperHarness(anvil: Anvil, keeperKey: `0x${string}`, options: HarnessOptions = {}) {
  const { config = "", escrow: wrap = (escrow) => escrow } = options;
  const github = new FakeGitHub();
  github.addRepo(REPO);
  github.setFile(REPO, ".github/bona-fide.yml", config);
  // No chain object, as on the Node host: the chain id comes from the RPC.
  const client = createPublicClient({ transport: http(anvil.url) });
  const chain = createEscrowChain({ client, escrow: anvil.escrow, fromBlock: anvil.deployBlock });
  const escrow = wrap(createKeeperEscrow({ client, account: privateKeyToAccount(keeperKey), escrow: anvil.escrow }));
  /** Every decision appended to the log, private repos' included. */
  const logged: Decision[] = [];
  const log = createDecisionLog({ write: (decision) => logged.push(decision) });
  const keeper = createKeeper({ escrow, chain, github, signPageUrl: SIGN_PAGE, decisions: log });
  const app = createApp({
    github,
    chain,
    depositPageUrl: DEPOSIT_PAGE,
    setupPageUrl: SETUP_PAGE,
    afterVerdict: keeper.afterVerdict,
  });
  const handle = createWebhookHandler({ secret: SECRET, app, keeper });
  const deliver = (event: string, body: unknown) => handle(signed(event, body));
  const keeperRoutes = createKeeperRoutes(keeper);
  const routes = (request: Request, clientIp = CLIENT_IP) => keeperRoutes(request, clientIp);
  const post = (path: string, body: unknown) =>
    routes(new Request(`https://app.example${path}`, { method: "POST", body: JSON.stringify(body) }));
  return { github, chain, escrow, keeper, app, deliver, routes, post, log, logged };
}

/** The EIP-712 Forfeit a Maintainer signs, signed by one of anvil's unlocked accounts. */
export async function signForfeit(
  anvil: Anvil,
  signer: Address,
  message: { key: Hex; serial: bigint; sigDeadline: bigint },
): Promise<Hex> {
  return createWalletClient({ transport: http(anvil.url) }).signTypedData({
    account: signer,
    domain: {
      name: "BonaFide",
      version: "1",
      chainId: await anvil.client.getChainId(),
      verifyingContract: anvil.escrow,
    },
    types: {
      Forfeit: [
        { name: "key", type: "bytes32" },
        { name: "serial", type: "uint256" },
        { name: "sigDeadline", type: "uint256" },
      ],
    },
    primaryType: "Forfeit",
    message,
  });
}

export interface BindingMessage {
  repo: string;
  maintainer: Address;
  nonce: Hex;
  deadline: bigint;
}

/** A Maintainer's EIP-712 proof of wallet control, signed by one of anvil's unlocked accounts. */
export async function signBinding(
  anvil: Anvil,
  signer: Address,
  message: BindingMessage,
  domain: { chainId?: number; verifyingContract?: Address } = {},
): Promise<Hex> {
  return createWalletClient({ transport: http(anvil.url) }).signTypedData({
    account: signer,
    domain: {
      name: "BonaFide",
      version: "1",
      chainId: domain.chainId ?? (await anvil.client.getChainId()),
      verifyingContract: domain.verifyingContract ?? anvil.escrow,
    },
    types: {
      Binding: [
        { name: "repo", type: "string" },
        { name: "maintainer", type: "address" },
        { name: "nonce", type: "bytes32" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Binding",
    message,
  });
}
