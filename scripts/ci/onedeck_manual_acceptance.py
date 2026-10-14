"""Browser acceptance for manual resolution + pre-cast Undo on real decks.

Runs against a Vite dev server built with the `manual_resolution_local_bootstrap`
engine. Each scenario starts an ordinary two-seat local game (human vs AI) with
`?manual=1`, uses the dev-only `window.__phaseAcceptance` hook for board SETUP
only, then drives the journey through the product UI:

  hand card -> "cast manually" -> pay -> pass -> manual panel
  -> board corrections -> Finish -> Undo to before casting -> next normal play

Every step records whether it went through the UI or the hook, a state summary
and a screenshot. Results are written to --out (encrypted by the workflow).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import traceback
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

SUMMARY_JS = """
() => {
  const h = window.__phaseAcceptance;
  if (!h) return null;
  const s = h.state();
  if (!s) return { ready: false };
  const name = (id) => s.objects?.[id]?.name ?? `#${id}`;
  const zone = (ids) => (ids ?? []).map(name);
  return {
    ready: true,
    phase: s.phase,
    activePlayer: s.active_player,
    waitingFor: s.waiting_for?.type ?? null,
    waitingData: s.waiting_for?.data ?? null,
    manual: s.derived?.manual_resolution ?? null,
    manualUndo: h.manualUndo() ? { cardName: h.manualUndo().cardName, ended: h.manualUndo().episodeEnded } : null,
    stack: (s.stack ?? []).map((e) => ({ id: e.id, name: name(e.source_id ?? e.id) })),
    players: (s.players ?? []).map((p) => ({
      id: p.id, life: p.life,
      hand: zone(p.hand), graveyard: zone(p.graveyard), exile: zone(p.exile),
      library: (p.library ?? []).length,
      libraryTop: zone((p.library ?? []).slice(0, 12)),
    })),
    battlefield: (s.battlefield ?? []).map((id) => ({
      name: name(id), controller: s.objects?.[id]?.controller, owner: s.objects?.[id]?.owner,
    })),
  };
}
"""

FIND_JS = """
([cardName, owner, zones]) => {
  const s = window.__phaseAcceptance.state();
  for (const [id, o] of Object.entries(s.objects ?? {})) {
    if (o.name === cardName && (owner === null || o.owner === owner) && zones.includes(o.zone)) return Number(id);
  }
  return null;
}
"""


TRACE: Path | None = None


def trace(message: str) -> None:
    if TRACE is not None:
        with TRACE.open("a", encoding="utf-8") as handle:
            handle.write(f"{time.strftime('%H:%M:%S')} {message}\n")


class Journey:
    def __init__(self, page: Page, out: Path, scenario: str, strings: dict):
        self.page = page
        self.out = out
        self.scenario = scenario
        self.strings = strings
        self.steps: list[dict] = []
        self.hook_log: list[dict] = []
        (out / "screens").mkdir(parents=True, exist_ok=True)

    # ---- observation -------------------------------------------------
    def summary(self):
        trace("summary")
        return self.page.evaluate(SUMMARY_JS)

    def shot(self, label: str) -> str:
        trace(f"screenshot {label}")
        path = self.out / "screens" / f"{self.scenario}-{len(self.steps):02d}-{label}.png"
        self.page.screenshot(path=str(path), full_page=False)
        return path.name

    def step(self, label: str, via: str, ok: bool, detail=None):
        entry = {
            "step": label, "via": via, "ok": ok, "detail": detail,
            "state": self.summary(), "screen": self.shot(label),
            "buttons": self.page.evaluate(
                "() => [...document.querySelectorAll('button')].filter(b => b.offsetParent)"
                ".map(b => (b.innerText || b.getAttribute('aria-label') || '').trim()).filter(Boolean).slice(0, 60)"),
        }
        self.steps.append(entry)
        print(json.dumps({k: entry[k] for k in ("step", "via", "ok", "detail")}, ensure_ascii=False), flush=True)
        if not ok:
            raise AssertionError(f"{self.scenario}: {label} failed: {detail}")

    def wait_for(self, predicate_js: str, timeout_s: float, arg=None) -> bool:
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            try:
                if self.page.evaluate(predicate_js, arg):
                    return True
            except Exception:  # page still booting
                pass
            time.sleep(0.5)
        return False

    # ---- hook setup (never used for the journey itself) ---------------
    def dispatch(self, action: dict, actor: int = 0):
        trace(f"hook dispatch {json.dumps(action)[:200]}")
        outcome = self.page.evaluate(
            """([a, p]) => Promise.race([
                 window.__phaseAcceptance.dispatch(a, p).then(() => 'done', (e) => 'error: ' + (e?.message ?? e)),
                 new Promise((r) => setTimeout(() => r('timeout'), 15000)),
               ])""",
            [action, actor])
        self.hook_log.append({"action": action, "actor": actor, "outcome": outcome})
        time.sleep(0.8)
        return outcome

    def debug(self, kind: str, data: dict | None = None):
        inner = {"type": kind} if data is None else {"type": kind, "data": data}
        self.dispatch({"type": "Debug", "data": inner})

    def find(self, card: str, owner: int | None, zones: list[str]):
        return self.page.evaluate(FIND_JS, [card, owner, zones])

    def move(self, card: str, owner: int | None, from_zones: list[str], to_zone: str):
        object_id = self.find(card, owner, from_zones)
        if object_id is None:
            raise AssertionError(f"{card} not found in {from_zones}")
        self.debug("MoveToZone", {"object_id": object_id, "to_zone": to_zone, "simulate": False})
        return object_id

    def ensure(self, card: str, owner: int, to_zone: str):
        """Setup only: take the card from the real deck's library, or create it
        when the run uses the synthetic fallback deck."""
        if self.find(card, owner, ["Library"]) is not None:
            return self.move(card, owner, ["Library"], to_zone)
        self.debug("CreateCard", {"card_name": card, "owner": owner, "zone": to_zone, "count": 1})
        object_id = self.find(card, owner, [to_zone])
        if object_id is None:
            raise AssertionError(f"could not place {card} in {to_zone}")
        return object_id

    # ---- UI helpers ---------------------------------------------------
    def click_text(self, pattern: str, timeout_ms: int = 8000) -> bool:
        trace(f"click {pattern}")
        locator = self.page.get_by_role("button", name=re.compile(pattern))
        try:
            locator.first.wait_for(state="visible", timeout=timeout_ms)
            locator.first.click()
            time.sleep(0.8)
            return True
        except Exception:
            return False

    def click_hand_card(self, card: str) -> bool:
        candidates = [
            self.page.locator(f'[data-card-name="{card}"]'),
            self.page.get_by_role("button", name=re.compile(re.escape(card))),
            self.page.locator(f'[aria-label*="{card}"]'),
            self.page.locator(f'img[alt*="{card}"]'),
        ]
        for locator in candidates:
            try:
                if locator.count() > 0:
                    locator.last.click()
                    time.sleep(0.8)
                    return True
            except Exception:
                continue
        return False


def boot(page: Page, base_url: str, game_id: str, decks: dict, deck_name: str) -> None:
    page.goto(base_url + "/")
    page.evaluate(
        """([decks, active]) => {
          for (const [name, deck] of Object.entries(decks)) {
            localStorage.setItem('phase-deck:' + name, JSON.stringify({ ...deck, format: 'Commander' }));
          }
          localStorage.setItem('phase-active-deck', active);
          localStorage.setItem('phase-preferences', JSON.stringify({ state: { language: 'ja', dismissedSandboxToolsNudge: true, dismissedFlowHelpNudge: true, dismissedReportCardNudge: true, nativeEngineEnabled: false }, version: 37 }));
        }""",
        [decks, deck_name],
    )
    page.goto(f"{base_url}/game/{game_id}?mode=ai&format=Commander&players=2&difficulty=VeryEasy&manual=1")


def reach_main_phase(j: Journey) -> None:
    ready = j.wait_for("() => window.__phaseAcceptance?.state() != null", 240)
    j.step("game-started", "ui", ready, "local manual-play game booted")
    for _ in range(40):
        s = j.summary()
        wf = s and s.get("waitingFor")
        if wf and "Mulligan" in wf:
            if not j.click_text(r"^(この手札で始める|Keep)"):
                j.step("mulligan-keep", "ui", False, "keep button not found")
            time.sleep(1.5)
            continue
        if wf in ("Priority", "ManaPayment") or (s and s.get("phase") not in (None, "Untap")):
            break
        time.sleep(1.5)
    j.step("after-mulligan", "ui", True, j.summary().get("waitingFor"))
    # Setup: put the human in their precombat main with priority.
    j.debug("SetPhase", {"phase": "PreCombatMain", "active_player": 0})
    j.debug("SetInfiniteMana", {"player_id": 0, "enabled": True})
    ok = j.wait_for("() => { const s = window.__phaseAcceptance.state(); return s?.waiting_for?.type === 'Priority' && s.waiting_for.data?.player === 0; }", 30)
    j.step("setup-main-phase", "hook(setup)", ok, "SetPhase PreCombatMain + infinite mana for seat 0")


def manual_journey(j: Journey, card: str, corrections, verify_after_finish, next_play: str) -> None:
    before = j.summary()
    # 1. Hand card -> cast manually (UI).
    clicked = j.click_hand_card(card)
    j.step("select-hand-card", "ui", clicked, card)
    ok = j.click_text(re.escape(j.strings["castManually"]))
    j.step("cast-manually", "ui", ok, j.strings["castManually"])
    # 2. Payment (UI if a payment prompt appears).
    if j.wait_for("() => window.__phaseAcceptance.state()?.waiting_for?.type === 'ManaPayment'", 4):
        j.click_text(r"^(支払う|Pay)$")
    cast = j.wait_for(
        "(c) => (window.__phaseAcceptance.state()?.stack ?? []).length > 0 || window.__phaseAcceptance.state()?.waiting_for?.type === 'ManualResolution'",
        20, card)
    j.step("spell-on-stack", "ui", cast, "manual designation travels with the spell")
    # 3. Pass priority until the engine pauses at resolution.
    for _ in range(6):
        if j.summary().get("waitingFor") == "ManualResolution":
            break
        j.click_text(r"^(パス|Pass)")
        time.sleep(1.5)
    paused = j.summary().get("waitingFor") == "ManualResolution"
    j.step("paused-for-manual", "ui", paused, "engine paused before the first instruction")
    # 4. Board corrections performed by the human (hook in this run).
    corrections(j)
    j.step("corrections-applied", "hook(debug-corrections)", j.summary().get("waitingFor") == "ManualResolution",
           "still paused after corrections")
    # 5. Finish (UI).
    ok = j.click_text(re.escape(j.strings["finish"]))
    finished = j.wait_for("() => window.__phaseAcceptance.state()?.derived?.manual_resolution == null", 15)
    j.step("finish", "ui", ok and finished, j.strings["finish"])
    verify_after_finish(j, before)
    # 6. Undo to before casting (UI).
    undo = j.page.locator('[data-testid="manual-undo"] button')
    try:
        undo.first.wait_for(state="visible", timeout=8000)
        undo.first.click()
        ok = True
    except Exception:
        ok = False
    restored = j.wait_for(
        "(c) => { const s = window.__phaseAcceptance.state(); return s && (s.players?.[0]?.hand ?? []).some((id) => s.objects?.[id]?.name === c); }",
        20, card)
    after = j.summary()
    same = restored and after["players"][0]["graveyard"] == before["players"][0]["graveyard"] \
        and after["players"][1]["graveyard"] == before["players"][1]["graveyard"] \
        and after["players"][0]["library"] == before["players"][0]["library"] \
        and sorted(b["name"] for b in after["battlefield"]) == sorted(b["name"] for b in before["battlefield"])
    j.step("undo-before-cast", "ui", ok and same, {"restoredCardInHand": restored, "zonesMatchPreCast": same})
    # 7. Next ordinary play (UI): cast normally and let it resolve automatically.
    clicked = j.click_hand_card(next_play)
    if j.click_text(re.escape(j.strings["castNormally"])) is False:
        j.click_text(r"唱える|Cast")
    if j.wait_for("() => window.__phaseAcceptance.state()?.waiting_for?.type === 'ManaPayment'", 4):
        j.click_text(r"^(支払う|Pay)$")
    for _ in range(6):
        if any(b["name"] == next_play for b in j.summary()["battlefield"]):
            break
        j.click_text(r"^(パス|Pass)")
        time.sleep(1.5)
    resolved = any(b["name"] == next_play for b in j.summary()["battlefield"])
    j.step("next-normal-play", "ui", clicked and resolved, next_play)


# ---- scenarios ---------------------------------------------------------

def scenario_rejoin(j: Journey) -> None:
    j.ensure("Rejoin the Fight", 0, "Hand")
    j.ensure("Sol Ring", 0, "Hand")
    # Guarantee a creature card in the caster's graveyard after the mill.
    j.ensure("Sun Titan", 0, "Graveyard")
    j.step("setup-cards", "hook(setup)", True, "Rejoin the Fight + Sol Ring to hand, Sun Titan to graveyard")

    def corrections(j: Journey):
        j.debug("Mill", {"player_id": 0, "count": 3})
        # The AI opponent's choice is made by the human on its behalf.
        j.move("Sun Titan", 0, ["Graveyard"], "Battlefield")

    def verify(j: Journey, before):
        s = j.summary()
        ok = "Rejoin the Fight" in s["players"][0]["graveyard"] \
            and any(b["name"] == "Sun Titan" and b["controller"] == 0 for b in s["battlefield"]) \
            and len(s["players"][0]["graveyard"]) == len(before["players"][0]["graveyard"]) + 3 \
            and s["waitingFor"] == "Priority" and s["manualUndo"] is not None
        j.step("verify-after-finish", "state", ok, "spell in graveyard, 3 milled, Sun Titan returned, undo offered")

    manual_journey(j, "Rejoin the Fight", corrections, verify, "Sol Ring")


def scenario_breach(j: Journey) -> None:
    j.ensure("Breach the Multiverse", 0, "Hand")
    j.ensure("Sol Ring", 0, "Hand")
    j.step("setup-cards", "hook(setup)", True, "Breach the Multiverse + Sol Ring to hand")

    def corrections(j: Journey):
        j.debug("Mill", {"player_id": 0, "count": 10})
        j.debug("Mill", {"player_id": 1, "count": 10})
        s = j.page.evaluate("""() => {
          const s = window.__phaseAcceptance.state();
          const pick = (pid) => (s.players[pid].graveyard ?? []).find((id) => {
            const o = s.objects[id]; const t = o?.card_types?.core_types ?? [];
            return t.includes('Creature') || t.includes('Planeswalker');
          });
          return [pick(0) ?? null, pick(1) ?? null];
        }""")
        for object_id in [i for i in s if i is not None]:
            j.debug("MoveToZone", {"object_id": object_id, "to_zone": "Battlefield", "simulate": False})
            j.debug("SetController", {"object_id": object_id, "controller": 0})
        j.page.evaluate("(ids) => window.__acceptancePicked = ids", s)

    def verify(j: Journey, before):
        s = j.summary()
        stolen = [b for b in s["battlefield"] if b["owner"] == 1 and b["controller"] == 0]
        ok = "Breach the Multiverse" in s["players"][0]["graveyard"] \
            and s["players"][1]["library"] == before["players"][1]["library"] - 10 \
            and s["waitingFor"] == "Priority" and s["manualUndo"] is not None
        j.step("verify-after-finish", "state", ok,
               {"stolenFromOpponent": [b["name"] for b in stolen], "note": "Phyrexian type change handled by conversation"})

    manual_journey(j, "Breach the Multiverse", corrections, verify, "Sol Ring")


def scenario_fact_or_fiction(j: Journey) -> None:
    j.ensure("Fact or Fiction", 0, "Hand")
    j.ensure("Sol Ring", 0, "Hand")
    j.step("setup-cards", "hook(setup)", True, "Fact or Fiction created in hand + Sol Ring to hand")

    def corrections(j: Journey):
        j.debug("Reveal", {"player_id": 0, "count": 5})
        top = j.page.evaluate("() => window.__phaseAcceptance.state().players[0].library.slice(0, 5)")
        for object_id in top[:2]:
            j.debug("MoveToZone", {"object_id": object_id, "to_zone": "Hand", "simulate": False})
        for object_id in top[2:]:
            j.debug("MoveToZone", {"object_id": object_id, "to_zone": "Graveyard", "simulate": False})

    def verify(j: Journey, before):
        s = j.summary()
        ok = "Fact or Fiction" in s["players"][0]["graveyard"] \
            and len(s["players"][0]["hand"]) == len(before["players"][0]["hand"]) - 1 + 2 \
            and len(s["players"][0]["graveyard"]) == len(before["players"][0]["graveyard"]) + 3 + 1 \
            and s["waitingFor"] == "Priority" and s["manualUndo"] is not None
        j.step("verify-after-finish", "state", ok, "pile of 2 to hand, pile of 3 to graveyard")

    manual_journey(j, "Fact or Fiction", corrections, verify, "Sol Ring")


SCENARIOS = {
    "A-rejoin-the-fight": ("Celes", scenario_rejoin),
    "B-breach-the-multiverse": ("Muldrotha", scenario_breach),
    "C-fact-or-fiction": ("Celes", scenario_fact_or_fiction),
}


def run_one(args, name: str, synthetic: bool, decks: dict, strings: dict) -> dict:
    global TRACE
    out = Path(args.out)
    TRACE = out / f"trace-{name}.log"
    deck, run = SCENARIOS[name]
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        context = browser.new_context(viewport={"width": 1440, "height": 900}, locale="ja-JP")
        page = context.new_page()
        console_log = out / f"console-{name}.log"

        def on_console(message):
            with console_log.open("a", encoding="utf-8") as handle:
                handle.write(f"{time.strftime('%H:%M:%S')} {message.type}: {message.text[:600]}\n")

        page.on("console", on_console)
        page.on("pageerror", lambda e: on_console(type("E", (), {"type": "pageerror", "text": str(e)})()))
        journey = Journey(page, out, name, strings)
        status, error = "pass", None
        try:
            trace("boot")
            boot(page, args.base_url, f"acc-{name}", decks, deck)
            reach_main_phase(journey)
            run(journey)
        except Exception as exc:
            status = "fail"
            error = f"{exc}\n{traceback.format_exc()[-2000:]}"
            try:
                journey.steps.append({"step": "failure", "state": journey.summary(), "screen": journey.shot("failure")})
            except Exception:
                pass
        result = {"status": status, "deck": "synthetic" if synthetic else "real", "error": error,
                  "hook": journey.hook_log, "steps": journey.steps}
        (out / f"result-{name}.json").write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
        context.close()
        browser.close()
    return result


def main() -> int:
    import subprocess

    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--locale", required=True, help="client/src/i18n/locales/ja/game.json")
    parser.add_argument("--only", default="")
    parser.add_argument("--child", default="")
    parser.add_argument("--scenario-timeout", type=int, default=900)
    args = parser.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    raw_decks = os.environ.get("ONEDECK_DECKS", "").strip()
    synthetic = not raw_decks
    if synthetic:
        # Fallback until the private decks are provided: a legal-shaped
        # Commander list (public commanders + basics). Results are labelled.
        basics = lambda names: [{"count": 33, "name": n} for n in names]
        decks = {
            "Celes": {"main": basics(["Plains", "Swamp", "Mountain"]), "sideboard": [], "commander": ["Celes, Rune Knight"]},
            "Muldrotha": {"main": basics(["Forest", "Island", "Swamp"]), "sideboard": [], "commander": ["Muldrotha, the Gravetide"]},
        }
    else:
        decks = json.loads(raw_decks)
    strings = json.load(open(args.locale, encoding="utf-8"))["manualResolution"]
    if args.child:
        run_one(args, args.child, synthetic, decks, strings)
        return 0
    results = {}
    for name in SCENARIOS:
        if args.only and name not in args.only.split(","):
            continue
        command = [sys.executable, __file__, "--base-url", args.base_url, "--out", args.out,
                   "--locale", args.locale, "--child", name]
        try:
            subprocess.run(command, timeout=args.scenario_timeout, check=False)
        except subprocess.TimeoutExpired:
            pass
        result_file = out / f"result-{name}.json"
        if result_file.exists():
            results[name] = json.loads(result_file.read_text(encoding="utf-8"))
        else:
            trace_file = out / f"trace-{name}.log"
            last = trace_file.read_text(encoding="utf-8").splitlines()[-1] if trace_file.exists() else "no trace"
            results[name] = {"status": "timeout", "deck": "synthetic" if synthetic else "real",
                             "error": f"scenario exceeded {args.scenario_timeout}s; last trace: {last}", "steps": []}
    (out / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
    for name, result in results.items():
        steps = [step["step"] for step in result["steps"]]
        last = steps[-2] if len(steps) >= 2 else (steps[-1] if steps else "boot")
        level = "notice" if result["status"] == "pass" else "error"
        reason = (result["error"] or "").splitlines()[0][:300] if result["error"] else "all steps passed"
        print(f"::{level}::{name} [{result['deck']} deck]: {result['status']} (last step {last}) {reason}")
    return 0 if all(v["status"] == "pass" for v in results.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
