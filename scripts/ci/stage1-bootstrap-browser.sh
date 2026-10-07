#!/usr/bin/env bash
set -euo pipefail
# Raw W3C replies and session IDs stay in shell memory. Neither server
# output nor browser/performance/driver logs are recorded, even on failure.
exec 3>&1
exec 2>/dev/null
session_id=''
vite_pid=''
driver_pid=''
browser_stage='runtime-copy'
cleanup() {
  if [ -n "$session_id" ]; then
    curl --silent --max-time 10 -X DELETE "http://127.0.0.1:9515/session/$session_id" \
      >/dev/null || true
  fi
  if [ -n "$vite_pid" ]; then kill "$vite_pid" 2>/dev/null || true; fi
  if [ -n "$driver_pid" ]; then kill "$driver_pid" 2>/dev/null || true; fi
}
finish() {
  browser_code=$?
  cleanup
  set +e
  python3 ../validation-source/scripts/ci/stage1-bootstrap-validation.py safe-result "$browser_code" \
    "candidate-$BOOTSTRAP_CANDIDATE_ARTIFACT-browser" "$browser_stage" 2>&3
  projection_code=$?
  if [ "$browser_code" -ne 0 ]; then exit "$browser_code"; fi
  exit "$projection_code"
}
trap finish EXIT
trap 'printf "{\"error\":\"browser-command-failed\"}\n"' ERR
cp "$RUNNER_TEMP/bootstrap-bindgen-$BOOTSTRAP_CANDIDATE_ARTIFACT/engine_wasm.js" client/src/wasm/engine_wasm.js 2>&3
cp "$RUNNER_TEMP/bootstrap-bindgen-$BOOTSTRAP_CANDIDATE_ARTIFACT/engine_wasm_bg.wasm" client/src/wasm/engine_wasm_bg.wasm 2>&3
if [ -d "$RUNNER_TEMP/bootstrap-bindgen-$BOOTSTRAP_CANDIDATE_ARTIFACT/snippets" ]; then cp -R "$RUNNER_TEMP/bootstrap-bindgen-$BOOTSTRAP_CANDIDATE_ARTIFACT/snippets" client/src/wasm/ 2>&3; fi
browser_stage='server-start'
TELEMETRY_URL='' pnpm --dir client dev --host 127.0.0.1 --port 5173 --strictPort \
  >/dev/null 2>&1 &
vite_pid=$!
CHROME_LOG_FILE=/dev/null "$BOOTSTRAP_CHROMEDRIVER" --port=9515 --log-path=/dev/null \
  >/dev/null 2>&1 &
