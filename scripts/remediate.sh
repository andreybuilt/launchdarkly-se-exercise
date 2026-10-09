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
# or, to keep the URL off the command line entirely, save it to a file and
# point LD_TRIGGER_URL_FILE at it (defaults to ./trigger_url):
#   LD_TRIGGER_URL_FILE=./trigger_url ./scripts/remediate.sh
# `npm run remediate` does the first form automatically from .env.
#
# The trigger URL comes from scripts/setup-launchdarkly.mjs's output
# (ensureRemediationTrigger). Treat it like a secret: anyone who has the
# URL can flip the flag, LaunchDarkly does not ask for further auth on
# trigger invocation. It never appears as a command-line argument here
# (anyone on the box could read it out of the process list with ps) and
# this script never writes it, or the response it gets back, to /tmp.

set -euo pipefail

trigger_url="${LD_TRIGGER_URL:-}"

if [[ -z "$trigger_url" ]]; then
  trigger_file="${LD_TRIGGER_URL_FILE:-./trigger_url}"
  if [[ -f "$trigger_file" ]]; then
    trigger_url="$(cat "$trigger_file")"
  fi
fi

if [[ -z "$trigger_url" ]]; then
  echo "LD_TRIGGER_URL is not set, and no trigger file was found." >&2
  echo "Run scripts/setup-launchdarkly.mjs first and either:" >&2
  echo '  LD_TRIGGER_URL="https://app.launchdarkly.com/webhook/triggers/xxxxx" ./scripts/remediate.sh' >&2
  echo "or save the printed URL to the file named by LD_TRIGGER_URL_FILE (default ./trigger_url)." >&2
  exit 1
fi

echo "Firing LaunchDarkly trigger to turn OFF release-new-checkout-banner..."

# curl --config - reads its options from stdin instead of argv, so the URL
# never shows up in `ps`/process-list output the way
# `curl -X POST "$trigger_url"` would. The config format is one directive
# per line; "url" and "request" here are the only two needed. -w appends
# the HTTP status after a newline so it can be split back out below,
# avoiding a second file (or /tmp) just to hold the response body.
response="$(curl -sS --config - -w $'\n%{http_code}' <<CURLCFG
url = "$trigger_url"
request = "POST"
CURLCFG
)"
http_status="${response##*$'\n'}"
body="${response%$'\n'*}"

echo "HTTP status: $http_status"
echo "$body"

if [[ "$http_status" -ge 200 && "$http_status" -lt 300 ]]; then
  echo "Trigger fired. The flag should now be off; the running app's browser tab"
  echo "updates instantly via the change:release-new-checkout-banner listener, no reload."
else
  echo "Trigger call did not return a 2xx status. Check the URL and try again." >&2
  exit 1
fi
