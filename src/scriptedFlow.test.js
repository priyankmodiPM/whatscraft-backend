const test = require('node:test');
const assert = require('node:assert');

// Pin the flow numbers so these tests are deterministic and don't depend on the
// mutable data/flow-routing.json (which the user edits to repoint numbers). These are
// the eventual two-number setup — distinct, non-overlapping.
process.env.SUBWAY_PHONE = '918328145692';
process.env.KIA_PHONE = '919899860983';

const scriptedFlow = require('./scriptedFlow');
const { loadScriptedFlows, flowForPhone, flowForAccount } = require('./scriptedFlows');

// ── Engine unit tests (tiny inline flow) ─────────────────────────────────────

const tinyFlow = {
  start: 'k',
  steps: {
    k: {
      onEnter: [{ type: 'text', text: 'hi' }],
      await: {
        kind: 'buttons',
        options: [
          { match: 'Go', next: 'go' },
          { match: 'Stop', next: 'stop' },
        ],
        reask: [{ type: 'text', text: 'tap Go or Stop' }],
      },
    },
    go: { onEnter: [{ type: 'text', text: 'going' }], await: { kind: 'any', next: 'done' } },
    stop: { onEnter: [{ type: 'text', text: 'stopped' }] }, // terminal
    done: { onEnter: [{ type: 'text', text: 'done' }] }, // terminal
  },
};

test('start() enters the start step and keeps the session open when it has a gate', () => {
  const { session, sends } = scriptedFlow.start(tinyFlow);
  assert.deepStrictEqual(session, { stepKey: 'k' });
  assert.deepStrictEqual(sends, [{ type: 'text', text: 'hi' }]);
});

test('advance() with a matched button moves to the next step', () => {
  const { session, sends } = scriptedFlow.advance(tinyFlow, { stepKey: 'k' }, '👉 Go');
  assert.deepStrictEqual(session, { stepKey: 'go' });
  assert.deepStrictEqual(sends, [{ type: 'text', text: 'going' }]);
});

test('advance() with an unmatched button re-asks and stays on the step', () => {
  const { session, sends } = scriptedFlow.advance(tinyFlow, { stepKey: 'k' }, 'zzzz');
  assert.deepStrictEqual(session, { stepKey: 'k' });
  assert.deepStrictEqual(sends, [{ type: 'text', text: 'tap Go or Stop' }]);
});

test('advance() into a terminal step ends the session', () => {
  const { session, sends } = scriptedFlow.advance(tinyFlow, { stepKey: 'k' }, 'Stop');
  assert.strictEqual(session, null);
  assert.deepStrictEqual(sends, [{ type: 'text', text: 'stopped' }]);
});

test("advance() with an 'any' gate advances on any input", () => {
  const { session, sends } = scriptedFlow.advance(tinyFlow, { stepKey: 'go' }, 'literally anything');
  assert.strictEqual(session, null);
  assert.deepStrictEqual(sends, [{ type: 'text', text: 'done' }]);
});

// ── Loaded flows: registry + phone routing ───────────────────────────────────

test('loadScriptedFlows resolves the two flows on distinct numbers', () => {
  const flows = loadScriptedFlows();
  const subway = flowForPhone(flows, '918328145692');
  const kia = flowForPhone(flows, '919899860983');
  assert.ok(subway, 'subway flow resolves');
  assert.ok(kia, 'kia flow resolves');
  assert.notStrictEqual(subway, kia);
  assert.strictEqual(flowForPhone(flows, '911112223334'), null);
});

test('Kia sends from its own WhatsApp account when configured; Subway uses the default', () => {
  process.env.KIA_WHATSAPP_PHONE_NUMBER_ID = '111222';
  process.env.KIA_WHATSAPP_TOKEN = 'faketok';
  try {
    const flows = loadScriptedFlows();
    assert.deepStrictEqual(flowForPhone(flows, '919899860983').__sender, {
      phoneNumberId: '111222',
      token: 'faketok',
      label: 'kia',
    });
    assert.strictEqual(flowForPhone(flows, '918328145692').__sender, null, 'subway uses the default account');
  } finally {
    delete process.env.KIA_WHATSAPP_PHONE_NUMBER_ID;
    delete process.env.KIA_WHATSAPP_TOKEN;
  }
});

test('flowForAccount routes by the receiving business account', () => {
  process.env.WHATSAPP_PHONE_NUMBER_ID = 'DEFAULT_PID';
  process.env.KIA_WHATSAPP_PHONE_NUMBER_ID = 'KIA_PID';
  process.env.KIA_WHATSAPP_TOKEN = 'kiatok';
  try {
    const flows = loadScriptedFlows();
    const subway = flowForPhone(flows, '918328145692');
    const kia = flowForPhone(flows, '919899860983');
    assert.strictEqual(flowForAccount(flows, 'DEFAULT_PID'), subway, 'default account → Subway');
    assert.strictEqual(flowForAccount(flows, 'KIA_PID'), kia, 'Kia account → Kia');
    assert.strictEqual(flowForAccount(flows, 'UNKNOWN_ID'), null, 'unmatched account → no flow');
    assert.strictEqual(flowForAccount(flows, undefined), null, 'missing account → no flow');
  } finally {
    delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    delete process.env.KIA_WHATSAPP_PHONE_NUMBER_ID;
    delete process.env.KIA_WHATSAPP_TOKEN;
  }
});

