import type { Resolution, ResolutionAnswer, ResolutionRequest, Resolver } from "../../src/ports.ts";

/** An answer from the model about a merged PR and its issue, with made-up token counts. */
export function resolution(
  verdict: Resolution,
  reasons: string[] = ["The PR makes the change the issue asks for."],
): ResolutionAnswer {
  return { suggestion: { verdict, reasons }, model: "claude-opus-5", inputTokens: 2400, outputTokens: 90 };
}

// A model that answers what the test sets, and remembers what it was asked. It makes no network calls.
export class FakeResolver implements Resolver {
  readonly requests: ResolutionRequest[] = [];
  /** The next answers, or an error to reject with. */
  answers: (ResolutionAnswer | Error)[] = [];

  async resolve(request: ResolutionRequest): Promise<ResolutionAnswer> {
    this.requests.push(request);
    const next = this.answers.shift() ?? resolution("partial", []);
    if (next instanceof Error) throw next;
    return next;
  }
}
