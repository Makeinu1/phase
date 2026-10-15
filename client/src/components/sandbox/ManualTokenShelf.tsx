import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { DebugAction, PlayerId } from "../../adapter/types";
import { listTokenPresets, type TokenPreset } from "../../services/engineRuntime";

interface ManualTokenShelfProps {
  /** The player who creates (owns and controls) the tokens. */
  readonly owner: PlayerId;
  readonly count: number;
  readonly disabled: boolean;
  /** Catalog ids the engine links to the resolving card (its printed tokens). */
  readonly relatedPresetIds: readonly string[];
  readonly onCreate: (action: DebugAction) => void;
  /** The panel's amount stepper, when no other part of the panel shows it. */
  readonly amountControl?: ReactNode;
}

const SEARCH_LIMIT = 8;

/** Presets whose P/T comes from the creating effect (X/X) need numbers the
 *  shelf does not ask for; they stay in the Sandbox's full token form. */
function hasFixedPt(preset: TokenPreset): boolean {
  return preset.pt_provenance === undefined || preset.pt_provenance === "FixedOrAbsent";
}

/** One button per distinct token body; the catalog lists every printing. */
function bodyKey(preset: TokenPreset): string {
  const { body } = preset;
  return JSON.stringify([body.display_name, body.power, body.toughness, body.colors, body.core_types, body.subtypes, body.keywords]);
}

function distinct(presets: readonly TokenPreset[]): TokenPreset[] {
  const seen = new Set<string>();
  return presets.filter((preset) => {
    const key = bodyKey(preset);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function label(preset: TokenPreset): string {
  const { body } = preset;
  const pt = body.power !== null && body.toughness !== null ? ` ${body.power}/${body.toughness}` : "";
  const colors = body.colors.length > 0 ? ` (${body.colors.join("/")})` : "";
  return `${body.display_name}${pt}${colors}`;
}

/** Tokens the resolving spell creates: its own printed tokens first, the
 *  common predefined artifacts, and a name search over the engine catalog. */
export function ManualTokenShelf({ owner, count, disabled, relatedPresetIds, onCreate, amountControl }: ManualTokenShelfProps) {
  const { t } = useTranslation("game");
  const [presets, setPresets] = useState<TokenPreset[] | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let live = true;
    listTokenPresets()
      .then((loaded) => { if (live) setPresets(loaded); })
      .catch(() => { if (live) setPresets([]); });
    return () => { live = false; };
  }, []);

  const usable = useMemo(() => (presets ?? []).filter(hasFixedPt), [presets]);
  const related = useMemo(
    () => distinct(usable.filter((preset) => relatedPresetIds.includes(preset.id))),
    [usable, relatedPresetIds],
  );
  const common = useMemo(
    () => distinct(usable.filter((preset) => typeof preset.category === "object" && "PredefinedArtifact" in preset.category)),
    [usable],
  );
  const needle = query.trim().toLowerCase();
  const found = useMemo(
    () => needle
      ? distinct(usable.filter((preset) =>
        `${preset.body.display_name} ${preset.type_line ?? ""} ${preset.body.subtypes.join(" ")}`.toLowerCase().includes(needle)))
        .slice(0, SEARCH_LIMIT)
      : [],
    [usable, needle],
  );

  const create = (preset: TokenPreset) => onCreate({
    type: "CreateToken",
    data: {
      request: { type: "Preset", data: { preset_id: preset.id, owner, enter_with_counters: [] } },
      run_etb: true,
      count,
    },
  });

  const button = "rounded-md border border-emerald-200/20 bg-slate-900 px-2 py-0.5 text-[11px] text-emerald-100 hover:bg-slate-800 disabled:opacity-40";
  const row = (items: readonly TokenPreset[]) => items.map((preset) => (
    <button key={preset.id} type="button" disabled={disabled} className={button} onClick={() => create(preset)}>
      {label(preset)}
    </button>
  ));

  return (
    <div data-testid="manual-token-shelf" className="flex flex-col gap-1 rounded-lg border border-white/10 p-2">
      <div className="flex items-center gap-2 text-xs text-slate-300">
        <span>{t("manualResolution.panel.tokens", { count })}</span>
        {amountControl}
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)}
          aria-label={t("manualResolution.panel.tokenSearch")} placeholder={t("manualResolution.panel.tokenSearch")}
          className="min-w-0 flex-1 rounded border border-white/15 bg-slate-900 px-2 py-0.5 text-xs" />
      </div>
      <div className="flex flex-wrap gap-1">
        {row(found.length > 0 ? found : [...related, ...common.filter((preset) => !related.some((r) => bodyKey(r) === bodyKey(preset)))])}
      </div>
    </div>
  );
}
