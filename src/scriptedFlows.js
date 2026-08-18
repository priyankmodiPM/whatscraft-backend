// ── Scripted-flow registry ────────────────────────────────────────────────────
// Loads the data-defined scripted demo flows (Subway, Kia) and exposes a lookup that
// runs the fixed script (src/scriptedFlow.js), never reaching the LLM; anything that
// matches neither flow falls through to the existing behaviour.
//
// Routing prefers the BUSINESS number the customer texted (`value.metadata.display_phone_number`
// from the webhook) — that's the only correct signal for a flow with its OWN dedicated
// WhatsApp account (currently Kia, see senderEnvPrefix below), since any customer can
// text that number. But a flow with no dedicated account of its own (currently Subway —
// it sends from the shared default account) has no business number to key on, so it
// falls back to matching the SENDER's number (`message.from`) instead — see
// flowForMessage(). Don't assume every flow can be matched the same way.
//
// The number → flow binding is configurable, single source of truth = data/flow-routing.json
// (e.g. { "subway": "9899860983", "kia": "919899860983" }). Precedence per flow:
//   env var (SUBWAY_PHONE / KIA_PHONE)  >  flow-routing.json  >  the flow JSON's own
//   "phone"  >  the hardcoded default below.
// Edit the routing file (or set the env var) and restart to repoint a flow — useful
// for testing both flows on a single number (point that flow at it, one at a time).

const fs = require('node:fs');
const path = require('node:path');

// Defaults are the eventual two-number setup (distinct numbers, no overlap). The
// routing file / env override these — e.g. while testing on a single SIM.
// `senderEnvPrefix` selects which WhatsApp Business account a flow SENDS from:
//   - omitted  → the default account (WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_TOKEN)
//   - "KIA_WHATSAPP" → KIA_WHATSAPP_PHONE_NUMBER_ID / KIA_WHATSAPP_TOKEN
// If a flow's sender env vars aren't set, it safely falls back to the default account.
const FLOW_DEFS = [
  { key: 'subway', phoneEnv: 'SUBWAY_PHONE', fileEnv: 'SUBWAY_FLOW_FILE', default: '918328145692', file: 'subway-finals-week.json' },
  { key: 'kia', phoneEnv: 'KIA_PHONE', fileEnv: 'KIA_FLOW_FILE', default: '919899860983', file: 'kia-seltos-followup.json', senderEnvPrefix: 'KIA_WHATSAPP' },
];

// Resolve a flow's WhatsApp sender account from env, or null to use the default.
function resolveSender(def) {
  if (!def.senderEnvPrefix) return null;
  const phoneNumberId = process.env[`${def.senderEnvPrefix}_PHONE_NUMBER_ID`];
  const token = process.env[`${def.senderEnvPrefix}_TOKEN`];
  if (phoneNumberId && token) return { phoneNumberId, token, label: def.key };
  console.warn(
    `[scriptedFlows] ${def.key}: ${def.senderEnvPrefix}_PHONE_NUMBER_ID/_TOKEN not set — sending from the DEFAULT WhatsApp account`
  );
  return null;
}

function dataPath(fileEnv, fallbackFile) {
  return (fileEnv && process.env[fileEnv]) || path.join(__dirname, '..', 'data', fallbackFile);
}

// Load the central routing map, best-effort. A missing/invalid file just means every
// flow falls back to its JSON "phone" / default — never fatal.
function loadRouting() {
  const routingPath = process.env.FLOW_ROUTING_FILE || path.join(__dirname, '..', 'data', 'flow-routing.json');
  try {
    return JSON.parse(fs.readFileSync(routingPath, 'utf8')) || {};
  } catch (err) {
    console.warn('[scriptedFlows] no usable flow-routing.json — using per-flow defaults', { path: routingPath, message: err.message });
    return {};
  }
}

function loadFlow(filePath) {
  const flow = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!flow || typeof flow !== 'object' || !flow.start || !flow.steps) {
    throw new Error(`scripted flow at ${filePath} is missing start/steps`);
  }
  return flow;
}

// Build the phone → flow map once at startup. A load/parse failure for one flow is
// logged and skipped (that demo number simply falls through) rather than crashing boot.
function loadScriptedFlows() {
  const routing = loadRouting();
  const byPhone = new Map();
  const resolved = {};
  for (const def of FLOW_DEFS) {
    const filePath = dataPath(def.fileEnv, def.file);
    try {
      const flow = loadFlow(filePath);
      const phone = String(process.env[def.phoneEnv] || routing[def.key] || flow.phone || def.default);
      flow.__sender = resolveSender(def); // which WhatsApp account this flow sends from (null = default)
      // The business account this flow OWNS = its sender's phone-number-id, or the default
      // account's id when the flow has none. Inbound messages are routed to a flow by the
      // account they arrive on (webhook metadata.phone_number_id) — see flowForAccount.
      flow.__accountId = flow.__sender?.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID || null;
      byPhone.set(phone, flow);
      resolved[def.key] = `${phone} (account: ${flow.__accountId ?? 'unset'} / ${flow.__sender ? def.senderEnvPrefix : 'default'})`;
    } catch (err) {
      console.error('[scriptedFlows] failed to load flow', { key: def.key, file: filePath, message: err.message });
    }
  }
  console.log('[scriptedFlows] number → flow mapping', resolved);
  return byPhone;
}

// Resolve the scripted flow for a single number (either the business number a message
// was sent to, or the sender's own number), or null. Substring match tolerates
// +/country-code/formatting variance. When two registered numbers overlap (e.g.
// 9899860983 is a substring of the Kia 919899860983), the MOST SPECIFIC — longest —
// registered number wins, so the full number routes to its own flow rather than the
// shorter one that it contains.
function flowForPhone(byPhone, number) {
  const target = String(number);
  const byLongestFirst = [...byPhone.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [num, flow] of byLongestFirst) {
    if (target.includes(num)) return flow;
  }
  return null;
}

// Resolve the scripted flow by the WhatsApp Business ACCOUNT that received the message
// (webhook metadata.phone_number_id), matched against each flow's __accountId. Primary
// router: 1174719859057684 (Kia — owns the image_carousel_promo3 template) → Kia,
// 1200280473175726 (default) → Subway.
function flowForAccount(byPhone, businessPhoneNumberId) {
  if (!businessPhoneNumberId) return null;
  const id = String(businessPhoneNumberId);
  for (const flow of byPhone.values()) {
    if (flow.__accountId && String(flow.__accountId) === id) return flow;
  }
  return null;
}

// Resolve the scripted flow for an inbound message: prefer the business ACCOUNT the
// message was received on (metadata.phone_number_id), then fall back to matching the
// sender's number (kept from #30 — e.g. local/demo webhooks that carry no account id).
function flowForMessage(byPhone, { businessPhoneNumberId, senderNumber } = {}) {
  return flowForAccount(byPhone, businessPhoneNumberId) || flowForPhone(byPhone, senderNumber);
}

module.exports = { loadScriptedFlows, flowForPhone, flowForAccount, flowForMessage };
