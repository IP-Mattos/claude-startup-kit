import { useState, type FormEvent } from "react";
import { KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { useT } from "../../../lib/i18n";

// Placeholder only — the production URL the API actually lives at. Not a
// secret; the Rust side falls back to this when the field is left blank.
const BASE_URL_PLACEHOLDER = "https://trello-equipo.vercel.app/api/v1";

interface Props {
  available: boolean;
  initialError: string | null;
  onConfigure: (apiKey: string, baseUrl?: string) => Promise<void>;
}

export function TrelloConfig({ available, initialError, onConfigure }: Props) {
  const { t } = useT();
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(initialError);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!apiKey.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onConfigure(apiKey.trim(), baseUrl.trim() || undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="v3-view v3-trello-config-screen">
      <header className="v3-view-head">
        <div>
          <h1 className="v3-greeting">{t("trello.title")}</h1>
          <p className="v3-subtitle">{t("trello.config_subtitle")}</p>
        </div>
      </header>

      <article className="v3-card v3-trello-config">
        {!available && (
          <div className="v3-error" role="alert">
            {t("trello.desktop_only")}
          </div>
        )}
        {error && (
          <div className="v3-error" role="alert" aria-live="assertive">
            {error}
          </div>
        )}

        <form onSubmit={submit} className="v3-trello-config-form">
          <label className="v3-field">
            <span className="v3-field-label">
              <KeyRound size={13} strokeWidth={2} aria-hidden="true" />{" "}
              {t("trello.api_key")}
            </span>
            <input
              type="password"
              className="v3-input"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="tek_live_…"
              autoComplete="off"
              spellCheck={false}
              disabled={!available || submitting}
              autoFocus
            />
          </label>

          <label className="v3-field">
            <span className="v3-field-label">{t("trello.base_url")}</span>
            <input
              type="text"
              className="v3-input"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={BASE_URL_PLACEHOLDER}
              autoComplete="off"
              spellCheck={false}
              disabled={!available || submitting}
            />
            <span className="v3-field-hint">{t("trello.base_url_hint")}</span>
          </label>

          <button
            type="submit"
            className="v3-btn-primary"
            disabled={!available || submitting || !apiKey.trim()}
          >
            {submitting ? (
              <>
                <Loader2 size={14} className="v3-spin" aria-hidden="true" />{" "}
                {t("trello.connecting")}
              </>
            ) : (
              t("trello.connect")
            )}
          </button>
        </form>

        <p className="v3-trello-config-note">
          <ShieldCheck size={13} strokeWidth={2} aria-hidden="true" />{" "}
          {t("trello.security_note")}
        </p>
      </article>
    </div>
  );
}
