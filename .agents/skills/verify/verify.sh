#!/usr/bin/env bash
# Isolated Pi print-mode harness for the cursor provider extension.
# Usage: verify.sh <prepare|doctor|models|reply|thinking|fast|tool|toolext|continue|sidereq|cleanup>
# Set VERIFY_RUN_ID to share one run across subcommands.
set -euo pipefail
umask 077

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$SCRIPT_DIR/../../.." && pwd)
VERIFY_RUN_ID=${VERIFY_RUN_ID:-$(date +%Y%m%dT%H%M%S)}
BASE="/tmp/pi-cursor-verify/${VERIFY_RUN_ID}"
RUN_DIR="$BASE/run"
AGENT_DIR="$RUN_DIR/agent"
SESSION_DIR="$RUN_DIR/sessions"
SCRATCH_DIR="$RUN_DIR/scratch"
EVIDENCE_DIR="$BASE/evidence"

SYSTEM_PROMPT='You are a concise assistant. Follow the user request exactly.'
PI_COMMON=(
  --no-extensions
  --no-skills
  --no-context-files
  --no-mcp
  --no-themes
  --no-prompt-templates
  --no-approve
  --no-session
  --session-dir "$SESSION_DIR"
  -e "$ROOT"
  --system-prompt "$SYSTEM_PROMPT"
  --mode json
)

usage() {
  echo "Usage: VERIFY_RUN_ID=<id> $0 <prepare|doctor|models|reply|thinking|fast|tool|toolext|continue|sidereq|cleanup>" >&2
  exit 2
}

load_env() {
  if [[ ! -f "$RUN_DIR/env.sh" ]]; then
    echo "No run state at $RUN_DIR. Run: VERIFY_RUN_ID=$VERIFY_RUN_ID $0 prepare" >&2
    exit 1
  fi
  # shellcheck disable=SC1091
  source "$RUN_DIR/env.sh"
}

require_node() {
  node -e '
    const [maj, min, pat] = process.versions.node.split(".").map(Number);
    const in24 = maj === 24 && (min > 22 || (min === 22 && pat >= 3));
    const in26 = maj > 26 || (maj === 26 && (min > 13 || (min === 13 && pat >= 1)));
    if (!in24 && !in26) {
      console.error("node " + process.versions.node + " does not satisfy >=24.22.3 <25 || >=26.13.1");
      process.exit(1);
    }
  '
}

redact_file() {
  local file=$1
  [[ -f "$file" && -f "$AGENT_DIR/auth.json" ]] || return 0
  python3 - "$AGENT_DIR/auth.json" "$file" <<'PY'
import json, sys
auth, path = sys.argv[1], sys.argv[2]
key = json.load(open(auth)).get("cursor", {}).get("key", "")
if not isinstance(key, str) or len(key) < 8:
    raise SystemExit(0)
file = open(path, errors="replace")
text = file.read()
file.close()
if key not in text:
    raise SystemExit(0)
open(path, "w").write(text.replace(key, "[redacted]"))
print(f"redacted api key in {path}")
PY
}

run_pi() {
  local outfile=$1 errfile=$2
  shift 2
  mkdir -p "$(dirname "$outfile")" "$(dirname "$errfile")"
  local status=0
  (
    cd "$SCRATCH_DIR"
    env -u CURSOR_API_KEY \
      PI_CODING_AGENT_DIR="$AGENT_DIR" \
      PI_SKIP_VERSION_CHECK=1 \
      "$@" >"$outfile" 2>"$errfile" &
    echo $! >"$RUN_DIR/pi.pid"
    wait $! || exit $?
  ) || status=$?
  rm -f "$RUN_DIR/pi.pid"
  redact_file "$outfile"
  redact_file "$errfile"
  return "$status"
}

