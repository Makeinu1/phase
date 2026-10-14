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
        self.full_control_label = re.escape(strings.get("__fullControlLabel", "コントロール"))
        self.steps: list[dict] = []
        self.hook_log: list[dict] = []
        (out / "screens").mkdir(parents=True, exist_ok=True)

    # ---- observation -------------------------------------------------
    def summary(self):
        trace("summary")
        return self.page.evaluate(SUMMARY_JS)

    def shot(self, label: str) -> str:
        trace(f"screenshot {label}")
        path = self.out / "screens" / f"{self.scenario}-{len(self.steps):02d}-{label}.jpg"
        self.page.screenshot(path=str(path), full_page=False, type="jpeg", quality=70)
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

    def settle(self, seconds: float = 2.0):
        """Wait until the seat-0 priority window is stable (the AI is idle)."""
        self.wait_for("() => { const s = window.__phaseAcceptance.state(); return s?.waiting_for?.type === 'Priority' && s.waiting_for.data?.player === 0; }", 20)
        time.sleep(seconds)

    def trim_hand(self, keep: int, protect: tuple[str, ...]):
        """Setup only: return extra opening-hand cards to the library so the
        whole hand fan fits beside the action bar at this viewport."""
        for _ in range(12):
            hand = self.page.evaluate("() => { const s = window.__phaseAcceptance.state(); return (s.players[0].hand ?? []).map((id) => [id, s.objects[id]?.name]); }")
            if len(hand) <= keep:
                return
            spare = next((oid for oid, name in hand if name not in protect), None)
            if spare is None:
                return
            self.settle(0.5)
            self.debug("MoveToZone", {"object_id": spare, "to_zone": "Library", "simulate": False})

    def ensure(self, card: str, owner: int, to_zone: str):
        """Setup only: take the card from the real deck's library, or create it
        when the run uses the synthetic fallback deck. The client drops a queued
        action whose decision changed meanwhile, so each placement is verified
        and retried."""
        for _ in range(3):
            existing = self.find(card, owner, [to_zone])
            if existing is not None:
                return existing
            self.settle(1.0)
            library_copy = self.find(card, owner, ["Library"])
            if library_copy is not None:
                self.debug("MoveToZone", {"object_id": library_copy, "to_zone": to_zone, "simulate": False})
            else:
                self.debug("CreateCard", {"card_name": card, "owner": owner, "zone": to_zone, "count": 1})
            if self.wait_for("([c, o, z]) => { const s = window.__phaseAcceptance.state(); return Object.values(s?.objects ?? {}).some((x) => x.name === c && x.owner === o && x.zone === z); }", 6, [card, owner, to_zone]):
                return self.find(card, owner, [to_zone])
        raise AssertionError(f"could not place {card} in {to_zone}")

    # ---- UI helpers ---------------------------------------------------
    def click_text(self, pattern: str, timeout_ms: int = 8000) -> bool:
        trace(f"click {pattern}")
        locator = self.page.get_by_role("button", name=re.compile(pattern))
        try:
            locator.first.wait_for(state="visible", timeout=timeout_ms)
            locator.first.click(timeout=10000)
            time.sleep(0.8)
            return True
        except Exception as error:  # record why (disabled, intercepted, missing)
            trace(f"click failed {pattern}: {str(error).splitlines()[0][:300]}")
            for line in str(error).splitlines()[1:12]:
                trace(f"  {line[:300]}")
            return False

    def click_hand_card(self, card: str, double: bool = False) -> bool:
        trace(f"{'double-' if double else ''}click hand card {card}")
        object_id = self.find(card, 0, ["Hand"])
        if object_id is None:
            return False
        self.page.mouse.move(5, 5)
        time.sleep(0.5)
        # Fanned cards overlap their neighbours. Find a point on this card that
        # is actually topmost, then press it with the real pointer.
        point = self.page.evaluate(
            """(id) => {
              const el = document.querySelector(`[data-player-hand] [data-object-id="${id}"]`);
              if (!el) return null;
              const r = el.getBoundingClientRect();
              for (const fy of [0.15, 0.3, 0.5, 0.7]) {
                for (const fx of [0.85, 0.7, 0.55, 0.4, 0.25, 0.1]) {
                  const x = r.left + r.width * fx, y = r.top + r.height * fy;
                  const hit = document.elementFromPoint(x, y);
                  if (hit && el.contains(hit)) return { x, y };
                }
              }
              return null;
            }""", object_id)
        if point is None:
            # The fan's right end can sit under the action bar. Clicking the
            # hand's empty area lifts the hand, as a player would.
            spot = self.page.evaluate(
                """() => {
                  const c = document.querySelector('[data-player-hand]');
                  if (!c) return null;
                  const r = c.getBoundingClientRect();
                  for (const fy of [0.9, 0.7, 0.5, 0.3]) for (const fx of [0.02, 0.05, 0.98, 0.95, 0.1]) {
                    const x = r.left + r.width * fx, y = r.top + r.height * fy;
                    if (document.elementFromPoint(x, y) === c) return { x, y };
                  }
                  return null;
                }""")
            trace(f"hand card hidden; lifting the hand via {spot}")
            if spot is not None:
                self.page.mouse.click(spot["x"], spot["y"])
                time.sleep(0.8)
                point = self.page.evaluate(
                    """(id) => {
                      const el = document.querySelector(`[data-player-hand] [data-object-id="${id}"]`);
                      if (!el) return null;
                      const r = el.getBoundingClientRect();
                      for (const fy of [0.15, 0.3, 0.5, 0.7]) for (const fx of [0.85, 0.7, 0.55, 0.4, 0.25, 0.1]) {
                        const x = r.left + r.width * fx, y = r.top + r.height * fy;
                        const hit = document.elementFromPoint(x, y);
                        if (hit && el.contains(hit)) return { x, y };
                      }
                      return null;
                    }""", object_id)
        if point is None:
            trace("hand card has no topmost point")
            return False
        if double:
            self.page.mouse.dblclick(point["x"], point["y"])
        else:
            self.page.mouse.click(point["x"], point["y"])
        time.sleep(0.8)
        return True

    # ---- paper-style manual instructions (board + panel) -------------------
    def panel(self):
        return self.page.locator('[data-testid="manual-resolution-panel"]')

    def ui_pick_player(self, player_id: int) -> None:
        trace(f"pick player {player_id}")
        self.page.locator(f'[data-player-hud="{player_id}"] [data-hud-plate]').first.click(timeout=10000)
        time.sleep(0.5)

    def ui_open_zone(self, player_id: int, zone: str) -> None:
        trace(f"open zone {zone} of {player_id}")
        selector = {
            "graveyard": f'[data-graveyard-pile="{player_id}"]',
            "library": f'[data-library-pile="{player_id}"] button',
            "hand": '[data-testid="opponent-hand"]',
        }[zone]
        self.page.locator(selector).locator("visible=true").first.click(timeout=10000)
        self.page.locator('[data-testid="manual-zone-strip"]').wait_for(state="visible", timeout=10000)

    def ui_click_permanent(self, card: str, owner: int) -> None:
        object_id = self.find(card, owner, ["Battlefield"])
        trace(f"click permanent {card} ({object_id})")
        self.page.locator(f'[data-permanent-card="{object_id}"]').first.click(timeout=10000)
        time.sleep(0.5)

    def ui_amount(self, amount: int) -> None:
        self.panel().get_by_role("spinbutton", name=self.strings["amount"]).first.fill(str(amount))

    def ui_strip_cards(self):
        return self.page.locator('[data-testid="manual-zone-strip"] li button')

    def ui_pick_strip(self, name: str) -> None:
        trace(f"pick strip card {name}")
        self.page.locator(f'[data-testid="manual-zone-strip"] button[aria-label="{name}"]').first.click(timeout=10000)

    def ui_panel_button(self, label: str) -> None:
        trace(f"panel button {label}")
        self.panel().get_by_role("button", name=label, exact=True).first.click(timeout=10000)
        time.sleep(1.0)

    def choose_card_option(self, card: str, option: str) -> bool:
        """Open the card's resolution menu ("<card>の解決方法") and pick an option."""
        trigger = self.strings["cardOptions"].replace("{{card}}", card)
        if not self.click_text(re.escape(trigger)):
            return False
        return self.click_text(re.escape(option))


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
                misses = getattr(j, "_keep_misses", 0) + 1
                j._keep_misses = misses
                if misses >= 6:
                    j.step("mulligan-keep", "ui", False, "keep button not found")
            time.sleep(1.5)
            continue
        if wf in ("Priority", "ManaPayment") or (s and s.get("phase") not in (None, "Untap")):
            break
        time.sleep(1.5)
    j.step("after-mulligan", "ui", True, j.summary().get("waitingFor"))
    # The table plays with full control: no automatic priority passes.
    full_control = j.page.locator("button[aria-pressed]:visible", has_text=re.compile(j.full_control_label))
    try:
        full_control.first.wait_for(state="visible", timeout=8000)
        if full_control.first.get_attribute("aria-pressed") != "true":
            full_control.first.click()
            time.sleep(1.0)
        enabled = full_control.first.get_attribute("aria-pressed") == "true"
    except Exception as exc:
        trace(f"full control toggle failed: {exc}")
        enabled = False
    j.step("full-control", "ui", enabled, "コントロール (full control) on")
    # Close the game log as a player on a laptop screen would; it narrows the
    # board so far that the hand fan's right end sits under the action bar.
    closed = j.click_text(re.escape(j.strings.get("closeLog", "対戦ログを閉じる")))
    trace(f"game log closed: {closed}")
    # Setup: put the human in their precombat main with priority.
    j.debug("SetPhase", {"phase": "PreCombatMain", "active_player": 0})
    j.settle()
    j.debug("SetInfiniteMana", {"player_id": 0, "enabled": True})
    j.settle()
    ok = j.wait_for("() => { const s = window.__phaseAcceptance.state(); return s?.waiting_for?.type === 'Priority' && s.waiting_for.data?.player === 0; }", 30)
    j.step("setup-main-phase", "hook(setup)", ok, "SetPhase PreCombatMain + infinite mana for seat 0")


