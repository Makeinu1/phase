import { Fragment, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useGameStore } from "../../stores/gameStore";
import { useLocalSeatBinding } from "../../hooks/useLocalSeat";

/** DEV Local only: the provider/Worker lives through an explicit concealed handoff. */
export function LocalSeatBoundary({ children }: { children: ReactNode }) {
  const { t } = useTranslation("game");
  const view = useGameStore(s => s.localHistory);
  const players = useGameStore(s => s.gameState?.players);
  const binding = useLocalSeatBinding();
  if (!view || !binding) return <>{children}</>;
  const hidden = view.concealed || !view.viewerReady || view.phase === "stopped";
  return <>
    {hidden ? <div className="fixed inset-0 z-[200] flex flex-col items-center justify-center gap-5 bg-slate-950 text-white" data-local-seat-hidden="true">
      <p>{t("board.localSeat.hidden")}</p>
      <p>{t("board.localSeat.selected", { seat: view.seat + 1 })}</p>
      {view.phase === "stopped" ? <><p role="alert">{t("board.localHistory.stopped")}</p><a href="/" className="rounded bg-slate-700 px-5 py-3">{t("gamePage.menu.mainMenu", { defaultValue: "Main Menu" })}</a></>
        : <button data-local-seat-reveal="true" disabled={!view.viewerReady || view.phase !== "idle"}
          onClick={() => binding.session.reveal(binding)} className="rounded bg-cyan-700 px-6 py-3 disabled:opacity-40">
          {t(view.viewerReady ? "board.localSeat.show" : "board.localSeat.loading", { seat: view.seat + 1 })}
        </button>}
    </div> : <Fragment key={view.seatGeneration}>{children}</Fragment>}
    {!hidden && <div className="fixed left-1/2 top-2 z-[150] flex -translate-x-1/2 items-center gap-3 rounded bg-slate-950 px-3 py-2 text-sm text-white" data-local-selected-seat={view.seat}>
      <span>{t("board.localSeat.selected", { seat: view.seat + 1 })}</span>
      {players?.map((_, seat) => seat !== view.seat && <button key={seat} data-local-seat-handoff={seat}
        disabled={view.phase !== "idle"} onClick={() => { void binding.session.handoff(seat, binding); }}
        className="rounded bg-slate-700 px-3 py-1 disabled:opacity-40">
        {t("board.localSeat.pass", { seat: seat + 1 })}
      </button>)}
    </div>}
  </>;
}
