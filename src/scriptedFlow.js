// ── Scripted demo flows: a generic keyed-step state machine ───────────────────
// Two of the WhatsCraft demos (Subway "Finals Week" and Kia "Seltos follow-up")
// are fully scripted, deterministic conversations gated to a single demo phone
// each. Rather than hand-roll a second bespoke sequence like flow2Session.js, this
// module is a small engine that walks a data-defined flow (see data/*.json). The
// LLM is never involved for a scripted phone — the reply to every turn is fixed.
//
// A flow is: { phone, start, steps: { <key>: Step } }. A Step is:
//   { onEnter: Message[], await: Gate | null }
// - onEnter  : the bot's messages when this step becomes active (the bot's move).
// - await    : how to interpret the user's NEXT reply. null ⇒ terminal (the flow
//              ends after onEnter). A Gate is one of:
//     { kind: 'any',     next: <key> }                         ← any text advances
//     { kind: 'buttons', options: [{ match, next }], reask: Message[] }
//       (a tapped/typed answer is fuzzy-matched against each option's `match`;
//        an unmatched answer re-sends `reask` and stays on the step)
//
// A Message is { type: 'text', text } | { type: 'image', link, caption }
//   | { type: 'buttons', body, options: string[] }  (executed by the caller —
//   this module stays pure and just returns the messages to send).
//
// Branching is expressed purely through `next` targets (e.g. "Send as-is" points at
// a terminal step, "Edit" at the next question), so the whole script — including
// its copy and banner URLs — lives in JSON and can be edited without code changes.

const { matchOption } = require('./fuzzy');

// Enter a step: returns its outgoing messages and whether the flow ends here.
function enter(flow, stepKey) {
  const step = flow.steps[stepKey];
  if (!step) {
    // Misconfigured `next` — end rather than loop forever. Surfaced in logs by the caller.
    return { stepKey: null, sends: [], end: true };
  }
  return { stepKey, sends: step.onEnter || [], end: !step.await };
}

// Begin a flow from its start step. Returns { session, sends } where `session` is
// { stepKey } while the flow is still awaiting input, or null once it has ended.
function start(flow) {
  const entered = enter(flow, flow.start);
  return { session: entered.end ? null : { stepKey: entered.stepKey }, sends: entered.sends };
}

// Advance an active flow by one user reply. Returns { session, sends }: `session` is
// the next { stepKey } (null when the flow ends), and `sends` are the messages the
// caller should deliver — either the next step's onEnter, or a re-ask on a miss.
function advance(flow, session, userText) {
  const step = flow.steps[session?.stepKey];
  const gate = step && step.await;
  if (!gate) return { session: null, sends: [] };

  let nextKey = null;
  if (gate.kind === 'any') {
    nextKey = gate.next;
  } else if (gate.kind === 'buttons') {
    const candidates = gate.options.map((o) => o.match);
    const matched = matchOption(userText, candidates);
    const option = matched ? gate.options.find((o) => o.match === matched) : null;
    if (!option) {
      // Never silently misfire — re-ask the same question (mirrors flow2Session).
      return { session, sends: gate.reask || [] };
    }
    nextKey = option.next;
  }

  const entered = enter(flow, nextKey);
  return { session: entered.end ? null : { stepKey: entered.stepKey }, sends: entered.sends };
}

module.exports = { start, advance };
