import { settle, type Reply } from "../../src/model/model.ts";
import type { Advice, Answer, Model, Question, Resolution, Suggestion } from "../../src/ports.ts";

/** Triage's reply from the model, with made-up token counts. */
export function answer(verdict: Suggestion, reasons: string[] = ["It fixes the typo it names."]): Reply<Suggestion> {
  return { suggestion: { verdict, reasons }, model: "claude-opus-5", inputTokens: 1200, outputTokens: 80 };
}

/** A reply from the model about a Contributor's record, with made-up token counts. */
export function advice(verdict: Advice, reasons: string[] = ["Four accepted Deposits in three repos."]): Reply<Advice> {
  return { suggestion: { verdict, reasons }, model: "claude-opus-5", inputTokens: 600, outputTokens: 40 };
}

/** A reply from the model about a merged PR and its issue, with made-up token counts. */
export function resolution(
  verdict: Resolution,
  reasons: string[] = ["The PR makes the change the issue asks for."],
): Reply<Resolution> {
  return { suggestion: { verdict, reasons }, model: "claude-opus-5", inputTokens: 2400, outputTokens: 90 };
}

const NO_SUGGESTION: Reply<never> = {
  suggestion: null,
  silence: "refusal",
  model: "claude-opus-5",
  inputTokens: 0,
  outputTokens: 0,
};

// A model that replies what the test sets, settled as the Claude model's replies are, and remembers
// what it was asked. It makes no network calls.
export class FakeModel<R = any> implements Model {
  readonly requests: R[] = [];
  /** The next replies, or an error to fail with. Without one, the model gives no suggestion. */
  answers: (Reply<string> | Error)[] = [];
  /** Waited on before each reply, so a test can hold the model mid-answer. */
  gate?: Promise<void>;

  ask<V extends string, Q>(question: Question<V, Q>, request: Q): Promise<Answer<V>> {
    this.requests.push(request as unknown as R);
    return settle(question.maxReasons, async () => {
      await this.gate;
      const next = this.answers.shift() ?? NO_SUGGESTION;
      if (next instanceof Error) throw next;
      return next as Reply<V>;
    });
  }
}