test('flowForPhone prefers the longest (most-specific) registered number', () => {
  // If a 10-digit number is ever registered alongside its 12-digit +91 form, the full
  // number must route to its own flow rather than the shorter one it contains.
  const short = { start: 'x', steps: { x: { onEnter: [] } } };
  const full = { start: 'y', steps: { y: { onEnter: [] } } };
  const map = new Map([
    ['9899860983', short],
    ['919899860983', full],
  ]);
  assert.strictEqual(flowForPhone(map, '919899860983'), full);
  assert.strictEqual(flowForPhone(map, '9899860983'), short);
  assert.strictEqual(flowForPhone(map, '1112223334'), null);
});

// Walk a flow along a scripted path of user replies, asserting it ends (session null)
// exactly when expected. Returns the sequence of every message the bot emitted.
function walk(flow, replies) {
  const emitted = [];
  let { session, sends } = scriptedFlow.start(flow);
  emitted.push(...sends);
  for (const reply of replies) {
    assert.ok(session, `session still open before reply "${reply}"`);
    ({ session, sends } = scriptedFlow.advance(flow, session, reply));
    emitted.push(...sends);
  }
  return { session, emitted };
}

test('Subway golden path runs kickoff → sent and emits all five banners', () => {
  const flow = flowForPhone(loadScriptedFlows(), '918328145692');
  const { session, emitted } = walk(flow, [
    '✏️ Edit',
    'chicken tikka sub combo, sub + cookie + cold drink',
    '✅ Yes, ₹250',
    'add a gluten free tag',
    '🥖 Swap to GF base',
    'first 20 customers extra 10% off',
    '🔀 Dono',
  ]);
  assert.strictEqual(session, null, 'flow ends after channel pick');
  const images = emitted.filter((m) => m.type === 'image').map((m) => m.link);
  assert.strictEqual(images.length, 5, 'v0–v4 all delivered');
  assert.ok(images.every((l) => /^https?:\/\//.test(l)), 'every banner has a real URL');
});

test('Subway "Send as-is" is a clean one-step exit', () => {
  const flow = flowForPhone(loadScriptedFlows(), '918328145692');
  const { session, emitted } = walk(flow, ['📤 Send as-is']);
  assert.strictEqual(session, null);
  assert.ok(emitted.some((m) => m.type === 'text' && /Sent as-is/.test(m.text)));
});

test('Subway gluten-free step re-asks on an unrecognised reply', () => {
  const flow = flowForPhone(loadScriptedFlows(), '918328145692');
  let { session, sends } = scriptedFlow.start(flow);
  ({ session, sends } = scriptedFlow.advance(flow, session, '✏️ Edit'));
  ({ session, sends } = scriptedFlow.advance(flow, session, 'combo please'));
  ({ session, sends } = scriptedFlow.advance(flow, session, '✅ Yes, ₹250'));
  ({ session, sends } = scriptedFlow.advance(flow, session, 'preview looks fine, add gluten free'));
  const before = session.stepKey;
  ({ session, sends } = scriptedFlow.advance(flow, session, 'purple monkey dishwasher'));
  assert.strictEqual(session.stepKey, before, 'stays on the gluten-free step');
  assert.ok(sends.some((m) => m.type === 'buttons'), 're-asks with buttons');
});

test('Kia golden path runs kickoff → localized banner with contact', () => {
  const flow = flowForPhone(loadScriptedFlows(), '919899860983');
  const { session, emitted } = walk(flow, [
    '✅ Yes, follow up',
    '✅ Yes, go ahead',
    '✅ Yes, add it',
    'make it Hindi and add the on-road price',
  ]);
  assert.strictEqual(session, null);
  const texts = emitted.filter((m) => m.type === 'text').map((m) => m.text).join('\n');
  assert.ok(/\+91 98998 60983/.test(texts), 'confirms adding the known contact number');
  const images = emitted.filter((m) => m.type === 'image').map((m) => m.link);
  assert.strictEqual(images.length, 2, 'contact preview + final Hindi banner');
  assert.ok(emitted.some((m) => m.type === 'progress'), 'streams generation progress');
});

test('Kia "Not now" and "No" are clean exits', () => {
  const flow = flowForPhone(loadScriptedFlows(), '919899860983');
  assert.strictEqual(walk(flow, ['🙅 Not now']).session, null);
  assert.strictEqual(walk(flow, ['✅ Yes, follow up', '🙅 No']).session, null);
});

test('Kia "No, skip" still reaches the localized banner (no contact line)', () => {
  const flow = flowForPhone(loadScriptedFlows(), '919899860983');
  const { session, emitted } = walk(flow, [
    '✅ Yes, follow up',
    '✅ Yes, go ahead',
    '🙅 No, skip',
    'Hindi + on-road price',
  ]);
  assert.strictEqual(session, null);
  const texts = emitted.filter((m) => m.type === 'text').map((m) => m.text).join('\n');
  assert.ok(/no contact on this one/.test(texts));
  assert.ok(!/Adding your contact/.test(texts));
});