def manual_journey(j: Journey, card: str, corrections, verify_after_finish, next_play: str,
                   target_object: str | None = None) -> None:
    before = j.summary()
    # 1. Hand card -> cast manually (UI).
    clicked = j.click_hand_card(card)
    j.step("select-hand-card", "ui", clicked, card)
    ok = j.choose_card_option(card, j.strings["castManually"])
    j.step("cast-manually", "ui", ok, j.strings["castManually"])
    # Targets are chosen while casting (CR 601.2c), manual or not: pick the opponent.
    if j.wait_for("() => window.__phaseAcceptance.state()?.waiting_for?.type === 'TargetSelection'", 4):
        try:
            if target_object is not None:
                # An object target is chosen by clicking it on the board.
                j.ui_click_permanent(target_object, 1)
            else:
                j.page.get_by_role("button", name=re.compile(r"^(?!あなた).+を選択$")).first.click(timeout=8000)
            chose = True
        except Exception as error:
            trace(f"choose target failed: {str(error).splitlines()[0][:200]}")
            chose = False
        j.step("choose-target", "ui", chose, target_object or "the opponent is the spell's target")
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
        j.click_text(r"^(解決|パス|Resolve|Pass)( →)?$")
        time.sleep(1.5)
    paused = j.summary().get("waitingFor") == "ManualResolution"
    j.step("paused-for-manual", "ui", paused, "engine paused before the first instruction")
    # 4. Board corrections performed by the human (hook in this run).
    corrections(j)
    j.step("corrections-applied", "hook(debug-corrections)", j.summary().get("waitingFor") == "ManualResolution",
           "still paused after corrections")
    # 5. Finish (UI).
    ok = j.click_text(re.escape(j.strings["finish"]))
    if not ok:
        state = j.page.evaluate("""(name) => [...document.querySelectorAll('button')].filter((b) => b.innerText.trim() === name)
          .map((b) => { const r = b.getBoundingClientRect(); const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            return { disabled: b.disabled, top: top === b || b.contains(top) ? 'self' : (top?.outerHTML ?? '').slice(0, 200) }; })""", j.strings["finish"])
        j.step("finish-button-state", "diagnostic", False, state)
    finished = j.wait_for("() => (m => m == null || m.phase === 'closed')(window.__phaseAcceptance.state()?.derived?.manual_resolution)", 15)
    notes = j.page.evaluate("() => [...document.querySelectorAll('[role=status],[role=alert]')].map((e) => e.innerText.trim()).filter(Boolean)")
    j.step("finish", "ui", ok and finished, {"button": j.strings["finish"], "panelNotes": notes})
    verify_after_finish(j, before)
    # 6. Undo to before casting (UI).
    undo = j.page.locator('[data-testid="manual-undo"] button')
    ok = False
    for attempt in range(3):
        try:
            undo.first.wait_for(state="visible", timeout=8000)
            undo.first.click(timeout=5000)
            ok = True
            break
        except Exception as error:
            # A follow-up prompt (e.g. a trigger choosing its target) can sit
            # over the board; a player sets it aside with Escape first.
            trace(f"undo click blocked ({str(error).splitlines()[0][:120]}); pressing Escape")
            j.page.keyboard.press("Escape")
            time.sleep(1.0)
    restored = j.wait_for(
        "(c) => { const s = window.__phaseAcceptance.state(); return s && (s.players?.[0]?.hand ?? []).some((id) => s.objects?.[id]?.name === c); }",
        20, card)
    after = j.summary()
    same = restored and after["players"][0]["graveyard"] == before["players"][0]["graveyard"] \
        and after["players"][1]["graveyard"] == before["players"][1]["graveyard"] \
        and after["players"][0]["library"] == before["players"][0]["library"] \
        and sorted(b["name"] for b in after["battlefield"]) == sorted(b["name"] for b in before["battlefield"]) \
        and [p["life"] for p in after["players"]] == [p["life"] for p in before["players"]] \
        and len(after["players"][1]["hand"]) == len(before["players"][1]["hand"])
    j.step("undo-before-cast", "ui", ok and same, {"restoredCardInHand": restored, "zonesMatchPreCast": same})
    # 7. Next ordinary plays (UI): a land drop, then a spell through the stack.
    # (The debug SetPhase setup leaves no land drop on this turn, so the
    # ordinary play exercised here is a spell through the stack.)
    # Double-click is the desktop hand's ordinary play gesture.
    clicked = j.click_hand_card(next_play, double=True)
    if not clicked:
        j.step("next-normal-play", "ui", False, f"{next_play} not reachable in the hand")
    if j.wait_for("() => window.__phaseAcceptance.state()?.waiting_for?.type === 'ManaPayment'", 4):
        j.click_text(r"^(支払う|Pay)$")
    for _ in range(6):
        if any(b["name"] == next_play and b["controller"] == 0 for b in j.summary()["battlefield"]):
            break
        j.click_text(r"^(解決|パス|Resolve|Pass)( →)?$")
        time.sleep(1.5)
    resolved = any(b["name"] == next_play and b["controller"] == 0 for b in j.summary()["battlefield"])
    j.step("next-normal-play", "ui", clicked and resolved, next_play)


