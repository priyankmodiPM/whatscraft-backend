// ── Scripted-flow registry ────────────────────────────────────────────────────
// Loads the data-defined scripted demo flows (Subway, Kia) and exposes a lookup by
// the sender's WhatsApp number. Each flow is gated to a single demo phone that runs
// the fixed script (src/scriptedFlow.js) and never reaches the LLM; any other number
// falls through to the existing behaviour.
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
const FLOW_DEFS = [
  { key: 'subway', phoneEnv: 'SUBWAY_PHONE', fileEnv: 'SUBWAY_FLOW_FILE', default: '918328145692', file: 'subway-finals-week.json' },
  { key: 'kia', phoneEnv: 'KIA_PHONE', fileEnv: 'KIA_FLOW_FILE', default: '919899860983', file: 'kia-seltos-followup.json' },
];

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
      byPhone.set(phone, flow);
      resolved[def.key] = phone;
    } catch (err) {
      console.error('[scriptedFlows] failed to load flow', { key: def.key, file: filePath, message: err.message });
    }
  }
  console.log('[scriptedFlows] number → flow mapping', resolved);
  return byPhone;
}

// Resolve the scripted flow for an inbound sender, or null. Substring match (like the
// existing Flow-2 gate) tolerates the +/country-code/formatting variance in `from`.
// When two registered numbers overlap (e.g. 9899860983 is a substring of the Kia
// 919899860983), the MOST SPECIFIC — longest — registered number wins, so the full
// number routes to its own flow rather than the shorter one that it contains.
function flowForPhone(byPhone, phoneNumber) {
  const from = String(phoneNumber);
  const byLongestFirst = [...byPhone.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [num, flow] of byLongestFirst) {
    if (from.includes(num)) return flow;
  }
  return null;
}

module.exports = { loadScriptedFlows, flowForPhone };
