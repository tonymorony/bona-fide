import { BOUNTY_STATUSES, DEPOSIT_STATUSES, KINDS, REPO_NAME } from "@bona-fide/sdk";
import { McpServer } from "@modelcontextprotocol/server";
import type { Address } from "viem";
import * as z from "zod/v4";
import { createBounties, type BountiesOptions } from "./bounties.ts";
import {
  describeBounty,
  describeDepositState,
  describeMadeDeposit,
  describeRefundPlan,
  describeRules,
  describeSignedPlan,
  describeTwoStepPlan,
  withDetails,
} from "./copy.ts";
import { createDeposits, type DepositsOptions, type SignedDepositFields } from "./deposits.ts";

export type ServerOptions = DepositsOptions & BountiesOptions;

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

const target = {
  repo: z.string().regex(REPO_NAME).describe("The GitHub repo, as owner/name."),
  kind: z.enum(KINDS).describe('"pr" for a pull request, "issue" for an issue.'),
  number: z.number().int().positive().describe("The PR or issue number."),
};

const terms = {
  amount: z.string().describe("USDC base units (6 decimals)."),
  amountUsdc: z.string(),
  forfeitPercent: z.number(),
  timeoutDays: z.number(),
};

const rulesOutput = z.object({
  ...target,
  key: hex32,
  repoId: hex32,
  chainId: z.number(),
  escrow: address,
  usdc: address,
  binding: z.object({ ...terms, maintainer: address }).nullable(),
  pendingBinding: z.object({ ...terms, effectiveAt: z.string() }).nullable(),
  activeDeposit: z
    .object({ depositor: address, amount: z.string(), amountUsdc: z.string(), deadline: z.string() })
    .nullable(),
  limitUsdc: z.string(),
  withinLimit: z.boolean().nullable(),
});

const from = address.describe("The wallet that pays the Deposit and gets every Refund: your own.");

// The relay's body, which the App reads with the sdk's relayDepositRoute.
const signedFields = {
  ...target,
  from,
  value: z.string().regex(/^\d+$/).describe("The Deposit in USDC base units (6 decimals)."),
  validAfter: z.string().regex(/^\d+$/),
  validBefore: z.string().regex(/^\d+$/),
  salt: hex32,
} satisfies Record<keyof SignedDepositFields, z.ZodType>;

const signedPlanOutput = z.object({
  typedData: z.object({
    types: z.record(z.string(), z.array(z.object({ name: z.string(), type: z.string() }))),
    primaryType: z.literal("ReceiveWithAuthorization"),
    domain: z.object({ name: z.string(), version: z.string(), chainId: z.number(), verifyingContract: address }),
    message: z.object({
      from: address,
      to: address,
      value: z.string(),
      validAfter: z.string(),
      validBefore: z.string(),
      nonce: hex32,
    }),
  }),
  circleCommand: z.string().nullable(),
  submit: z.object(signedFields),
  amountUsdc: z.string(),
  expiresAt: z.string(),
});

const step = z.object({
  description: z.string(),
  to: address,
  data: z.string().regex(/^0x[0-9a-fA-F]*$/),
  circleCommand: z.string().nullable(),
});

const twoStepOutput = z.object({ from: address, steps: z.tuple([step, step]) });

const madeOutput = z.object({
  ...target,
  txHash: hex32,
  depositor: address,
  amount: z.string(),
  amountUsdc: z.string(),
  deadline: z.string(),
});

const usdcAmount = z.string().describe("USDC base units (6 decimals).");

const statusOutput = z.object({
  ...target,
  key: hex32,
  escrow: address,
  status: z.enum(DEPOSIT_STATUSES),
  deposit: z
    .object({
      depositor: address.describe("Who paid the Deposit, and the only address a Refund can reach."),
      amount: usdcAmount,
      amountUsdc: z.string(),
      serial: z.string(),
      deadline: z.string().describe("When the Timeout ends. From then on, anyone can Refund an active Deposit."),
      timeoutPassed: z.boolean(),
      secondsLeft: z.number().describe("Seconds until the Timeout ends, or 0 once it has."),
      forfeitPercent: z.number(),
      outcome: z
        .object({ refunded: usdcAmount, refundedUsdc: z.string(), forfeited: usdcAmount, forfeitedUsdc: z.string() })
        .nullable()
        .describe("How a refunded or forfeited Deposit was split; null while it is active."),
    })
    .nullable(),
  checkedAt: z.string().describe("The chain's time when it was read."),
  explorerUrl: z.string().nullable(),
});

