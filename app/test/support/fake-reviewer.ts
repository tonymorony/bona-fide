import type { Review, Reviewer, ReviewRequest, Suggestion } from "../../src/ports.ts";

/** An answer from the model, with made-up token counts. */
export function answer(verdict: Suggestion, reasons: string[] = ["It fixes the typo it names."]): Review {
  return { suggestion: { verdict, reasons }, model: "claude-opus-5", inputTokens: 1200, outputTokens: 80 };
}

// A model that answers what the test sets, and remembers what it was asked. It makes no network calls.
export class FakeReviewer implements Reviewer {
  readonly requests: ReviewRequest[] = [];
  /** The next answers, or an error to reject with. */
  answers: (Review | Error)[] = [];
  /** Waited on before each answer, so a test can hold the model mid-review. */
  gate?: Promise<void>;

  async review(request: ReviewRequest): Promise<Review> {
    this.requests.push(request);
    await this.gate;
    const next = this.answers.shift() ?? answer("unsure", []);
    if (next instanceof Error) throw next;
    return next;
  }
}
