import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { P2PHostAdapter } from "../../adapter/p2p-adapter";
import { bindSandboxUndoAdoption } from "../../game/sandboxPrecastUndo";
import { isSandboxUndoEnabled } from "../../stores/sandboxUndoConsentStore";
import { useGameStore } from "../../stores/gameStore";

export function SandboxPrecastUndoButton() {
  const { t } = useTranslation("game");
  const adapter = useGameStore((s) => s.adapter);
  const gameId = useGameStore((s) => s.gameId);
  const generation = useGameStore((s) => s.gameSessionGeneration);
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setAvailable(false);
    setBusy(false);
    setFailed(false);
    if (!isSandboxUndoEnabled() || !(adapter instanceof P2PHostAdapter)) return;
    let cancelled = false;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const ready = await adapter.sandboxPrecastUndoAvailable();
        if (!cancelled) setAvailable(ready);
      } catch {
        if (!cancelled) setAvailable(false);
      } finally { polling = false; }
    };
    void poll();
    const timer = setInterval(() => { void poll(); }, 250);
    return () => { cancelled = true; clearInterval(timer); };
  }, [adapter, gameId, generation]);
  if (!isSandboxUndoEnabled() || !(adapter instanceof P2PHostAdapter)
    || !adapter.isSandboxPrecastUndoConfigured() || !gameId) return null;
  const restore = async () => {
    if (busy || !available) return;
    setBusy(true);
    setFailed(false);
    try {
      await adapter.restoreSandboxPrecastUndo(bindSandboxUndoAdoption(adapter, gameId));
    } catch { if (isCurrent()) setFailed(true); }
    finally { if (isCurrent()) { setBusy(false); setAvailable(false); } }
  };
  const isCurrent = () => {
    const current = useGameStore.getState();
    return current.adapter === adapter && current.gameId === gameId && current.gameSessionGeneration === generation;
  };
  return <div onKeyDown={(event) => event.stopPropagation()}>
    <button disabled={!available || busy} onClick={() => { void restore(); }}
      className="rounded-md bg-gray-800/80 px-2.5 py-1 text-[11px] text-amber-200 disabled:opacity-40">
      {t("sandboxUndo.restore")}
    </button>
    {failed && <span role="alert">{t("sandboxUndo.failed")}</span>}
  </div>;
}