const refundOutput = z.object({
  from: address,
  depositor: address.describe("Where the Refund goes, whoever sends it."),
  amount: usdcAmount,
  amountUsdc: z.string(),
  step,
});

const bountyOutput = z.object({
  repo: z.string(),
  issue: z.number(),
  repoId: hex32,
  factory: address,
  maintainer: address.nullable().describe("The active Binding's Maintainer, whose Bounty wallet is the repo's."),
  wallet: z
    .object({
      address,
      keeperEnabled: z.boolean(),
      perPayoutLimit: usdcAmount,
      perPayoutLimitUsdc: z.string(),
      keeperAllowance: usdcAmount.describe("What the Keeper could still pay in this period."),
      keeperAllowanceUsdc: z.string(),
    })
    .nullable(),
  bounty: z
    .object({
      status: z.enum(BOUNTY_STATUSES),
      amount: usdcAmount,
      amountUsdc: z.string(),
      serial: z.string(),
      payee: address.nullable().describe("Who was paid, once it is paid."),
      keeperMayPay: z.boolean().describe("Open, Keeper payouts on, and within the per-payout and period limits."),
      keeperLimit: z.enum(["off", "per-payout", "period"]).nullable(),
    })
    .nullable(),
  payee: z
    .object({
      address,
      line: z.string().describe("The line to write in your PR's description or your own comment on it."),
      problem: z.string().nullable().describe("Why the Bounty wallet would refuse to pay this address."),
    })
    .nullable(),
  explorerUrl: z.string().nullable(),
});