list_models() {
  local outfile=$1
  mkdir -p "$(dirname "$outfile")" "$SCRATCH_DIR"
  (
    cd "$SCRATCH_DIR"
    env -u CURSOR_API_KEY \
      PI_CODING_AGENT_DIR="$AGENT_DIR" \
      PI_OFFLINE=1 \
      PI_SKIP_VERSION_CHECK=1 \
      pi --no-extensions --no-skills --no-context-files --no-mcp --no-themes --no-prompt-templates \
        --no-approve -e "$ROOT" --list-models 'cursor/'
  ) >"$outfile"
}

assert_model_table() {
  local table=$1
  python3 - "$table" "$CATALOG_MODE" <<'PY'
import sys
path, mode = sys.argv[1], sys.argv[2]
lines = [line.rstrip() for line in open(path) if line.strip()]
if not lines or not lines[0].startswith("provider"):
    raise SystemExit(f"model table missing header: {path}")
rows = []
for line in lines[1:]:
    parts = line.split()
    if len(parts) != 6:
        raise SystemExit(f"expected 6 columns, got {parts!r}")
    provider, model, context, max_out, thinking, images = parts
    if provider != "cursor":
        raise SystemExit(f"unexpected provider {provider}")
    if max_out != "16.4K" or images != "yes":
        raise SystemExit(f"{model} max-out={max_out} images={images}")
    if thinking not in {"yes", "no"}:
        raise SystemExit(f"{model} thinking={thinking}")
    rows.append((model, context, thinking))
known = {
    "composer-2.5": "200K",
    "default": "200K",
    "glm-5.2": "200K",
    "kimi-k2.7-code": "262.1K",
    "kimi-k3": "1.0M",
    "grok-4.5": "256K",
    "grok-4.6": "256K",
    "grok-4.7": "500K",
    "glm-5p3": "1M",
    "glm-5p3-flash": "1M",
    "deepseek-v41-flash-1017": "1.0M",
}
by_id = {model: (context, thinking) for model, context, thinking in rows}
if "grok-4.6" not in by_id:
    raise SystemExit("grok-4.6 missing")
if by_id["grok-4.6"][0] != "256K":
    raise SystemExit(f"grok-4.6 context {by_id['grok-4.6'][0]}")
for model, context, _thinking in rows:
    expect = known.get(model)
    if expect and context != expect:
        raise SystemExit(f"{model} context {context}, want {expect}")
if mode == "fallback":
    if rows != [("grok-4.6", "256K", "no")]:
        raise SystemExit(f"fallback table was {rows}")
elif mode == "remembered":
    if len(rows) < 2 or by_id["grok-4.6"][1] != "yes":
        raise SystemExit("saved catalog was not used; grok-4.6 did not publish thinking")
else:
    raise SystemExit(f"unknown catalog mode {mode}")
print(f"models={len(rows)} mode={mode} grok-4.6={by_id['grok-4.6'][0]} thinking={by_id['grok-4.6'][1]}")
PY
}

assert_reply() {
  local events=$1 expect_model=$2 expect_text=$3
  python3 - "$events" "$expect_model" "$expect_text" "$SCRATCH_DIR" <<'PY'
import json, os, sys
events, expect_model, expect_text, scratch = sys.argv[1:]
rows = [json.loads(line) for line in open(events) if line.strip()]
session = next((row for row in rows if row.get("type") == "session"), None)
if not session:
    raise SystemExit("no session header")
if os.path.realpath(session.get("cwd") or "") != os.path.realpath(scratch):
    raise SystemExit(f"cwd {session.get('cwd')!r} != scratch")
assistants = [
    row["message"] for row in rows
    if row.get("type") == "message_end" and row.get("message", {}).get("role") == "assistant"
]
if not assistants:
    raise SystemExit("no assistant message_end")
message = assistants[-1]
if message.get("provider") != "cursor" or message.get("model") != expect_model:
    raise SystemExit(f"model {message.get('provider')}/{message.get('model')}")
if message.get("stopReason") != "stop":
    raise SystemExit(f"stopReason {message.get('stopReason')}: {message.get('errorMessage')}")
texts = [
    block.get("text", "") for block in message.get("content") or []
    if isinstance(block, dict) and block.get("type") == "text"
]
text = "\n".join(texts).strip()
if expect_text.lower() not in text.lower():
    raise SystemExit(f"reply missing {expect_text!r}: {text!r}")
if len(text) > 200:
    raise SystemExit(f"reply longer than 200 characters: {text!r}")
settled = [row for row in rows if row.get("type") == "agent_settled"]
if not settled or settled[-1].get("aborted") is not False:
    raise SystemExit(f"agent_settled {settled[-1] if settled else None}")
usage = message.get("usage") or {}
cost = (usage.get("cost") or {}).get("total")
if isinstance(cost, (int, float)) and cost > 5:
    raise SystemExit(f"cost {cost} exceeds $5")
print(f"provider=cursor model={expect_model} stop=stop aborted=false cost={cost if cost is not None else 'unreported'}")
print("text=" + text)
PY
}