# ---- scenarios ---------------------------------------------------------

def scenario_rejoin(j: Journey) -> None:
    j.ensure("Rejoin the Fight", 0, "Hand")
    j.ensure("Sol Ring", 0, "Hand")
    j.trim_hand(7, ("Rejoin the Fight", "Breach the Multiverse", "Fact or Fiction", "Sol Ring"))
    # Guarantee a creature card in the caster's graveyard after the mill.
    j.ensure("Sun Titan", 0, "Graveyard")
    j.step("setup-cards", "hook(setup)", True, "Rejoin the Fight + Sol Ring to hand, Sun Titan to graveyard")

    def corrections(j: Journey):
        panel = j.strings["panel"]
        # "Mill three cards": pick yourself on the board, 3, Mill.
        j.ui_pick_player(0)
        j.ui_amount(3)
        j.ui_panel_button(panel["mill"])
        # The opponent's choice from your graveyard, returned under your control.
        j.ui_open_zone(0, "graveyard")
        j.ui_pick_strip("Sun Titan")
        j.ui_panel_button(panel["toBattlefield"])

    def verify(j: Journey, before):
        s = j.summary()
        ok = "Rejoin the Fight" in s["players"][0]["graveyard"] \
            and any(b["name"] == "Sun Titan" and b["controller"] == 0 for b in s["battlefield"]) \
            and len(s["players"][0]["graveyard"]) == len(before["players"][0]["graveyard"]) + 3 \
            and s["waitingFor"] in ("Priority", "TriggerTargetSelection") and s["manualUndo"] is not None
        # Sun Titan really entered the battlefield, so its own ETB trigger goes
        # on the stack after the resolution and asks for its target.
        j.step("verify-after-finish", "state", ok,
               {"note": "spell in graveyard, 3 milled, Sun Titan returned, undo offered",
                "afterResolution": s["waitingFor"]})

    manual_journey(j, "Rejoin the Fight", corrections, verify, "Sol Ring")