driver_pid=$!
# One bounded startup interval and one preflight request; no polling or retry.
sleep 5
browser_stage='server-ready'
kill -0 "$vite_pid" "$driver_pid" 2>&3
driver_status=$(curl --fail --silent --max-time 10 http://127.0.0.1:9515/status)
printf '%s' "$driver_status" | jq -e '.value.ready == true' >/dev/null
browser_stage='served-identity'
served_glue_hash=$(curl --fail --silent --max-time 30 http://127.0.0.1:5173/src/wasm/engine_wasm.js \
  | sha256sum 2>&3 | cut -d ' ' -f 1 2>&3)
served_wasm_hash=$(curl --fail --silent --max-time 30 http://127.0.0.1:5173/src/wasm/engine_wasm_bg.wasm \
  | sha256sum 2>&3 | cut -d ' ' -f 1 2>&3)
wasm_hash=$(sha256sum client/src/wasm/engine_wasm_bg.wasm 2>&3 | cut -d ' ' -f 1 2>&3)
glue_hash=$(sha256sum client/src/wasm/engine_wasm.js 2>&3 | cut -d ' ' -f 1 2>&3)
test "$served_wasm_hash" = "$wasm_hash"
printf '%s  served-engine-glue\n%s  served-engine-wasm\n' "$served_glue_hash" "$served_wasm_hash" \
  > "$MANUAL_EVIDENCE/served-artifacts.sha256" 2>&3
browser_stage='source-identity'
baseline_tree=$(git -C ../baseline-source rev-parse HEAD^{tree} 2>&3)
candidate_tree=$(git rev-parse HEAD^{tree} 2>&3)
url="http://127.0.0.1:5173/manual-resolution-wasm-worker.html?artifact=$BOOTSTRAP_CANDIDATE_ARTIFACT&baseline_sha=$BOOTSTRAP_BASE_SHA&candidate_sha=$MANUAL_EXPECTED_SOURCE_SHA&baseline_tree=$baseline_tree&candidate_tree=$candidate_tree&wasm_sha256=$wasm_hash&glue_sha256=$glue_hash&served_glue_sha256=$served_glue_hash"
browser_stage='session-create'
session_response=$(jq -n --arg binary "$(command -v google-chrome)" \
  '{capabilities:{alwaysMatch:{browserName:"chrome","goog:chromeOptions":{binary:$binary,args:["--headless=new","--no-sandbox","--disable-dev-shm-usage","--disable-logging","--log-level=3"]},"goog:loggingPrefs":{browser:"OFF",performance:"OFF"}}}}' \
  | curl --fail --silent --max-time 60 -H 'Content-Type: application/json' \
    --data-binary @- http://127.0.0.1:9515/session)
session_id=$(printf '%s' "$session_response" \
  | jq -er '.value.sessionId | select(type == "string" and test("^[a-zA-Z0-9-]+$"))')
browser_stage='session-timeouts'
timeouts_response=$(jq -n '{script:130000,pageLoad:60000,implicit:0}' \
  | curl --fail --silent --max-time 10 -H 'Content-Type: application/json' \
    --data-binary @- "http://127.0.0.1:9515/session/$session_id/timeouts")
printf '%s' "$timeouts_response" | jq -e '.value == null' >/dev/null
browser_stage='navigation'
navigation_response=$(jq -n --arg url "$url" '{url:$url}' \
  | curl --fail --silent --max-time 65 -H 'Content-Type: application/json' \
    --data-binary @- "http://127.0.0.1:9515/session/$session_id/url")
printf '%s' "$navigation_response" | jq -e '.value == null' >/dev/null
browser_stage='page-completion'
terminal_response=$(jq -n '{script:"const done = arguments[arguments.length - 1]; window.manualWasmBootstrap.completionPromise.then(done);",args:[]}' \
  | curl --fail --silent --max-time 140 -H 'Content-Type: application/json' \
    --data-binary @- "http://127.0.0.1:9515/session/$session_id/execute/async")
# Select allowlisted fields before the first write. Unexpected values
# become fixed invalid codes, never raw transport or application text.
browser_stage='terminal-projection'
printf '%s' "$terminal_response" | jq -c '
  def fixed($values): . as $value | if ($values | index($value)) != null then $value else "invalid" end;
  def boolean: if type == "boolean" then . else null end;
  def hash($length): if type == "string" and test("^[a-f0-9]{" + ($length | tostring) + "}$") then . else null end;
  def error_code: if . == null then null else . as $code | if ([
    "boundary-object","artifact-fetch","worker-error-type","observation-failure",
    "ordinary-init-rejected","ordinary-init-envelope","ordinary-init-events","worker-result",
    "ordinary-install","viewer-rng-redaction","default-seed","default-player-count","default-format",
    "default-match-type","default-loop-detection","wasm-refusal-envelope","wasm-refusal-reasons",
    "wasm-refusal-reason-type","wasm-refusal-class","wasm-bracket-discriminator",
    "wasm-occupied-discriminator","wasm-refusal-classifier","worker-refusal","worker-refusal-class",
    "worker-bracket-discriminator","worker-occupied-discriminator","client-error-type","client-error-code",
    "refusal-resident-preservation","card-db-load","malformed-match-seed","malformed-match-type",
    "malformed-match-loop-detection","checkpoint-mode","limited-authority","served-wasm-identity",
    "served-glue-identity","baseline-source-identity","source-identity","glue-identity",
    "ordinary-decision","human-decision","issued-action","action-snapshot-change","action-recorded-once",
    "boundary-failure","experimental-exports-absent","experimental-contract","page-deadline","page-error","page-rejection"
  ] | index($code)) != null then $code else "invalid-error" end end;
  def control_id: if type == "string" and test("^(wasm-shell|production-worker)\\.(local|host)\\.(resident_without_database|missing_database|omitted_defaults|null_defaults|undeclared_four_seats|malformed_match_fallback|valid_limited|all_cedh_bracket_reach|cedh_bracket_refusal|occupied_direction|resident_for_(local|host)_occupied|(valid_limited_for_)?(malformed_format|format_player_count|malformed_deck|player_deck_validation|opponent_deck_validation|empty_library_after_load))$") then . else "invalid-case" end;
  def diagnostic_case($row): if . == null then null
    elif $row == "ordinary_worker_action" and . == "production-worker.local.issued_action_reach" then .
    else control_id end;
  def stage: if . == null then null else fixed([
    "row","initialize","observe","viewer-redaction","trusted-defaults","default-fields",
    "refusal","resident-preservation","ordinary-action"
  ]) end;
  .value | {status:(.status | fixed(["pass","fail"])),
    reason:(.reason | fixed(["candidate-green","expected-experimental-availability","unexpected-baseline-exports","incomplete-controls","timeout","uncaught-error","unhandled-rejection"])),
    artifact:(.artifact | fixed(["enabled","off"])), error:(.error | error_code),
    caseId:(.rows[-1].name as $row | .caseId | diagnostic_case($row)), stage:(.stage | stage),
    rows:[(.rows // [])[] | {name:(.name | fixed(["artifact_identity","ordinary_initializer_preservation","ordinary_worker_action","experimental_availability","experimental_local_admission","experimental_strict_requests","experimental_lifecycle","experimental_privacy_closed","experimental_realm_fallback","feature_off_refusal"])),
      status:(.status | fixed(["pass","fail","pending"])), error:(.error | error_code),
      caseId:(.name as $row | .caseId | diagnostic_case($row)), stage:(.stage | stage),
      evidence:(if .name == "artifact_identity" then .evidence | {
        wasmHash:(.wasmHash | hash(64)), servedGlueHash:(.servedGlueHash | hash(64)),
        supplied:{candidate_sha:(.supplied.candidate_sha | hash(40)), baseline_sha:(.supplied.baseline_sha | hash(40)),
          candidate_tree:(.supplied.candidate_tree | hash(40)), baseline_tree:(.supplied.baseline_tree | hash(40)),
          glue_sha256:(.supplied.glue_sha256 | hash(64))}}
      elif .name == "ordinary_initializer_preservation" then [(.evidence // [])[] | {
        name:(.name | control_id), status:(.status | fixed(["pass"])), evidence:{
          reachGuard:(if .evidence.reachGuard == null then null else .evidence.reachGuard | control_id end),
          initializationAccepted:(.evidence.initializationAccepted | boolean), stateInstalled:(.evidence.stateInstalled | boolean),
          replayInstalled:(.evidence.replayInstalled | boolean), defaultsMatched:(.evidence.defaultsMatched | boolean),
          viewerRngRedacted:(.evidence.viewerRngRedacted | boolean), trustedSeedPreserved:(.evidence.trustedSeedPreserved | boolean),
          refusalClassMatched:(.evidence.refusalClassMatched | boolean), typedDiscriminatorsMatched:(.evidence.typedDiscriminatorsMatched | boolean),
          clientCodeMatched:(.evidence.clientCodeMatched | boolean), residentPreserved:(.evidence.residentPreserved | boolean)}}]
      elif .name == "ordinary_worker_action" then .evidence | {
        ordinaryDecisionReached:(.ordinaryDecisionReached | boolean), humanDecisionIssued:(.humanDecisionIssued | boolean),
        engineIssuedAction:(.engineIssuedAction | boolean), snapshotChanged:(.snapshotChanged | boolean),
        replayRecordedOnce:(.replayRecordedOnce | boolean), recordedActionCount:(if .recordedActionCount == 1 then 1 else null end)}
      elif .name == "experimental_availability" then .evidence | {
        initialize_experimental_local_game:(.initialize_experimental_local_game | boolean), experimental_local_actor:(.experimental_local_actor | boolean)}
      else (.evidence // {}) | with_entries(select(.key | IN("explicitAdmission","ordinaryNeverAdmits","oldResidentPreserved","verifierReadOnly","adapterStrict","rawWorkerStrict","wasmBoundaryStrict","priorOwnerPreserved","failedRestorePreserved","checkedRestoreRevoked","ordinaryRevoked","postureRevoked","hostRefused","resetRevoked","privateWireClean","manualMutationClosed","laterExportsAbsent","mainThreadRefused","fallbackOrdinaryAction","fallbackExperimentalRefused","refusalPreserved","verifierNull","ordinaryWorkerLoaded"))) | map_values(boolean) end)}]}' > "$MANUAL_EVIDENCE/product-terminal.json"
jq -c '{status,reason,error,caseId,stage,rows:[.rows[] | {name,status,error,caseId,stage,controls:
  (if (.evidence | type) == "array" then (.evidence | length) else null end)}]}' \
  "$MANUAL_EVIDENCE/product-terminal.json" 2>&3
browser_stage='terminal-save'
python3 - 2>&3 <<'SAVE'
import json, os
from pathlib import Path
root = Path(os.environ['MANUAL_EVIDENCE']); path = root / 'baseline-terminal.json'
value = json.loads(path.read_text()) if path.exists() else {}
value[os.environ['BOOTSTRAP_CANDIDATE_ARTIFACT']] = json.loads((root / 'product-terminal.json').read_text())
path.write_text(json.dumps(value) + '\n')
SAVE
browser_stage='terminal-gate'
jq -e '.status == "pass" and .reason == "candidate-green" and ([.rows[] | select(.status != "pass")] | length == 0)' "$MANUAL_EVIDENCE/product-terminal.json" >/dev/null 2>&3