prepare() {
  require_node
  command -v pi >/dev/null
  command -v jq >/dev/null
  mkdir -p "$AGENT_DIR" "$SESSION_DIR" "$SCRATCH_DIR" "$EVIDENCE_DIR"
  chmod 700 "$BASE" "$RUN_DIR" "$AGENT_DIR" "$EVIDENCE_DIR"
  local catalog_mode=fallback
  if [[ -f "$HOME/.pi/agent/auth.json" ]]; then
    cp "$HOME/.pi/agent/auth.json" "$AGENT_DIR/auth.json"
    chmod 600 "$AGENT_DIR/auth.json"
  elif [[ -n "${CURSOR_API_KEY:-}" ]]; then
    python3 - "$AGENT_DIR/auth.json" <<'PY'
import json, os, sys
json.dump({"cursor": {"type": "api_key", "key": os.environ["CURSOR_API_KEY"]}}, open(sys.argv[1], "w"))
PY
    chmod 600 "$AGENT_DIR/auth.json"
  fi
  if [[ -f "$HOME/.pi/agent/cursor-sdk-model-list.json" && -f "$AGENT_DIR/auth.json" ]]; then
    cp "$HOME/.pi/agent/cursor-sdk-model-list.json" "$AGENT_DIR/cursor-sdk-model-list.json"
    chmod 600 "$AGENT_DIR/cursor-sdk-model-list.json"
    catalog_mode=remembered
  fi
  (cd "$ROOT" && npm run build)
  cat >"$RUN_DIR/env.sh" <<EOF
VERIFY_RUN_ID=$(printf '%q' "$VERIFY_RUN_ID")
ROOT=$(printf '%q' "$ROOT")
BASE=$(printf '%q' "$BASE")
RUN_DIR=$(printf '%q' "$RUN_DIR")
AGENT_DIR=$(printf '%q' "$AGENT_DIR")
SESSION_DIR=$(printf '%q' "$SESSION_DIR")
SCRATCH_DIR=$(printf '%q' "$SCRATCH_DIR")
EVIDENCE_DIR=$(printf '%q' "$EVIDENCE_DIR")
CATALOG_MODE=$(printf '%q' "$catalog_mode")
EOF
  echo "VERIFY_RUN_ID=$VERIFY_RUN_ID"
  echo "evidence=$EVIDENCE_DIR"
  echo "catalog=$catalog_mode"
}