def scenario_breach(j: Journey) -> None:
    j.ensure("Breach the Multiverse", 0, "Hand")
    j.ensure("Sol Ring", 0, "Hand")
    j.trim_hand(7, ("Rejoin the Fight", "Breach the Multiverse", "Fact or Fiction", "Sol Ring"))
    # Guarantee a creature card in the opponent's graveyard to choose.
    j.ensure("Grizzly Bears", 1, "Graveyard")
    j.step("setup-cards", "hook(setup)", True, "Breach the Multiverse + Sol Ring to hand, a creature in the opponent's graveyard")

    def corrections(j: Journey):
        panel = j.strings["panel"]
        # "Each player mills ten cards."
        for player_id in (0, 1):
            j.ui_pick_player(player_id)
            j.ui_amount(10)
            j.ui_panel_button(panel["mill"])
        # "Choose a creature or planeswalker card in that player's graveyard ...
        # onto the battlefield under your control."
        j.ui_open_zone(1, "graveyard")
        j.ui_pick_strip("Grizzly Bears")
        j.ui_panel_button(panel["toBattlefieldMine"])

    def verify(j: Journey, before):
        s = j.summary()
        stolen = [b for b in s["battlefield"] if b["owner"] == 1 and b["controller"] == 0]
        ok = "Breach the Multiverse" in s["players"][0]["graveyard"] \
            and any(b["name"] == "Grizzly Bears" for b in stolen) \
            and s["players"][1]["library"] == before["players"][1]["library"] - 10 \
            and s["waitingFor"] == "Priority" and s["manualUndo"] is not None
        j.step("verify-after-finish", "state", ok,
               {"stolenFromOpponent": [b["name"] for b in stolen], "note": "Phyrexian type change handled by conversation"})

    manual_journey(j, "Breach the Multiverse", corrections, verify, "Sol Ring")


