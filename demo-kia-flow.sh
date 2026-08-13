#!/usr/bin/env bash
# Drives the Kia "Seltos follow-up" scripted flow against a running webhook, one step
# at a time. This flow is fully deterministic (no LLM) — the server replies from
# data/kia-seltos-followup.json. Watch the server logs for the outbound sends.
#
# The sender number is configurable. IMPORTANT: the server gates this flow to
# KIA_PHONE (default 919899860983), so start the server with the SAME number you pass
# here. For a one-number test, point KIA_PHONE at your test number and run:
#
#   KIA_PHONE=<your-number> yarn start        # in one terminal
#   PHONE=<your-number> bash demo-kia-flow.sh # in another
#
# Usage:  bash demo-kia-flow.sh
#         BASE_URL=http://localhost:3000 PHONE=919899860983 PAUSE=3 bash demo-kia-flow.sh

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
PHONE="${PHONE:-${KIA_PHONE:-919899860983}}"
PAUSE="${PAUSE:-10}"

# Send a free-text WhatsApp message.
send() {
  echo ">>> [text] $1"
  curl -s -X POST "$BASE_URL/" -H 'Content-Type: application/json' -d "$(cat <<JSON
{"object":"whatsapp_business_account","entry":[{"changes":[{"value":{"messages":[
{"from":"$PHONE","type":"text","text":{"body":"$1"}}]}}]}]}
JSON
)" >/dev/null
  echo "    (200 ack — check server logs)"
  echo
}

# Tap a reply button (WhatsApp interactive button_reply). Arg = button title.
tap() {
  echo ">>> [tap button] $1"
  curl -s -X POST "$BASE_URL/" -H 'Content-Type: application/json' -d "$(cat <<JSON
{"object":"whatsapp_business_account","entry":[{"changes":[{"value":{"messages":[
{"from":"$PHONE","type":"interactive","interactive":{"type":"button_reply","button_reply":{"id":"qr:$1","title":"$1"}}}]}}]}]}
JSON
)" >/dev/null
  echo "    (200 ack — check server logs)"
  echo
}

# Tap a carousel-template card's quick-reply button. Arg = payload (e.g. OFFER_INSURANCE).
tap_card() {
  echo ">>> [tap carousel card] $1"
  curl -s -X POST "$BASE_URL/" -H 'Content-Type: application/json' -d "$(cat <<JSON
{"object":"whatsapp_business_account","entry":[{"changes":[{"value":{"messages":[
{"from":"$PHONE","type":"button","button":{"payload":"$1","text":"Select"}}]}}]}]}
JSON
)" >/dev/null
  echo "    (200 ack — check server logs)"
  echo
}

echo "=== Kia 'Seltos follow-up' flow → $BASE_URL  (sender: $PHONE) ==="
echo "    (server must be running with KIA_PHONE=$PHONE)"
echo

# 0) Any first message kicks it off → WC surfaces the stale lead [Yes, follow up / Not now]
send "hi"
sleep "$PAUSE"

# 1) Follow up → WC pulls Apoorva's profile and shows 3 offer banners [pick one]
tap "✅ Yes, follow up"
sleep "$PAUSE"

# 2) Pick an offer from the carousel → WC proactively offers to add the exchange bonus
tap_card "OFFER_INSURANCE"
sleep "$PAUSE"

# 3) Add exchange bonus → WC asks whether to add the salesman's contact
tap "✅ Yes, add it"
sleep "$PAUSE"

# 4) Add contact → WC asks "anything else?"
tap "✅ Yes, add it"
sleep "$PAUSE"

# 5) Anything else (free text) → WC generates the first banner (streamed progress → preview)
send "She wanted the 3-Yr Comprehensive insurance plan"
sleep "$PAUSE"

# 6) Localize (free text) → WC re-renders in Hindi with the final on-road price (final)
send "One more — Apoorva prefers Hindi. Generate it in Hindi, and add the final on-road price."

echo "=== done — verify the 3 offers, preview + final Hindi/on-road banner in the server logs ==="
