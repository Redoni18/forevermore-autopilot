#!/usr/bin/env bash
# Fake `claude` CLI shim for autopilot/test/brain/claude-cli.test.mjs.
#
# Emulates: claude -p <prompt> --output-format json [--model M] --allowedTools ""
# It prints a JSON envelope of the same shape the real CLI 2.1.205 emits (see the
# `result` / `usage` / `total_cost_usd` fields the driver reads).
#
# Behaviour is selected by the FAKE_CLAUDE_MODE env var:
#   happy               → one valid copywriter envelope (default)
#   error               → prints to stderr and exits non-zero (CLI-failure path)
#   invalid_then_valid  → invalid JSON first, then valid once the driver's
#                         CORRECTIVE-RETRY marker appears in the prompt (retry path)
#   always_invalid      → invalid JSON every time (retry-exhaustion path)
set -u

here="$(cd "$(dirname "$0")" && pwd)"
mode="${FAKE_CLAUDE_MODE:-happy}"

# Recover the prompt: the argument immediately following `-p`.
prompt=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-p" ]; then prompt="$a"; fi
  prev="$a"
done

# Build a real CLI envelope with `result` correctly JSON-escaped from a raw file.
# node is always available in this repo, so we lean on it for reliable escaping.
emit() {
  node -e '
    const fs = require("fs");
    const result = fs.readFileSync(process.argv[1], "utf8");
    process.stdout.write(JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result,
      session_id: "fake-session",
      total_cost_usd: 0.0123,
      usage: { input_tokens: 1234, output_tokens: 210 },
      modelUsage: { "claude-sonnet-4-5-fake": { inputTokens: 1234, outputTokens: 210, costUSD: 0.0123 } }
    }));
  ' "$1"
}

case "$mode" in
  error)
    echo "fake-claude: simulated CLI failure (exit 2)" 1>&2
    exit 2
    ;;
  invalid_then_valid)
    case "$prompt" in
      *CORRECTIVE-RETRY*) emit "$here/envelopes/copywriter-result-valid.txt" ;;
      *) emit "$here/envelopes/copywriter-result-invalid.txt" ;;
    esac
    ;;
  always_invalid)
    emit "$here/envelopes/copywriter-result-invalid.txt"
    ;;
  happy | *)
    emit "$here/envelopes/copywriter-result-valid.txt"
    ;;
esac