def scenario_fact_or_fiction(j: Journey) -> None:
    j.ensure("Fact or Fiction", 0, "Hand")
    j.ensure("Sol Ring", 0, "Hand")
    j.trim_hand(7, ("Rejoin the Fight", "Breach the Multiverse", "Fact or Fiction", "Sol Ring"))
    j.step("setup-cards", "hook(setup)", True, "Fact or Fiction created in hand + Sol Ring to hand")

    def corrections(j: Journey):
        panel = j.strings["panel"]
        # "Reveal the top five cards of your library."
        j.ui_open_zone(0, "library")
        j.ui_amount(5)
        j.ui_panel_button(panel["revealTop"].replace("{{count}}", "5"))
        cards = j.ui_strip_cards()
        cards.nth(4).wait_for(state="visible", timeout=10000)
        # The opponent's piles (agreed at the table): two to hand, three to the graveyard.
        cards.nth(0).click()
        cards.nth(1).click()
        j.ui_panel_button(panel["toHand"])
        cards = j.ui_strip_cards()
        cards.nth(2).wait_for(state="visible", timeout=10000)
        for index in range(3):
            cards.nth(index).click()
        j.ui_panel_button(panel["toGraveyard"])

    def verify(j: Journey, before):
        s = j.summary()
        ok = "Fact or Fiction" in s["players"][0]["graveyard"] \
            and len(s["players"][0]["hand"]) == len(before["players"][0]["hand"]) - 1 + 2 \
            and len(s["players"][0]["graveyard"]) == len(before["players"][0]["graveyard"]) + 3 + 1 \
            and s["waitingFor"] == "Priority" and s["manualUndo"] is not None
        j.step("verify-after-finish", "state", ok, "pile of 2 to hand, pile of 3 to graveyard")

    manual_journey(j, "Fact or Fiction", corrections, verify, "Sol Ring")