doctor() {
  load_env
  require_node
  local pi_version node_version
  pi_version=$(pi --version)
  node_version=$(node -v)
  [[ -f "$ROOT/dist/index.js" ]]
  if [[ ! -f "$AGENT_DIR/auth.json" ]]; then
    echo "auth missing: copy ~/.pi/agent/auth.json or set CURSOR_API_KEY before prepare" >&2
    exit 1
  fi
  jq -e '.cursor.type == "api_key" and (.cursor.key | type == "string") and (.cursor.key | length > 0)' \
    "$AGENT_DIR/auth.json" >/dev/null
  list_models "$EVIDENCE_DIR/models.txt"
  local summary
  summary=$(assert_model_table "$EVIDENCE_DIR/models.txt")
  cat >"$EVIDENCE_DIR/doctor.txt" <<EOF
node $node_version
pi $pi_version
extension $ROOT/dist/index.js
auth api_key
agent_dir $AGENT_DIR
$summary
EOF
  cat "$EVIDENCE_DIR/doctor.txt"
}

models() {
  doctor
}

capture_sdk_runs() {
  local dest=$1 stop=$2 run_id=$3
  local tmpdir=${TMPDIR:-/tmp}
  mkdir -p "$dest"
  while [[ ! -f "$stop" ]]; do
    local dir name
    for dir in "$tmpdir"/pi-cursor-*; do
      [[ -d "$dir" && -f "$dir/agents.ndjson" ]] || continue
      grep -F -q "$run_id" "$dir/agents.ndjson" 2>/dev/null || continue
      name=$(basename "$dir")
      mkdir -p "$dest/$name"
      cp -f "$dir/agents.ndjson" "$dest/$name/agents.ndjson" 2>/dev/null || true
      if [[ -f "$dir/runs.ndjson" ]]; then
        cp -f "$dir/runs.ndjson" "$dest/$name/runs.ndjson" 2>/dev/null || true
      fi
    done
    sleep 0.2
  done
}

assert_fast_off() {
  local store=$1
  python3 - "$store" <<'PY'
import json, sys
from pathlib import Path
root = Path(sys.argv[1])
files = sorted(root.glob("*/runs.ndjson"))
if not files:
    raise SystemExit(f"no runs.ndjson under {root}")
selections = []
fast_values = []

def walk(value):
    if isinstance(value, dict):
        if value.get("id") == "fast" and "value" in value:
            fast_values.append(value.get("value"))
        if value.get("id") == "grok-4.6" and isinstance(value.get("params"), list):
            selections.append(value)
        for item in value.values():
            walk(item)
    elif isinstance(value, list):
        for item in value:
            walk(item)

for path in files:
    for line in path.read_text(errors="replace").splitlines():
        if not line.strip():
            continue
        try:
            walk(json.loads(line))
        except json.JSONDecodeError:
            continue
if any(value == "true" for value in fast_values):
    raise SystemExit("fast=true in captured run")
matched = [
    selection for selection in selections
    if any(param.get("id") == "fast" and param.get("value") == "false" for param in selection["params"])
]
if not matched:
    raise SystemExit("no grok-4.6 selection with fast=false")
print(f"fast=false model=grok-4.6 selections={len(matched)}")
PY
}

require_fast_catalog() {
  if [[ "$CATALOG_MODE" != "remembered" ]]; then
    echo "unmet precondition: saved Cursor catalog is required so grok-4.6 lists fast" >&2
    exit 2
  fi
  local status=0 note
  note=$(python3 - "$AGENT_DIR/cursor-sdk-model-list.json" <<'PY'
import json, sys
raw = json.load(open(sys.argv[1]))
models = raw.get("models") if isinstance(raw, dict) else raw
grok = next((item for item in models if item.get("id") == "grok-4.6"), None)
if grok is None:
    raise SystemExit("saved catalog has no grok-4.6")
fast = next((item for item in grok.get("parameters") or [] if item.get("id") == "fast"), None)
values = {entry.get("value") for entry in (fast or {}).get("values") or []}
if "false" not in values:
    raise SystemExit("saved catalog has no fast=false for grok-4.6")
print("catalog fast=false model=grok-4.6")
PY
) || status=$?
  if [[ "$status" -ne 0 ]]; then
    echo "unmet precondition: ${note}" >&2
    exit 2
  fi
  echo "$note"
}

