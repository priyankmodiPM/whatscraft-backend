#!/usr/bin/env bash
# Drives the Subway "Finals Week" scripted flow against a running webhook, one step
# at a time. This flow is fully deterministic (no LLM) — the server replies from
# data/subway-finals-week.json. Watch the server logs for the outbound sends.
#
# The sender number is configurable and MUST match whichever number Subway is bound
# to (data/flow-routing.json → "subway", or SUBWAY_PHONE). WhatsApp delivers the SIM
# +91-98998-60983 as the full "919899860983" — that's the default here, matching the
# single-SIM test config in flow-routing.json.
#
# Usage:  yarn start           # one terminal (routing file binds Subway → 919899860983)
#         bash demo-subway-flow.sh   # another terminal
#         BASE_URL=http://localhost:3000 PHONE=919899860983 PAUSE=3 bash demo-subway-flow.sh

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
PHONE="${PHONE:-${SUBWAY_PHONE:-919899860983}}"
PAUSE="${PAUSE:-10}"
# Routing is by the RECEIVING business account (metadata.phone_number_id). ACCOUNT_ID
# defaults to the Subway business account id; sender (PHONE) is arbitrary.
ACCOUNT_ID="${ACCOUNT_ID:-${WHATSAPP_PHONE_NUMBER_ID:-1174719859057684}}"

# Send a free-text WhatsApp message.
send() {
  echo ">>> [text] $1"
  curl -s -X POST "$BASE_URL/" -H 'Content-Type: application/json' -d "$(cat <<JSON
{"object":"whatsapp_business_account","entry":[{"changes":[{"value":{"metadata":{"phone_number_id":"$ACCOUNT_ID"},"messages":[
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
{"object":"whatsapp_business_account","entry":[{"changes":[{"value":{"metadata":{"phone_number_id":"$ACCOUNT_ID"},"messages":[
{"from":"$PHONE","type":"interactive","interactive":{"type":"button_reply","button_reply":{"id":"qr:$1","title":"$1"}}}]}}]}]}
JSON
)" >/dev/null
  echo "    (200 ack — check server logs)"
  echo
}

echo "=== Subway 'Finals Week' flow → $BASE_URL  (sender: $PHONE) ==="
echo "    (server gates Subway to $PHONE — default needs no env; else SUBWAY_PHONE=$PHONE)"
echo

# 0) Any first message kicks it off → WC sends banner v1 + [Edit] [Send as-is]
send "hi"
sleep "$PAUSE"

# 1) Tap Edit → WC asks what to change
tap "✏️ Edit"
sleep "$PAUSE"

# 2) Describe the combo (free text) → WC builds v2 + suggests ₹250 [buttons]
send "I have a lot of chicken in stock — do a chicken tikka sub combo: Sub + Cookie + Cold Drink, match-day special"
sleep "$PAUSE"

# 3) Accept the price → WC renders v3 (match-day pricing)
tap "✅ Yes, ₹250"
sleep "$PAUSE"

# 4) Ask for a gluten-free tag (free text) → WC blocks it, offers 3 accurate options [buttons]
send "Add a Gluten Free tag in the corner — my gym crowd keeps asking"
sleep "$PAUSE"

# 5) Swap the bread → WC renders v4 (gluten-free base + cookie caveat) + channel picker [buttons]
tap "🥖 Swap to GF base"
sleep "$PAUSE"

# 6) Send on both channels → WC confirms, flow ends
tap "🔀 Dono"

echo "=== done — verify banners v1→v4 and the final confirmation in the server logs ==="