def scenario_thoughtseize(j: Journey) -> None:
    """Hand attack performed entirely with the board tools (no hook)."""
    j.ensure("Thoughtseize", 0, "Hand")
    j.ensure("Sol Ring", 0, "Hand")
    # The opponent's hand is hidden from this viewer, so the placement is
    # verified by the hand size rather than by name.
    for _ in range(3):
        size = len(j.summary()["players"][1]["hand"])
        j.settle(1.0)
        j.debug("CreateCard", {"card_name": "Llanowar Elves", "owner": 1, "zone": "Hand", "count": 1})
        if j.wait_for("(n) => window.__phaseAcceptance.state().players[1].hand.length > n", 6, size):
            break
    else:
        raise AssertionError("could not place Llanowar Elves in the opponent's hand")
    j.trim_hand(7, ("Thoughtseize", "Sol Ring"))
    j.step("setup-cards", "hook(setup)", True, "Thoughtseize + Sol Ring to hand, a nonland card in the opponent's hand")
    panel = j.strings["panel"]

    def corrections(j: Journey):
        # The spell's target (chosen when cast) starts out picked.
        targeted = j.wait_for("() => window.__phaseAcceptance.manualPick?.().selectedPlayerId === 1", 10)
        j.step("target-preselected", "ui", targeted, "the opponent chosen at cast time is already picked")
        # "Target player reveals their hand": click their hand, reveal it.
        j.ui_open_zone(1, "hand")
        j.ui_panel_button(panel["revealHand"])
        shown = j.wait_for("() => document.querySelector('[data-testid=\"manual-zone-strip\"] button[aria-label=\"Llanowar Elves\"]') != null", 15)
        j.step("reveal-hand", "ui", shown, "the opponent's hand is revealed in the panel")
        # "You choose a nonland card from it. That player discards that card."
        j.ui_pick_strip("Llanowar Elves")
        j.ui_panel_button(panel["discard"])
        discarded = j.wait_for(
            "() => { const s = window.__phaseAcceptance.state(); return s.players[1].graveyard.some((id) => s.objects[id]?.name === 'Llanowar Elves'); }", 15)
        j.step("discard-chosen-card", "ui", discarded, "Llanowar Elves discarded from the revealed hand")
        # "You lose 2 life."
        life_before = j.summary()["players"][0]["life"]
        j.ui_pick_player(0)
        j.ui_amount(2)
        j.ui_panel_button(panel["loseLife"])
        lost = j.wait_for("(n) => window.__phaseAcceptance.state().players[0].life === n - 2", 15, life_before)
        j.step("lose-two-life", "ui", lost, f"{life_before} -> {life_before - 2}")

    def verify(j: Journey, before):
        s = j.summary()
        ok = "Thoughtseize" in s["players"][0]["graveyard"] \
            and "Llanowar Elves" in s["players"][1]["graveyard"] \
            and s["players"][0]["life"] == before["players"][0]["life"] - 2 \
            and len(s["players"][1]["hand"]) == len(before["players"][1]["hand"]) - 1 \
            and s["waitingFor"] == "Priority" and s["manualUndo"] is not None
        j.step("verify-after-finish", "state", ok, "opponent discarded the chosen card, caster lost 2 life")

    manual_journey(j, "Thoughtseize", corrections, verify, "Sol Ring")


def scenario_wrath(j: Journey) -> None:
    """Destroy all creatures, picked on the board; they can't be regenerated."""
    j.ensure("Wrath of God", 0, "Hand")
    j.ensure("Sol Ring", 0, "Hand")
    j.trim_hand(7, ("Wrath of God", "Sol Ring"))
    j.ensure("Serra Angel", 0, "Battlefield")
    j.ensure("Grizzly Bears", 1, "Battlefield")
    j.ensure("Darksteel Myr", 1, "Battlefield")
    j.step("setup-cards", "hook(setup)", True, "Wrath of God in hand; Serra Angel, Grizzly Bears, indestructible Darksteel Myr on the battlefield")
    panel = j.strings["panel"]

    def corrections(j: Journey):
        for name, owner in (("Serra Angel", 0), ("Grizzly Bears", 1), ("Darksteel Myr", 1)):
            j.ui_click_permanent(name, owner)
        picked = j.page.evaluate("() => window.__phaseAcceptance.manualPick().selectedObjectIds.length")
        j.step("pick-creatures", "ui", picked == 3, f"{picked} creatures picked on the board")
        j.panel().get_by_role("checkbox", name=panel["noRegeneration"]).check()
        j.ui_panel_button(panel["destroy"])

    def verify(j: Journey, before):
        s = j.summary()
        ok = "Wrath of God" in s["players"][0]["graveyard"] \
            and "Serra Angel" in s["players"][0]["graveyard"] \
            and "Grizzly Bears" in s["players"][1]["graveyard"] \
            and any(b["name"] == "Darksteel Myr" for b in s["battlefield"]) \
            and s["waitingFor"] == "Priority" and s["manualUndo"] is not None
        j.step("verify-after-finish", "state", ok, "creatures destroyed, indestructible Darksteel Myr remains")

    manual_journey(j, "Wrath of God", corrections, verify, "Sol Ring")


