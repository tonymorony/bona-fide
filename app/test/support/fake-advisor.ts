import type { Advice, AdviceAnswer, AdviceRequest, Advisor } from "../../src/ports.ts";

/** An answer from the model about a Contributor's record, with made-up token counts. */
export function advice(verdict: Advice, reasons: string[] = ["Four accepted Deposits in three repos."]): AdviceAnswer {
  return { suggestion: { verdict, reasons }, model: "claude-opus-5", inputTokens: 600, outputTokens: 40 };
}

// A model that answers what the test sets, and remembers what it was asked. It makes no network calls.
export class FakeAdvisor implements Advisor {
  readonly requests: AdviceRequest[] = [];
  /** The next answers, or an error to reject with. */
  answers: (AdviceAnswer | Error)[] = [];
  /** Waited on before each answer, so a test can hold the model mid-answer. */
  gate?: Promise<void>;

  async advise(request: AdviceRequest): Promise<AdviceAnswer> {
    this.requests.push(request);
    await this.gate;
    const next = this.answers.shift() ?? advice("require", []);
    if (next instanceof Error) throw next;
    return next;
  }
}
