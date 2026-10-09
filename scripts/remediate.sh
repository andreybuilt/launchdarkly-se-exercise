#!/usr/bin/env bash
# scripts/remediate.sh
#
# Fires the LaunchDarkly flag trigger that turns off
# "release-new-checkout-banner". In a real incident this URL would be
# called by a monitoring/alerting system (Datadog, PagerDuty, a
# synthetic check, etc.) the moment the new checkout banner is implicated
# in a problem, no human needs to open the LaunchDarkly dashboard.
#
# For this take home exercise, it is called manually with curl to
# demonstrate the remediation path end to end.
#
# Usage:
#   LD_TRIGGER_URL="https://app.launchdarkly.com/webhook/triggers/xxxxx" ./scripts/remediate.sh
#
# The trigger URL comes from scripts/setup-launchdarkly.mjs's output
# (ensureRemediationTrigger). Treat it like a secret: anyone who has the
# URL can flip the flag, LaunchDarkly does not ask for further auth on
# trigger invocation.

set -euo pipefail

if [[ -z "${LD_TRIGGER_URL:-}" ]]; then
  echo "LD_TRIGGER_URL is not set." >&2
  echo "Run scripts/setup-launchdarkly.mjs first and copy the printed trigger URL, then:" >&2
  echo '  LD_TRIGGER_URL="https://app.launchdarkly.com/webhook/triggers/xxxxx" ./scripts/remediate.sh' >&2
  exit 1
fi

echo "Firing LaunchDarkly trigger to turn OFF release-new-checkout-banner..."

# Flag triggers are invoked with a plain POST, no request body or
# authentication header required beyond the secret URL itself.
http_status=$(curl -sS -o /tmp/ld-trigger-response.json -w '%{http_code}' -X POST "$LD_TRIGGER_URL")

echo "HTTP status: $http_status"
cat /tmp/ld-trigger-response.json 2>/dev/null || true
echo

if [[ "$http_status" -ge 200 && "$http_status" -lt 300 ]]; then
  echo "Trigger fired. The flag should now be off; the running app's browser tab"
  echo "updates instantly via the change:release-new-checkout-banner listener, no reload."
else
  echo "Trigger call did not return a 2xx status. Check the URL and try again." >&2
  exit 1
fi