def scenario_go_for_the_throat(j: Journey) -> None:
    """The cast-time target starts out picked; one click destroys it."""
    j.ensure("Go for the Throat", 0, "Hand")
    j.ensure("Sol Ring", 0, "Hand")
    j.trim_hand(7, ("Go for the Throat", "Sol Ring"))
    j.ensure("Grizzly Bears", 1, "Battlefield")
    j.step("setup-cards", "hook(setup)", True, "Go for the Throat in hand, Grizzly Bears on the opponent's battlefield")
    panel = j.strings["panel"]

    def corrections(j: Journey):
        bears = j.find("Grizzly Bears", 1, ["Battlefield"])
        preselected = j.wait_for("(id) => window.__phaseAcceptance.manualPick().selectedObjectIds.includes(id)", 10, bears)
        j.step("target-preselected", "ui", preselected, "the creature targeted at cast time is already picked")
        j.ui_panel_button(panel["destroy"])

    def verify(j: Journey, before):
        s = j.summary()
        ok = "Go for the Throat" in s["players"][0]["graveyard"] \
            and "Grizzly Bears" in s["players"][1]["graveyard"] \
            and s["waitingFor"] == "Priority" and s["manualUndo"] is not None
        j.step("verify-after-finish", "state", ok, "the targeted creature was destroyed")

    manual_journey(j, "Go for the Throat", corrections, verify, "Sol Ring", target_object="Grizzly Bears")


def scenario_lightning_bolt(j: Journey) -> None:
    """Real damage from the resolving spell to the player it targeted."""
    j.ensure("Lightning Bolt", 0, "Hand")
    j.ensure("Sol Ring", 0, "Hand")
    j.trim_hand(7, ("Lightning Bolt", "Sol Ring"))
    j.step("setup-cards", "hook(setup)", True, "Lightning Bolt in hand")
    panel = j.strings["panel"]

    def corrections(j: Journey):
        preselected = j.wait_for("() => window.__phaseAcceptance.manualPick().selectedPlayerId === 1", 10)
        j.step("target-preselected", "ui", preselected, "the opponent targeted at cast time is already picked")
        j.ui_amount(3)
        j.ui_panel_button(panel["damage"].replace("{{count}}", "3"))

    def verify(j: Journey, before):
        s = j.summary()
        ok = "Lightning Bolt" in s["players"][0]["graveyard"] \
            and s["players"][1]["life"] == before["players"][1]["life"] - 3 \
            and s["waitingFor"] == "Priority" and s["manualUndo"] is not None
        j.step("verify-after-finish", "state", ok, "3 damage to the targeted opponent")

    manual_journey(j, "Lightning Bolt", corrections, verify, "Sol Ring")


SCENARIOS = {
    "A-rejoin-the-fight": ("Celes", scenario_rejoin),
    "B-breach-the-multiverse": ("Muldrotha", scenario_breach),
    "C-fact-or-fiction": ("Celes", scenario_fact_or_fiction),
    "D-thoughtseize": ("Celes", scenario_thoughtseize),
    "E-wrath-of-god": ("Celes", scenario_wrath),
    "F-go-for-the-throat": ("Celes", scenario_go_for_the_throat),
    "G-lightning-bolt": ("Celes", scenario_lightning_bolt),
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
    locale = json.load(open(args.locale, encoding="utf-8"))
    strings = dict(locale["manualResolution"])
    strings["__fullControlLabel"] = locale["fullControl"]["label"]
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
        # A failing run ends with a synthetic "failure" step; report the step before it.
        if steps and steps[-1] == "failure":
            steps = steps[:-1]
        last = steps[-1] if steps else "boot"
        level = "notice" if result["status"] == "pass" else "error"
        reason = (result["error"] or "").splitlines()[0][:300] if result["error"] else "all steps passed"
        print(f"::{level}::{name} [{result['deck']} deck]: {result['status']} (last step {last}) {reason}")
    return 0 if all(v["status"] == "pass" for v in results.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
