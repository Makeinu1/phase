import { useMemo, useRef, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import type { PlayerId } from "../../adapter/types.ts";
import { ManualResolutionSandbox } from "./ManualResolutionSandbox.tsx";
import type {
  ManualResolutionCommandBinding,
  ManualResolutionCommandPort,
  ManualResolutionCommandPortFactory,
  ManualResolutionRequest,
} from "./manual-resolution-ui-contract.ts";
import type { InteractionId } from "../../adapter/generated/interaction";

const source = {
  episodeId: "story-episode-1",
  stackEntryId: 103,
  sourceObjectId: 101,
  cardName: "Thoughtseize",
  oracleText: "Target opponent reveals their hand. You choose a nonland card from it. That player discards that card. You lose 2 life.",
};

const sourceReference = {
  stackEntryId: source.stackEntryId,
  sourceObjectId: source.sourceObjectId,
  adapterGeneration: 1,
};

const commandBinding: ManualResolutionCommandBinding = {
  interactionId: "story-session.1.1" as InteractionId,
  adapterGeneration: sourceReference.adapterGeneration,
};

function createLocalMockPortFactory(
  sessionActorId: PlayerId,
  setLastAction: (value: string) => void,
): ManualResolutionCommandPortFactory {
  const receiptSessionIdentity = Object.freeze({});
  return (scope): ManualResolutionCommandPort => ({
    receiptSessionIdentity,
    getUnresolvedManualResolutionRequest: () => null,
    async submitManualResolutionCommand(request: ManualResolutionRequest) {
      const { command } = request;
      if (
        command.stackEntryId !== scope.stackEntryId ||
        command.sourceObjectId !== scope.sourceObjectId ||
        request.binding.adapterGeneration !== scope.adapterGeneration
      ) {
        return { binding: request.binding, status: "rejected", reason: "The mock port is bound to another source occurrence." };
      }
      setLastAction(`${command.type} submitted through mock session actor ${sessionActorId}`);
      return { binding: request.binding, status: "completed" };
    },
    async reconcileManualResolution(originalRequest) {
      return { binding: originalRequest.binding, status: "indeterminate", reason: "No story operation is awaiting reconciliation." };
    },
  });
}

function LocalMockHarness() {
  const boardFocusRef = useRef<HTMLDivElement>(null);
  const [selectedTarget, setSelectedTarget] = useState<{ playerId: PlayerId; name: string } | null>(null);
  const [lastAction, setLastAction] = useState<string | null>(null);
  const [returnedToBoard, setReturnedToBoard] = useState(false);
  const portFactory = useMemo(() => createLocalMockPortFactory(0, setLastAction), [setLastAction]);
  const commandPort = useMemo(() => portFactory(sourceReference), [portFactory]);

  const mockPlayers = [
    { id: 1, name: "Mira" },
    { id: 0, name: "Ari" },
  ];

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-4 rounded-2xl bg-[#101722] p-4 text-slate-100 sm:p-8">
      <div
        ref={boardFocusRef}
        role="region"
        aria-label="Board focus destination"
        tabIndex={-1}
        className="rounded-lg border border-white/10 bg-emerald-950/30 p-4 outline-none focus-visible:ring-2 focus-visible:ring-cyan-200"
      >
        <p className="text-xs font-semibold uppercase tracking-[0.15em] text-emerald-100/80">Mock board</p>
        <h1 className="mt-1 text-lg font-semibold">Two player-area surfaces</h1>
        <p className="mt-1 text-sm text-slate-300">These buttons stand in for the real board PlayerArea surfaces; their selection is controlled here.</p>
      </div>

      <div role="group" aria-label="Mock board player areas" className="grid gap-3 sm:grid-cols-2">
        {mockPlayers.map((player) => {
          const isSelected = selectedTarget?.playerId === player.id;
          return (
            <button
              key={player.id}
              type="button"
              aria-pressed={isSelected}
              onKeyDownCapture={(event) => event.stopPropagation()}
              onClick={() => setSelectedTarget(isSelected ? null : { playerId: player.id, name: player.name })}
              className={`min-h-24 rounded-lg border p-4 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-200 ${isSelected ? "border-cyan-200 bg-cyan-950/70" : "border-white/15 bg-black/20"}`}
            >
              <span className="block text-xs uppercase tracking-[0.15em] text-slate-400">Mock player area</span>
              <span className="mt-2 block font-semibold">{player.name}</span>
              <span className="mt-2 block text-xs text-cyan-100">{isSelected ? "Selected" : "Select"}</span>
            </button>
          );
        })}
      </div>

      <ManualResolutionSandbox
        source={source}
        viewerPlayerId={0}
        selectedTarget={selectedTarget}
        onSelectedTargetChange={setSelectedTarget}
        commandBinding={commandBinding}
        confirmedRestoreEpoch={0}
        operationAvailability={{ available: true, amountBounds: { minimum: 1, maximum: 20 } }}
        canFinish
        commandPort={commandPort}
        returnFocusRef={boardFocusRef}
        onFinished={() => setReturnedToBoard(true)}
      />

      <section className="rounded-lg border border-white/10 bg-black/20 p-4 text-sm text-slate-300">
        <h2 className="font-semibold text-white">Story contract</h2>
        <p className="mt-2">This mock is disconnected from EngineAdapter, WASM, multiplayer, and P2P. The mock port factory closes over a local session actor and the selected GameState stack/source refs; the UI sends those refs so a future adapter can map the exact paused occurrence.</p>
        <p className="mt-2">The `episodeId` only resets UI lifecycle state. It is not a native action identity. The native manual-operation contract is unpublished, so the availability and amount bounds shown here are illustrative story inputs, not inferred limits.</p>
        <p className="mt-2" role="status" aria-live="polite">{returnedToBoard ? "The mock Finish returned focus to the board." : lastAction ?? "Mock session idle."}</p>
      </section>
    </main>
  );
}

const meta = {
  title: "Sandbox/ManualResolutionSandbox",
  parameters: {
    docs: {
      description: {
        story: "Private local UI experiment. The story owns mock player-area buttons and a context-bound fake command port; no live adapter or native action is connected.",
      },
    },
  },
  render: () => <LocalMockHarness />,
} satisfies Meta<typeof ManualResolutionSandbox>;

export default meta;

type Story = StoryObj<typeof meta>;

export const LocalMock: Story = {};
