import { OpenRouterCore } from "@openrouter/sdk/core.js";
import { alphaDecisionsCreate } from "@openrouter/sdk/funcs/alphaDecisionsCreate.js";

export const JEV_MODEL = "typesafe/jev-1.13";
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_QUESTIONS = 16;
const MAX_CRITERIA = 16;
const TIMEOUT_MS = 15_000;

type JsonState = string | Record<string, unknown> | unknown[];
type Question =
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "score"; instructions: string; criteria: string[] };
export interface JevRequest { state: JsonState; questions: Record<string, Question> }
export type JevResponse = {
  model: string;
  id?: string;
  answers: Record<string, unknown>;
  usage: { inputTokens: number; outputTokens: number; cost?: number };
};
type Transport = (key: string, request: JevRequest, signal: AbortSignal) => Promise<unknown>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keysOnly(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 2048;
}
function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
function distribution(value: unknown, labels: string[]): boolean {
  return record(value) && Object.keys(value).length === labels.length &&
    labels.every(label => Object.hasOwn(value, label) && probability(value[label]));
}
function validQuestion(value: unknown): value is Question {
  if (!record(value) || !text(value.instructions)) return false;
  if (value.type === "noul") {
    return keysOnly(value, ["type", "instructions", "criteria"]) &&
      (value.criteria === undefined ||
        (record(value.criteria) && keysOnly(value.criteria, ["true", "false"]) &&
          Object.keys(value.criteria).length === 2 && text(value.criteria.true) && text(value.criteria.false)));
  }
  if (value.type === "choice") {
    if (!keysOnly(value, ["type", "instructions", "criteria"]) || !record(value.criteria)) return false;
    const labels = Object.keys(value.criteria);
    return labels.length >= 2 && labels.length <= MAX_CRITERIA &&
      labels.every(label => /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(label) &&
        (value.criteria![label] === null || text(value.criteria![label])));
  }
  if (value.type === "score") {
    return keysOnly(value, ["type", "instructions", "criteria"]) &&
      Array.isArray(value.criteria) && value.criteria.length >= 2 &&
      value.criteria.length <= MAX_CRITERIA && value.criteria.every(text);
  }
  return false;
}

export function validateRequest(value: unknown): JevRequest {
  if (!record(value) || !keysOnly(value, ["state", "questions"]) ||
      !((typeof value.state === "string" && value.state.trim().length > 0) ||
        (record(value.state) && Object.keys(value.state).length > 0) ||
        (Array.isArray(value.state) && value.state.length > 0)) || !record(value.questions)) {
    throw new Error("Jev requires nonempty state and a questions object.");
  }
  const ids = Object.keys(value.questions);
  if (ids.length < 1 || ids.length > MAX_QUESTIONS ||
      ids.some(id => !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id) || !validQuestion(value.questions[id]))) {
    throw new Error("Jev questions must be 1–16 valid noul, choice, or score questions.");
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value, (_key, item: unknown) => {
      if (item === undefined || typeof item === "bigint" || typeof item === "function" ||
          typeof item === "symbol" || (typeof item === "number" && !Number.isFinite(item))) {
        throw new Error("Not a JSON value");
      }
      if (record(item) && Object.getPrototypeOf(item) !== Object.prototype &&
          Object.getPrototypeOf(item) !== null) throw new Error("Not a plain JSON object");
      return item;
    });
  } catch { throw new Error("Jev request must contain only JSON values."); }
  if (!serialized || Buffer.byteLength(serialized, "utf8") > MAX_REQUEST_BYTES) {
    throw new Error("Jev request exceeds the 64 KiB limit.");
  }
  // The SDK must receive exactly the bytes the caller supplied, without coerced values.
  const normalized = JSON.parse(serialized) as JevRequest;
  if (JSON.stringify(normalized) !== serialized) throw new Error("Invalid Jev JSON request.");
  return normalized;
}

export function validateResponse(value: unknown, questions: JevRequest["questions"]): JevResponse {
  if (!record(value) || !text(value.model) || !record(value.answers) ||
      !record(value.usage) || !Number.isSafeInteger(value.usage.inputTokens) ||
      (value.usage.inputTokens as number) < 0 || !Number.isSafeInteger(value.usage.outputTokens) ||
      (value.usage.outputTokens as number) < 0 ||
      (value.usage.cost !== undefined && (typeof value.usage.cost !== "number" ||
        !Number.isFinite(value.usage.cost) || value.usage.cost < 0))) {
    throw new Error("Invalid Jev response or usage.");
  }
  const ids = Object.keys(questions);
  if (Object.keys(value.answers).length !== ids.length) throw new Error("Jev answer IDs do not match questions.");
  for (const id of ids) {
    const answer = value.answers[id];
    const question = questions[id];
    if (!record(answer) || !question || answer.type !== question.type) {
      throw new Error(`Invalid Jev answer for ${id}.`);
    }
    if (question.type === "noul" && !probability(answer.noul)) {
      throw new Error(`Invalid Jev noul for ${id}.`);
    }
    if (question.type === "choice" &&
        (typeof answer.choice !== "string" || !Object.hasOwn(question.criteria, answer.choice) ||
          (answer.confidence !== undefined && !probability(answer.confidence)) ||
          (answer.probabilities !== undefined && !distribution(answer.probabilities, Object.keys(question.criteria))))) {
      throw new Error(`Invalid Jev choice for ${id}.`);
    }
    if (question.type === "score" &&
        (typeof answer.score !== "number" || !Number.isFinite(answer.score) ||
          answer.score < 0 || answer.score > question.criteria.length - 1 ||
          (answer.confidence !== undefined && !probability(answer.confidence)) ||
          (answer.probabilities !== undefined && !distribution(answer.probabilities,
            question.criteria.map((_, index) => String(index)))))) {
      throw new Error(`Invalid Jev score for ${id}.`);
    }
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 32 * 1024) {
    throw new Error("Jev response exceeds the 32 KiB limit.");
  }
  return {
    model: value.model,
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    answers: value.answers,
    usage: {
      inputTokens: value.usage.inputTokens as number,
      outputTokens: value.usage.outputTokens as number,
      ...(typeof value.usage.cost === "number" ? { cost: value.usage.cost } : {}),
    },
  } as JevResponse;
}

export async function sdkTransport(key: string, request: JevRequest, signal: AbortSignal, serverURL?: string): Promise<unknown> {
  const client = new OpenRouterCore({ apiKey: key });
  const result = await alphaDecisionsCreate(client, {
    decisionsRequest: { model: JEV_MODEL, ...request },
  }, {
    fetchOptions: { signal }, timeoutMs: TIMEOUT_MS, retries: { strategy: "none" },
    ...(serverURL ? { serverURL } : {}),
  });
  if (!result.ok) throw new Error("OpenRouter Jev Decisions API request failed.");
  return result.value;
}

export async function decide(
  input: unknown,
  resolveKey: () => Promise<string | undefined>,
  signal?: AbortSignal,
  transport: Transport = sdkTransport,
): Promise<JevResponse> {
  const request = validateRequest(input);
  if (signal?.aborted) throw new Error("Jev request cancelled.");
  let key: string | undefined;
  try { key = await resolveKey(); }
  catch { throw new Error("Could not resolve the Pi OpenRouter credential."); }
  if (!key) throw new Error("Pi OpenRouter credential unavailable; configure the openrouter provider.");
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const result = await transport(key, request, combined);
  if (combined.aborted) throw new Error("Jev request cancelled or timed out.");
  return validateResponse(result, request.questions);
}
