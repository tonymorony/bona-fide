import { KINDS } from "@bona-fide/sdk";
import { McpServer } from "@modelcontextprotocol/server";
import type { Address } from "viem";
import * as z from "zod/v4";
import { describeMadeDeposit, describeRules, describeSignedPlan, describeTwoStepPlan, withDetails } from "./copy.ts";
import { createDeposits, type DepositsOptions } from "./deposits.ts";

export type ServerOptions = DepositsOptions;

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

const target = {
  repo: z
    .string()
    .regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/)
    .describe("The GitHub repo, as owner/name."),
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

const signedFields = {
  ...target,
  from,
  value: z.string().regex(/^\d+$/).describe("The Deposit in USDC base units (6 decimals)."),
  validAfter: z.string().regex(/^\d+$/),
  validBefore: z.string().regex(/^\d+$/),
  salt: hex32,
};

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

export function createServer(options: ServerOptions): McpServer {
  const deposits = createDeposits(options);
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

  return server;
}
