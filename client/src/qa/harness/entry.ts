import { startCapabilityControl } from "./capabilityControl";
import { createPreflight } from "./preflight";
import type { PreflightSnapshot } from "./preflight";
import { hasDrift, requiredObservationsKnown, setupMatchesBeforeRun } from "./runGate";
import { embeddedBuildStamp } from "./schema";

const preflightOutput = document.getElementById("qa-a1-output");
const controlOutput = document.getElementById("qa-a2-output");
const button = document.getElementById("qa-a2-run") as HTMLButtonElement | null;
const status = document.getElementById("qa-harness-status");
const preflight = createPreflight(window, import.meta.url, embeddedBuildStamp());
let setup: PreflightSnapshot | null = null;
let beforeRun: PreflightSnapshot | null = null;
let checking = false;
let blocked = false;
let disposed = false;
let currentCheck: ReturnType<typeof createPreflight> | null = null;
let control: ReturnType<typeof startCapabilityControl> | null = null;

function render() {
  const snapshot = preflight.snapshot();
  if (preflightOutput) preflightOutput.textContent = JSON.stringify({ setup: setup ?? snapshot, monitoring: snapshot.drift, beforeRun }, null, 2);
  const drift = hasDrift(snapshot);
  const intentPresent = setup?.initialIdentity.flags.environmentAccepted === "1";
  if (drift) { blocked = true; currentCheck?.dispose(); control?.cancel(); }
  if (button) button.disabled = disposed || !setup || !requiredObservationsKnown(setup) || !intentPresent || drift || blocked || checking || control !== null;
  if (status) status.textContent = drift ? "Environment drift observed; A2 is disabled for this run."
    : blocked ? "Before-run observation failed or differed from SETUP. No A2 connection was created; use a new run."
      : checking ? "Reobserving the current page before creating any A2 connection…"
        : !setup ? "Reading SETUP observations; A2 is disabled."
          : !requiredObservationsKnown(setup) ? "Required SETUP observations or artifact correspondence are unknown/failed; A2 is disabled."
            : !intentPresent ? "SETUP is visible. A new run may use #qa-environment-accepted=1 as intent only, after independent review."
              : "The URL flag is intent only. Confirm the external run record and this current page, then click; reload is a new run.";
  if (controlOutput && control) controlOutput.textContent = JSON.stringify(control.snapshot(), null, 2);
}

const run = async () => {
  render();
  if (!button || button.disabled || control) return;
  checking = true;
  render();
  try {
    // A fresh observer rereads artifact, URL/flags, APIs, SW inventory, and caches.
    currentCheck = createPreflight(window, import.meta.url, embeddedBuildStamp());
    await currentCheck.ready;
    if (disposed) return;
    beforeRun = currentCheck.snapshot();
    if (blocked || !setup || hasDrift(preflight.snapshot()) || !setupMatchesBeforeRun(setup, beforeRun)) {
      blocked = true;
      return;
    }
    control = startCapabilityControl();
    void control.completion.then(() => { if (!disposed) render(); });
  } catch { blocked = true; } // Never expose exception text or caller-controlled names.
  finally {
    currentCheck?.dispose();
    currentCheck = null;
    checking = false;
    if (!disposed) render();
  }
};
button?.addEventListener("click", run);
void preflight.ready.then(() => { if (!disposed) { setup = preflight.snapshot(); render(); } });
const timer = setInterval(render, 250);
render();
const dispose = () => {
  disposed = true;
  clearInterval(timer);
  currentCheck?.dispose();
  control?.cancel();
  preflight.dispose();
  button?.removeEventListener("click", run);
  window.removeEventListener("pagehide", dispose);
};
window.addEventListener("pagehide", dispose);
