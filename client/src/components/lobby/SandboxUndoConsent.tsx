import { useTranslation } from "react-i18next";
import { isSandboxUndoEnabled, useSandboxUndoConsentStore } from "../../stores/sandboxUndoConsentStore";

export function SandboxUndoConsent() {
  const { t } = useTranslation("multiplayer");
  const agreed = useSandboxUndoConsentStore((s) => s.agreed);
  const setAgreed = useSandboxUndoConsentStore((s) => s.setAgreed);
  if (!isSandboxUndoEnabled()) return null;
  return <label className="mb-3 flex items-start gap-2 text-sm text-amber-200">
    <input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} />
    {t("sandboxUndo.consent")}
  </label>;
}