fast() {
  load_env
  doctor >/dev/null
  require_fast_catalog
  local out="$EVIDENCE_DIR/fast/events.jsonl"
  local err="$EVIDENCE_DIR/fast/stderr.txt"
  local stop="$EVIDENCE_DIR/fast/watch.stop"
  local store="$EVIDENCE_DIR/fast/store"
  rm -rf "$store"
  rm -f "$stop"
  mkdir -p "$EVIDENCE_DIR/fast"
  capture_sdk_runs "$store" "$stop" "$VERIFY_RUN_ID" &
  local watch_pid=$!
  local status=0
  run_pi "$out" "$err" \
    pi "${PI_COMMON[@]}" --no-tools --model cursor/grok-4.6 --thinking low -p -- \
    "Reply with the single word pong." || status=$?
  touch "$stop"
  wait "$watch_pid" || true
  redact_file "$out"
  redact_file "$err"
  if [[ -d "$store" ]]; then
    local copied
    while IFS= read -r copied; do
      redact_file "$copied"
    done < <(find "$store" -type f -print)
  fi
  echo "exit=$status" | tee "$EVIDENCE_DIR/fast/meta.txt"
  if [[ "$status" -ne 0 ]]; then
    cat "$err" >&2
    exit "$status"
  fi
  assert_reply "$out" "grok-4.6" "pong" | tee -a "$EVIDENCE_DIR/fast/meta.txt"
  assert_fast_off "$store" | tee -a "$EVIDENCE_DIR/fast/meta.txt"
}

reply() {
  load_env
  doctor >/dev/null
  local out="$EVIDENCE_DIR/reply/events.jsonl"
  local err="$EVIDENCE_DIR/reply/stderr.txt"
  local status=0
  run_pi "$out" "$err" \
    pi "${PI_COMMON[@]}" --no-tools --model cursor/grok-4.6 --thinking off -p -- \
    "Reply with the single word pong." || status=$?
  echo "exit=$status" | tee "$EVIDENCE_DIR/reply/meta.txt"
  if [[ "$status" -ne 0 ]]; then
    echo "pi exit $status" >&2
    cat "$err" >&2
    exit "$status"
  fi
  assert_reply "$out" "grok-4.6" "pong" | tee -a "$EVIDENCE_DIR/reply/meta.txt"
}

thinking() {
  load_env
  doctor >/dev/null
  if [[ "$CATALOG_MODE" != "remembered" ]]; then
    echo "unmet precondition: saved Cursor catalog is required so grok-4.6 publishes thinking" >&2
    exit 2
  fi
  local out="$EVIDENCE_DIR/thinking/events.jsonl"
  local err="$EVIDENCE_DIR/thinking/stderr.txt"
  local status=0
  run_pi "$out" "$err" \
    pi "${PI_COMMON[@]}" --no-tools --model cursor/grok-4.6 --thinking low -p -- \
    "Reply with the single word pong." || status=$?
  echo "exit=$status" | tee "$EVIDENCE_DIR/thinking/meta.txt"
  if [[ "$status" -ne 0 ]]; then
    cat "$err" >&2
    exit "$status"
  fi
  assert_reply "$out" "grok-4.6" "pong" | tee -a "$EVIDENCE_DIR/thinking/meta.txt"
}

