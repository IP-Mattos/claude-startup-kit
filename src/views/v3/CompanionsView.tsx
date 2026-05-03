import { useState } from "react";
import { Image as ImageIcon, Trash2 } from "lucide-react";
import { useT } from "../../lib/i18n";

interface CompanionsViewProps {
  name: string;
  image: string | null;
  onNameChange: (v: string) => void;
  onImageChange: (v: string | null) => void;
}

export function CompanionsView({
  name,
  image,
  onNameChange,
  onImageChange,
}: CompanionsViewProps) {
  const { t } = useT();
  const setName = onNameChange;
  const setImage = onImageChange;
  const [imgError, setImgError] = useState<string | null>(null);

  const handleFile = (file: File | undefined) => {
    setImgError(null);
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setImgError(t("companions.err_not_image"));
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setImgError(t("companions.err_too_large"));
      return;
    }
    const r = new FileReader();
    r.onload = () => {
      if (typeof r.result === "string") setImage(r.result);
    };
    r.onerror = () => setImgError(t("companions.err_read"));
    r.readAsDataURL(file);
  };

  return (
    <div className="v3-view">
      <header className="v3-view-head">
        <div>
          <h1 className="v3-greeting">{t("companions.title")}</h1>
          <p className="v3-subtitle">{t("companions.subtitle")}</p>
        </div>
      </header>

      <article className="v3-card">
        <header className="v3-card-head">
          <h2 className="v3-card-title">{t("companions.identity")}</h2>
        </header>
        <div className="v3-form">
          <label className="v3-form-row">
            <span className="v3-form-label">{t("companions.name")}</span>
            <input
              type="text"
              className="v3-input"
              value={name}
              maxLength={48}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("companions.placeholder")}
            />
          </label>

          <div className="v3-form-row">
            <span className="v3-form-label">{t("companions.image")}</span>
            <div className="v3-avatar-row">
              <div className="v3-avatar-preview">
                {image ? (
                  <img src={image} alt="" />
                ) : (
                  <div className="v3-avatar-empty">
                    <ImageIcon size={20} />
                    <span>{t("companions.no_image")}</span>
                  </div>
                )}
              </div>
              <div className="v3-avatar-controls">
                <label className="v3-btn-ghost v3-btn-sm">
                  {t("companions.choose_image")}
                  <input
                    type="file"
                    accept="image/*"
                    style={{ display: "none" }}
                    onChange={(e) => handleFile(e.target.files?.[0])}
                  />
                </label>
                {image && (
                  <button
                    className="v3-btn-ghost v3-btn-sm"
                    onClick={() => setImage(null)}
                  >
                    <Trash2 size={13} strokeWidth={2} />
                    {t("companions.remove")}
                  </button>
                )}
                <p className="v3-form-hint">{t("companions.image_hint")}</p>
                {imgError && (
                  <p className="v3-form-error" role="alert" aria-live="polite">
                    {imgError}
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      </article>
    </div>
  );
}
