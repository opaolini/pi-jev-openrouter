import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./branching.workflow.js", import.meta.url), "utf8");
const run = new (Object.getPrototypeOf(async function () {}).constructor)(
  "args", "agent", "jevDecide", "prompt", source,
) as (
  args: { ticket: string },
  agent: (message: string, options: { label: string }) => Promise<string>,
  jevDecide: (request: unknown) => Promise<unknown>,
  prompt: (template: string, values: Record<string, string>) => string,
) => Promise<{ route: string; probability: number; next?: string }>;

async function exercise(probability: number) {
  const agents: string[] = [];
  let calls = 0;
  const result = await run(
    { ticket: "Synthetic checkout failure" },
    async (_message, options) => {
      agents.push(options.label);
      return options.label === "ticket-summary" ? "Checkout fails after Pay." : `Result from ${options.label}`;
    },
    async (request) => {
      calls++;
      expect(request).toEqual({
        state: { ticket: "Synthetic checkout failure", summary: "Checkout fails after Pay." },
        questions: { is_bug: {
          type: "noul",
          instructions: "Does this ticket describe broken or unexpected existing product behavior?",
          criteria: {
            true: "Existing behavior is broken or unexpectedly changed.",
            false: "This is a question or request for a new capability.",
          },
        } },
      });
      return { model: "typesafe/jev-1.13", answers: { is_bug: { type: "noul", noul: probability } }, usage: { cost: 0.00002 } };
    },
    (template, values) => template.replace(/\{(ticket|summary)\}/g, (_, key: string) => values[key]),
  );
  return { result, agents, calls };
}

describe("Agent → Jev → outcome demo (no provider calls)", () => {
  test("high bug probability dispatches a read-only bug follow-up", async () => {
    const { result, agents, calls } = await exercise(0.96);
    expect(result.route).toBe("bug");
    expect(result.next).toContain("bug-followup");
    expect(agents).toEqual(["ticket-summary", "bug-followup"]);
    expect(calls).toBe(1);
  });

  test("low bug probability dispatches a feature intake follow-up", async () => {
    const { result, agents, calls } = await exercise(0.03);
    expect(result.route).toBe("feature");
    expect(result.next).toContain("feature-followup");
    expect(agents).toEqual(["ticket-summary", "feature-followup"]);
    expect(calls).toBe(1);
  });

  test("uncertain probability requests human triage rather than acting", async () => {
    const { result, agents, calls } = await exercise(0.55);
    expect(result.route).toBe("needs_human_triage");
    expect(result.next).toBeUndefined();
    expect(agents).toEqual(["ticket-summary"]);
    expect(calls).toBe(1);
  });
});
