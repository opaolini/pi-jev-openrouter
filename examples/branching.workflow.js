// Demo only: synthetic ticket, read-only follow-ups, no issue or file mutations.
// Launch with workflow({ name: "jev-branching-demo",
//   scriptPath: "<path-to-pi-jev-openrouter>/examples/branching.workflow.js",
//   args: { ticket: "Checkout goes blank after clicking Pay in two browsers." } }).
const ticket = args?.ticket ?? "Checkout goes blank after clicking Pay in two browsers.";

// 1. Agent prepares concise state. It must return via workflow_result.
const summary = await agent(
  prompt("Summarize this synthetic ticket in one sentence without using tools other than workflow_result: {ticket}", { ticket }),
  { label: "ticket-summary" },
);

// 2. Jev supplies a typed probability, not a prose explanation or an approval.
const decision = await jevDecide({
  state: { ticket, summary },
  questions: {
    is_bug: {
      type: "noul",
      instructions: "Does this ticket describe broken or unexpected existing product behavior?",
      criteria: {
        true: "Existing behavior is broken or unexpectedly changed.",
        false: "This is a question or request for a new capability.",
      },
    },
  },
});
const probability = decision.answers.is_bug.noul;

// 3. The workflow owns the routing policy. Ambiguous results stop for a human.
if (probability >= 0.8) {
  const next = await agent(
    prompt("Draft a read-only bug reproduction checklist for this ticket. Do not edit files or create issues. Ticket: {ticket}; summary: {summary}", { ticket, summary }),
    { label: "bug-followup" },
  );
  return { route: "bug", probability, next, model: decision.model, usage: decision.usage };
}
if (probability <= 0.2) {
  const next = await agent(
    prompt("Draft a read-only feature intake question for this ticket. Do not edit files or create issues. Ticket: {ticket}; summary: {summary}", { ticket, summary }),
    { label: "feature-followup" },
  );
  return { route: "feature", probability, next, model: decision.model, usage: decision.usage };
}
return { route: "needs_human_triage", probability, summary, model: decision.model, usage: decision.usage };
