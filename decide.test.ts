import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { decide, sdkTransport, validateRequest, validateResponse } from "./decide";

const questions = {
  ok: { type: "noul", instructions: "Is this acceptable?", criteria: { true: "yes", false: "no" } },
  route: { type: "choice", instructions: "Where?", criteria: { api: "backend", ui: "frontend" } },
  urgency: { type: "score", instructions: "How urgent?", criteria: ["low", "medium", "high"] },
} as const;
const input = { state: { ticket: "Checkout is blank" }, questions };
const response = {
  model: "typesafe/jev-1.13-20260917", id: "gen-dec-test", provider: "TypeSafe",
  answers: {
    ok: { type: "noul", noul: 0.95 },
    route: { type: "choice", choice: "ui", confidence: 0.8, probabilities: { api: 0.1, ui: 0.9 } },
    urgency: { type: "score", score: 1.7, confidence: 0.9,
      probabilities: { "0": 0.1, "1": 0.1, "2": 0.8 }, legend: { "0": "low", "1": "medium", "2": "high" } },
  },
  usage: { inputTokens: 476, outputTokens: 70, cost: 0.000019992 },
};

describe("Jev Decisions contract", () => {
  test("preserves all three types without manufacturing a verdict or default zero", async () => {
    const actual = await decide(input, async () => "fixture-key", undefined, async (key, sent) => {
      expect(key).toBe("fixture-key");
      expect(sent).toEqual(input);
      return response;
    });
    expect(actual.answers).toEqual(response.answers);
    expect(actual.usage.cost).toBe(response.usage.cost);
    expect(actual).not.toHaveProperty("pass");
    expect(actual).not.toHaveProperty("provider");
  });

  test("rejects empty, malformed, oversized, and unexpected input before key resolution", () => {
    for (const bad of [
      { state: "", questions }, { state: [], questions },
      { ...input, surprise: "other" }, { state: "x", questions: {} },
      { state: "x", questions: { route: { type: "choice", instructions: "Pick", criteria: { only: "one" } } } },
      { state: "x", questions: { score: { type: "score", instructions: "How?", criteria: ["only"] } } },
      { state: "x".repeat(70_000), questions },
      { state: { broken: Number.NaN }, questions },
      { state: { missing: undefined }, questions },
    ]) expect(() => validateRequest(bad)).toThrow();
  });

  test("missing credential, cancellation, and API failures never become a decision", async () => {
    let sent = 0;
    const transport = async () => { sent++; return response; };
    await expect(decide(input, async () => undefined, undefined, transport)).rejects.toThrow(/credential unavailable/);
    const abort = new AbortController(); abort.abort();
    await expect(decide(input, async () => "key", abort.signal, transport)).rejects.toThrow(/cancelled/);
    expect(sent).toBe(0);
    await expect(decide(input, async () => "key", undefined, async () => { throw new Error("upstream 503"); }))
      .rejects.toThrow(/503/);
  });

  test("rejects missing answers, wrong types, unsafe probabilities, scores and labels", () => {
    const req = validateRequest(input);
    const corrupt = [
      { ...response, answers: { ...response.answers, ok: undefined } },
      { ...response, answers: { ...response.answers, ok: { type: "noul" } } },
      { ...response, answers: { ...response.answers, ok: { type: "noul", noul: 1.1 } } },
      { ...response, answers: { ...response.answers, route: { type: "choice", choice: "invented" } } },
      { ...response, answers: { ...response.answers, urgency: { type: "score", score: 9 } } },
      { ...response, answers: { ...response.answers, route: { type: "choice", choice: "api", probabilities: { api: 0.8 } } } },
      { ...response, usage: { ...response.usage, cost: -1 } },
    ];
    for (const bad of corrupt) expect(() => validateResponse(bad, req.questions)).toThrow();
  });

  test("SDK posts to /api/alpha/decisions with Pi credential; disables retry", async () => {
    let requests = 0;
    const server = createServer(async (req, res) => {
      requests++;
      expect(req.url).toBe("/api/alpha/decisions");
      expect(req.headers.authorization).toBe("Bearer fixture-key");
      const body: Buffer[] = [];
      for await (const chunk of req) body.push(Buffer.from(chunk));
      const request = JSON.parse(Buffer.concat(body).toString());
      expect(request.model).toBe("typesafe/jev-1.13");
      expect(request.questions.route.type).toBe("choice");
      if (requests === 1) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ...response, usage: {
          input_tokens: 476, output_tokens: 70, cost: 0.000019992,
        } }));
      } else {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Unavailable", code: 503 } }));
      }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    try {
      expect(addr && typeof addr === "object").toBe(true);
      // SDK supports a serverURL override for the same transport; no remote traffic in this test.
      const url = `http://127.0.0.1:${(addr as { port: number }).port}`;
      const actual = await decide(input, async () => "fixture-key", undefined,
        (key, req, signal) => sdkTransport(key, req, signal, url));
      expect(actual.answers).toEqual(response.answers);
      expect(actual.usage).toEqual(response.usage);
      await expect(sdkTransport("fixture-key", validateRequest(input), AbortSignal.timeout(5_000), url))
        .rejects.toThrow();
      expect(requests).toBe(2);
    } finally { server.close(); }
  });
});
