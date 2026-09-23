# pi-jev-openrouter

A [pi](https://pi.dev) extension for explicit **Jev** decisions (`typesafe/jev-1.13`) through
OpenRouter, using the API key pi already has for its `openrouter` provider.

- **`jev_decide` tool.** The agent asks typed questions about the state it supplies.
- **`jevDecide()` workflow function.** Registered when
  [pi-extensible-workflows](https://github.com/vekexasia/pi-extensible-workflows) is installed.

Each question is one of:

| Type | Returns |
|---|---|
| `noul` | Probability that a statement is true (optional `criteria: {true, false}`) |
| `choice` | Probability distribution over 2–16 labels |
| `score` | Distribution over 2–16 ordered criteria |

Nothing happens automatically: no routing, no model switching, no built-in thresholds, and no separate credential.
Missing auth, API errors, invalid or missing answers, and cancellation all fail closed. The caller
owns any cutoff policy. Don't use it in place of deterministic checks or a human release gate.

This is not the upstream `pi-jev` package, which exposes broader automatic behaviour and expects a
different credential. Don't install both.

## Install

```sh
pi install git:github.com/opaolini/pi-jev-openrouter
```

Requires a configured pi `openrouter` provider. Each call **sends the supplied state to
OpenRouter/TypeSafe and is a paid request**, typically fractions of a cent.

## Use

```js
// inside a pi-extensible-workflows script
const r = await jevDecide({
  state: { ticket: "Checkout is blank" },
  questions: { is_bug: { type: "noul", instructions: "Does this describe broken behavior?" } },
});
// r = { model, id?, answers: { is_bug: { type: "noul", noul: 0.93 } }, usage: { inputTokens, outputTokens, cost? } }
```

Limits:
- Request: 64 KiB, at most 16 questions, at most 16 criteria per question.
- Timeout: 15 s.
- Tool responses: capped at 32 KiB.

[`examples/branching.workflow.js`](examples/branching.workflow.js) shows **agent → jevDecide → outcome**:
1. A summary agent prepares the state.
2. Jev returns a `noul` probability.
3. The workflow then either dispatches a read-only follow-up agent or returns `needs_human_triage`.

Its 0.8/0.2 cutoffs illustrate a caller-owned policy; they are not calibrated thresholds.

## Development

```sh
npm install --no-package-lock --ignore-scripts
bun test                          # decide() against a local HTTP fixture + example routes, no network
node --test test/*.test.mjs       # loads the extension through pi's resource loader, offline
```

MIT