tool() {
  load_env
  doctor >/dev/null
  printf 'verify-marker\n' >"$SCRATCH_DIR/marker.txt"
  local out="$EVIDENCE_DIR/tool/events.jsonl"
  local err="$EVIDENCE_DIR/tool/stderr.txt"
  local status=0
  run_pi "$out" "$err" \
    pi "${PI_COMMON[@]}" --tools read --model cursor/grok-4.6 --thinking off -p -- \
    "Read marker.txt and reply with its exact contents." || status=$?
  echo "exit=$status" | tee "$EVIDENCE_DIR/tool/meta.txt"
  if [[ "$status" -ne 0 ]]; then
    cat "$err" >&2
    exit "$status"
  fi
  python3 - "$out" "$SCRATCH_DIR" <<'PY'
import json, os, sys
events, scratch = sys.argv[1:]
rows = [json.loads(line) for line in open(events) if line.strip()]
session_cwd = next((row.get("cwd") for row in rows if row.get("type") == "session"), "")
if os.path.realpath(session_cwd or "") != os.path.realpath(scratch):
    raise SystemExit("tool run cwd is not the scratch dir")
ends = [row for row in rows if row.get("type") == "tool_execution_end" and row.get("toolName") == "read"]
if not ends or ends[-1].get("isError") is not False:
    raise SystemExit("read tool did not finish successfully")
assistants = [
    row["message"] for row in rows
    if row.get("type") == "message_end" and row.get("message", {}).get("role") == "assistant"
]
text = ""
for block in assistants[-1].get("content") or []:
    if isinstance(block, dict) and block.get("type") == "text":
        text += block.get("text", "")
if "verify-marker" not in text:
    raise SystemExit(f"reply missing marker: {text!r}")
print("tool=read isError=false text-has=verify-marker")
PY
}

toolext() {
  load_env
  doctor >/dev/null
  local out="$EVIDENCE_DIR/toolext/events.jsonl"
  local err="$EVIDENCE_DIR/toolext/stderr.txt"
  local status=0
  run_pi "$out" "$err" \
    pi "${PI_COMMON[@]}" -e "$ROOT/.agents/skills/verify/fixture-tool.ts" \
    --tools fixture_marker --model cursor/grok-4.6 --thinking off -p -- \
    "Call the fixture_marker tool, then reply with exactly what it returned." || status=$?
  echo "exit=$status" | tee "$EVIDENCE_DIR/toolext/meta.txt"
  if [[ "$status" -ne 0 ]]; then
    cat "$err" >&2
    exit "$status"
  fi
  python3 - "$out" "$SCRATCH_DIR" <<'PY'
import json, os, sys
events, scratch = sys.argv[1:]
rows = [json.loads(line) for line in open(events) if line.strip()]
session_cwd = next((row.get("cwd") for row in rows if row.get("type") == "session"), "")
if os.path.realpath(session_cwd or "") != os.path.realpath(scratch):
    raise SystemExit("toolext run cwd is not the scratch dir")
ends = [row for row in rows if row.get("type") == "tool_execution_end" and row.get("toolName") == "fixture_marker"]
if not ends or ends[-1].get("isError") is not False:
    raise SystemExit("fixture_marker tool did not finish successfully")
assistants = [
    row["message"] for row in rows
    if row.get("type") == "message_end" and row.get("message", {}).get("role") == "assistant"
]
text = ""
for block in assistants[-1].get("content") or []:
    if isinstance(block, dict) and block.get("type") == "text":
        text += block.get("text", "")
if "fixture-marker" not in text:
    raise SystemExit(f"reply missing fixture marker: {text!r}")
print("tool=fixture_marker isError=false text-has=fixture-marker")
PY
}

