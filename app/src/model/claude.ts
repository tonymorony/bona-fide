import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { Model, Question } from "../ports.ts";
import { ModelFailed, settle, type Reply } from "./model.ts";

/** The model asked unless TRIAGE_MODEL names another. */
export const DEFAULT_MODEL = "claude-opus-5";

type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type Message = Anthropic.Beta.Messages.BetaMessage;

/** The part of the Anthropic client the model uses, so tests can answer without the network. */
export interface ClaudeClient {
  beta: { messages: { create(params: CreateParams): PromiseLike<Message> } };
}

export interface ClaudeModelOptions {
  client: ClaudeClient;
  /** Claude Opus 5 by default. */
  model?: string;
}

// One non-streaming request per question asked. A model that declines, runs out of tokens or
// answers out of shape gives no suggestion.
export function createClaudeModel({ client, model = DEFAULT_MODEL }: ClaudeModelOptions): Model {
  return {
    ask(question, request) {
      return settle(question.maxReasons, () => reply(client, model, question, question.prompt(request, token())));
    },
  };
}

/**
 * One request with adaptive thinking at medium effort, an answer in the question's schema, and
 * Anthropic's server-side fallbacks. Rejects with ModelFailed when the model can't be reached or errs.
 */
async function reply<V extends string>(
  client: ClaudeClient,
  model: string,
  question: Question<V, never>,
  content: string,
): Promise<Reply<V>> {
  const format = betaZodOutputFormat(z.object({ verdict: z.enum(question.verdicts), reasons: z.array(z.string()) }));
  let message: Message;
  try {
    message = await client.beta.messages.create({
      model,
      max_tokens: 16_000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium", format },
      // On a refusal, the API retries on its default fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: question.system,
      messages: [{ role: "user", content }],
    });
  } catch (error) {
    throw failure(error);
  }
  const usage = {
    model: message.model,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
  };
  const stopped = message.stop_reason;
  if (stopped !== "end_turn") return { ...usage, suggestion: null, silence: stopped ?? "none" };
  const text = message.content.find((block) => block.type === "text");
  try {
    return { ...usage, suggestion: format.parse(text?.text ?? "") };
  } catch {
    return { ...usage, suggestion: null, silence: "unreadable answer" };
  }
}

// Names the failure without the error's message, which can quote the request.
function failure(error: unknown): ModelFailed {
  if (error instanceof Anthropic.RateLimitError) return new ModelFailed("rate limited");
  if (error instanceof Anthropic.APIConnectionTimeoutError) return new ModelFailed("timed out");
  if (error instanceof Anthropic.APIConnectionError) return new ModelFailed("no connection");
  if (error instanceof Anthropic.AuthenticationError) return new ModelFailed("API key refused");
  if (error instanceof Anthropic.APIError) return new ModelFailed(`API error ${error.status ?? "without a status"}`);
  return new ModelFailed("unexpected error");
}

/** A random tag suffix the Contributor can't guess, so their text can't close the tag early. */
function token(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
