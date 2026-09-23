import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { createRequire } from "node:module";
import { join } from "node:path";
import { decide } from "./decide.js";

// Optional: pi-extensible-workflows installed globally. Without it only the jev_decide tool is registered.
let registerWorkflowExtension: ((extension: unknown) => void) | undefined;
try {
  const entry = createRequire(join(getAgentDir(), "npm", "package.json")).resolve("pi-extensible-workflows");
  ({ registerWorkflowExtension } = await import(entry));
} catch { registerWorkflowExtension = undefined; }

const input = Type.Object({
  state: Type.Any({ description: "Nonempty string, JSON object, or JSON array to evaluate" }),
  questions: Type.Record(Type.String(), Type.Any(), {
    description: "1–16 named noul, choice, or score questions with instructions and optional criteria",
  }),
}, { additionalProperties: false });
const output = Type.Object({
  model: Type.String(),
  id: Type.Optional(Type.String()),
  answers: Type.Record(Type.String(), Type.Any()),
  usage: Type.Object({
    inputTokens: Type.Integer(), outputTokens: Type.Integer(), cost: Type.Optional(Type.Number()),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

export default function jevExtension(pi: ExtensionAPI) {
  let getKey: (() => Promise<string | undefined>) | undefined;
  pi.on("session_start", (_event, ctx) => {
    // Capture the current session's registry, not an auth token or a stale ExtensionContext.
    const registry = ctx.modelRegistry;
    getKey = async () => {
      const auth = await registry.getProviderAuth("openrouter");
      if (auth?.auth.baseUrl && new URL(auth.auth.baseUrl).hostname !== "openrouter.ai") {
        throw new Error("OpenRouter credential is scoped to another endpoint.");
      }
      return auth?.auth.apiKey;
    };
  });
  pi.on("session_shutdown", () => { getKey = undefined; });

  registerWorkflowExtension?.({
    source: import.meta.url,
    version: "0.1.0",
    headline: "Opt-in Jev decisions via Pi OpenRouter auth",
    functions: {
      jevDecide: {
        description: "Evaluate explicit state with Jev noul/choice/score questions. Returns typed probabilities; no automatic gate or verdict.",
        input, output,
        async run(value: unknown, context: { run: { signal: AbortSignal } }) {
          const resolver = getKey;
          if (!resolver) throw new Error("Pi OpenRouter auth unavailable in this workflow session.");
          return decide(value, resolver, context.run.signal);
        },
      },
    },
  });

  pi.registerTool({
    name: "jev_decide",
    label: "Jev decision",
    description: "Explicitly ask Jev via OpenRouter typed noul/choice/score questions about supplied state. No auto-routing or automatic approval; response capped at 32 KiB.",
    parameters: input,
    async execute(_id, value, signal, _update, ctx) {
      const result = await decide(value, async () => {
        const auth = await ctx.modelRegistry.getProviderAuth("openrouter");
        if (auth?.auth.baseUrl && new URL(auth.auth.baseUrl).hostname !== "openrouter.ai") {
          throw new Error("OpenRouter credential is scoped to another endpoint.");
        }
        return auth?.auth.apiKey;
      }, signal);
      const serialized = JSON.stringify(result);
      if (Buffer.byteLength(serialized, "utf8") > 32 * 1024) throw new Error("Jev response exceeds the 32 KiB tool limit.");
      return { content: [{ type: "text" as const, text: serialized }], details: result };
    },
  });
}