continue_run() {
  load_env
  doctor >/dev/null
  local out="$EVIDENCE_DIR/continue/events.jsonl"
  local err="$EVIDENCE_DIR/continue/stderr.txt"
  local status=0
  run_pi "$out" "$err" \
    pi "${PI_COMMON[@]}" --no-tools --model cursor/grok-4.6 --thinking off -p -- \
    "The code word is amber." \
    "Reply with the code word only." || status=$?
  echo "exit=$status" | tee "$EVIDENCE_DIR/continue/meta.txt"
  if [[ "$status" -ne 0 ]]; then
    cat "$err" >&2
    exit "$status"
  fi
  python3 - "$out" <<'PY' | tee -a "$EVIDENCE_DIR/continue/meta.txt"
import json, sys
rows = [json.loads(line) for line in open(sys.argv[1]) if line.strip()]
def user_text(message):
    content = message.get("content")
    if isinstance(content, str):
        return content
    parts = []
    for block in content or []:
        if isinstance(block, dict) and block.get("type") == "text":
            parts.append(block.get("text", ""))
    return "".join(parts)

users = [
    user_text(row.get("message") or {})
    for row in rows
    if row.get("type") == "message_end" and (row.get("message") or {}).get("role") == "user"
]
if users[:2] != ["The code word is amber.", "Reply with the code word only."]:
    raise SystemExit(f"user messages {users!r}")
assistants = [
    row["message"] for row in rows
    if row.get("type") == "message_end" and row.get("message", {}).get("role") == "assistant"
]
if len(assistants) < 2:
    raise SystemExit(f"expected two assistant replies, got {len(assistants)}")
text = ""
for block in assistants[-1].get("content") or []:
    if isinstance(block, dict) and block.get("type") == "text":
        text += block.get("text", "")
if "amber" not in text.lower():
    raise SystemExit(f"second reply missing amber: {text!r}")
usage = [m.get("usage") or {} for m in assistants]
first_in = usage[0].get("input") or 0
second = usage[-1]
second_in = second.get("input") or 0
second_cache = second.get("cacheRead") or 0
if not (second_in < first_in and second_cache > 0):
    raise SystemExit(
        f"second turn usage does not show agent reuse: "
        f"first input={first_in}, second input={second_in}, cacheRead={second_cache}"
    )
hit = second_cache / (second_cache + second_in) * 100 if second_cache + second_in else 0
print(
    f"users=2 second-text-has=amber reuse=input:{second_in}<{first_in} "
    f"cacheRead={second_cache} hit={hit:.1f}%"
)
PY
  assert_reply "$out" "grok-4.6" "amber" | tee -a "$EVIDENCE_DIR/continue/meta.txt"
}

sidereq() {
  load_env
  doctor >/dev/null
  local out="$EVIDENCE_DIR/side-request/result.json"
  local err="$EVIDENCE_DIR/side-request/stderr.txt"
  local status=0
  run_pi "$out" "$err" \
    node "$ROOT/.agents/skills/verify/side-request-driver.mjs" "$ROOT" || status=$?
  echo "exit=$status" | tee "$EVIDENCE_DIR/side-request/meta.txt"
  if [[ "$status" -ne 0 ]]; then
    cat "$err" >&2
    exit "$status"
  fi
  python3 - "$out" <<'PY' | tee -a "$EVIDENCE_DIR/side-request/meta.txt"
import json, sys
lines = [line for line in open(sys.argv[1]) if line.strip()]
if not lines:
    raise SystemExit("driver wrote no output")
record = json.loads(lines[-1])
result = record.get("result") or {}
if result.get("stopReason") != "stop":
    raise SystemExit(f"stopReason {result.get('stopReason')}: {result.get('errorMessage')}")
text = (result.get("text") or "").strip()
if "pong" not in text.lower():
    raise SystemExit(f"reply missing 'pong': {text!r}")
if len(text) > 200:
    raise SystemExit(f"reply longer than 200 characters: {text!r}")
leftover = record.get("leftover") or []
if leftover:
    raise SystemExit(f"side store not removed: {leftover}")
print(f"stop=stop leftover=0 text={text}")
PY
}

cleanup() {
  if [[ -f "$RUN_DIR/pi.pid" ]]; then
    local pid
    pid=$(cat "$RUN_DIR/pi.pid")
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  fi
  rm -rf "$RUN_DIR"
  echo "removed $RUN_DIR"
  echo "kept $EVIDENCE_DIR"
}

cmd=${1:-}
case "$cmd" in
  prepare) prepare ;;
  doctor) doctor ;;
  models) models ;;
  reply) reply ;;
  thinking) thinking ;;
  fast) fast ;;
  tool) tool ;;
  toolext) toolext ;;
  continue) continue_run ;;
  sidereq) sidereq ;;
  cleanup) cleanup ;;
  *) usage ;;
esac