export function createServer(options: ServerOptions): McpServer {
  const deposits = createDeposits(options);
  const bounties = createBounties(options);
  const server = new McpServer({ name: "bona-fide", version: "0.1.0" });

  server.registerTool(
    "get_deposit_rules",
    {
      title: "Get a repo's Deposit rules",
      description:
        "Reads a repo's Bona Fide Binding on-chain: the refundable Deposit it asks for on a PR or issue, the Timeout and the forfeit share, and whether that item already has an active Deposit and who paid it.",
      inputSchema: z.object(target),
      outputSchema: rulesOutput,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      const rules = await deposits.rules(input);
      return { content: [{ type: "text", text: withDetails(describeRules(rules), rules) }], structuredContent: rules };
    },
  );

  server.registerTool(
    "prepare_signed_deposit",
    {
      title: "Prepare a one-signature Deposit",
      description:
        "Prepares the USDC authorization (EIP-3009 ReceiveWithAuthorization, as EIP-712 typed data) that pays a PR's or issue's Deposit from your wallet, and the Circle agent wallet command that signs it. Sign it with your own wallet, then call submit_signed_deposit. This tool never signs or sends anything, and it refuses Deposits above MAX_DEPOSIT_USDC.",
      inputSchema: z.object({ ...target, from }),
      outputSchema: signedPlanOutput,
      annotations: { readOnlyHint: true },
    },
    async ({ from: payer, ...item }) => {
      const plan = await deposits.prepareSigned(item, payer as Address);
      return {
        content: [{ type: "text", text: withDetails(describeSignedPlan(plan), plan) }],
        structuredContent: plan,
      };
    },
  );

  server.registerTool(
    "prepare_two_step_deposit",
    {
      title: "Prepare a Deposit as two transactions",
      description:
        "Prepares a PR's or issue's Deposit as two transactions to send from your own wallet: an approve of exactly the Deposit, then the deposit. Returns each as calldata and as a Circle agent wallet command. This tool never signs or sends anything, and it refuses Deposits above MAX_DEPOSIT_USDC.",
      inputSchema: z.object({ ...target, from }),
      outputSchema: twoStepOutput,
      annotations: { readOnlyHint: true },
    },
    async ({ from: payer, ...item }) => {
      const plan = await deposits.prepareTwoStep(item, payer as Address);
      return {
        content: [{ type: "text", text: withDetails(describeTwoStepPlan(plan), plan) }],
        structuredContent: plan,
      };
    },
  );

  server.registerTool(
    "submit_signed_deposit",
    {
      title: "Submit a signed Deposit",
      description:
        "Sends a signature made from prepare_signed_deposit's typed data to the Bona Fide App, which submits the Deposit on-chain and pays its gas. Pass the submit fields from prepare_signed_deposit and the signature. Returns the transaction once the Deposit is confirmed on-chain.",
      inputSchema: z.object({
        ...signedFields,
        signature: z
          .string()
          .regex(/^0x[0-9a-fA-F]+$/)
          .describe("The signature over prepare_signed_deposit's typedData."),
      }),
      outputSchema: madeOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (fields) => {
      const made = await deposits.submitSigned(fields as Parameters<typeof deposits.submitSigned>[0]);
      return {
        content: [{ type: "text", text: withDetails(describeMadeDeposit(made), made) }],
        structuredContent: made,
      };
    },
  );

  server.registerTool(
    "get_deposit_status",
    {
      title: "Get a Deposit's status",
      description:
        "Reads a PR's or issue's Deposit from the escrow on-chain: none, active, refunded or forfeited; its amount, Depositor and Serial; when its Timeout ends and whether it has passed, after which anyone can Refund an active Deposit; and how a refunded or forfeited Deposit was split.",
      inputSchema: z.object(target),
      outputSchema: statusOutput,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      const state = await deposits.status(input);
      return {
        content: [{ type: "text", text: withDetails(describeDepositState(state), state) }],
        structuredContent: state,
      };
    },
  );

  server.registerTool(
    "prepare_refund",
    {
      title: "Prepare a Refund after the Timeout",
      description:
        "Prepares the escrow's refund transaction for a PR's or issue's active Deposit whose Timeout has passed, as calldata and as a Circle agent wallet command, to send from your own wallet. A Refund always pays the whole Deposit back to its Depositor, whoever sends it; the sender pays only gas. Before the Timeout only the Keeper can Refund, so this tool refuses, saying how long is left, as it does for an item with no active Deposit. It never signs or sends anything.",
      inputSchema: z.object({
        ...target,
        from: address.describe("The wallet that sends the transaction and pays its gas."),
      }),
      outputSchema: refundOutput,
      annotations: { readOnlyHint: true },
    },
    async ({ from: sender, ...item }) => {
      const plan = await deposits.prepareRefund(item, sender as Address);
      return {
        content: [{ type: "text", text: withDetails(describeRefundPlan(plan), plan) }],
        structuredContent: plan,
      };
    },
  );

  server.registerTool(
    "get_bounty",
    {
      title: "Get an issue's Bounty",
      description:
        "Reads the Bounty on a GitHub issue from the repo's Bounty wallet on Arc, the one its Binding's Maintainer created: whether it is open, its amount, and whether the wallet lets the Keeper pay it within its limits or only the Maintainer can. Says how a PR's author names their Payee: a line of its own, `Bounty wallet: 0x…`, in the PR's description or their own comment. Pass payee to get that exact line for your wallet, and to check the Bounty wallet can pay it.",
      inputSchema: z.object({
        repo: target.repo,
        issue: z.number().int().positive().describe("The issue number."),
        payee: address.optional().describe("The wallet you want paid: your own."),
      }),
      outputSchema: bountyOutput,
      annotations: { readOnlyHint: true },
    },
    async ({ payee, ...item }) => {
      const report = await bounties.bounty(item, payee as Address | undefined);
      return {
        content: [{ type: "text", text: withDetails(describeBounty(report), report) }],
        structuredContent: report,
      };
    },
  );

  return server;
}
