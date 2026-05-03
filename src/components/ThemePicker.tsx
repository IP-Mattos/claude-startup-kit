import { useEffect, useMemo, useRef, useState } from "react";
import { Settings, Search, X, Image as ImageIcon, Trash2, User } from "lucide-react";
import { THEMES, type Theme } from "../types";

type Props = {
  theme: Theme;
  onChange: (t: Theme) => void;
  companionName: string;
  onCompanionNameChange: (name: string) => void;
  companionImage: string | null;
  onCompanionImageChange: (img: string | null) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export function ThemePicker({
  theme,
  onChange,
  companionName,
  onCompanionNameChange,
  companionImage,
  onCompanionImageChange,
  open: openProp,
  onOpenChange,
}: Props) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = openProp !== undefined;
  const open = isControlled ? openProp : internalOpen;
  const setOpen = (next: boolean) => {
    if (!isControlled) setInternalOpen(next);
    onOpenChange?.(next);
  };
  const [query, setQuery] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);

  // ESC closes modal
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open]);

  // Reset query each time modal opens
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const filteredThemes = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return THEMES;
    return THEMES.filter((t) => t.toLowerCase().includes(q));
  }, [query]);

  const handleFile = (file: File | undefined) => {
    setImageError(null);
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setImageError("El archivo no es una imagen.");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setImageError("La imagen pesa más de 2 MB. Usá una más chica.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        onCompanionImageChange(reader.result);
      }
    };
    reader.onerror = () => setImageError("No se pudo leer el archivo.");
    reader.readAsDataURL(file);
  };

  return (
    <div className="theme-picker">
      <button
        className="ghost icon-btn"
        onClick={() => setOpen(true)}
        title="Preferencias"
        aria-label="Abrir preferencias"
      >
        <Settings size={14} />
      </button>

      {open && (
        <div
          className="prefs-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
          role="dialog"
          aria-modal="true"
          aria-label="Preferencias"
        >
          <div className="prefs-modal">
            <header className="prefs-header">
              <h2>Preferencias</h2>
              <button
                className="prefs-close"
                onClick={() => setOpen(false)}
                aria-label="Cerrar"
              >
                <X size={16} />
              </button>
            </header>

            <div className="prefs-body">
              {/* === Asistente === */}
              <section className="prefs-section">
                <h3 className="prefs-section-title">
                  <User size={14} /> Asistente
                </h3>

                <div className="prefs-field">
                  <label htmlFor="companion-name">Nombre</label>
                  <input
                    id="companion-name"
                    type="text"
                    className="prefs-input"
                    value={companionName}
                    placeholder="Compañera"
                    maxLength={48}
                    onChange={(e) => onCompanionNameChange(e.target.value)}
                  />
                </div>

                <div className="prefs-field">
                  <label>Imagen</label>
                  <div className="prefs-avatar-row">
                    <div className="prefs-avatar-preview">
                      {companionImage ? (
                        <img src={companionImage} alt="Vista previa" />
                      ) : (
                        <div className="prefs-avatar-empty">
                          <ImageIcon size={24} />
                          <span>sin imagen</span>
                        </div>
                      )}
                    </div>
                    <div className="prefs-avatar-controls">
                      <button
                        className="ghost"
                        onClick={() => fileInputRef.current?.click()}
                      >
                        Elegir imagen
                      </button>
                      {companionImage && (
                        <button
                          className="ghost icon-btn"
                          onClick={() => {
                            onCompanionImageChange(null);
                            setImageError(null);
                          }}
                          title="Quitar imagen"
                          aria-label="Quitar imagen"
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*"
                        style={{ display: "none" }}
                        onChange={(e) => handleFile(e.target.files?.[0])}
                      />
                      <p className="prefs-hint">
                        PNG, JPG o WebP — hasta 2 MB.
                      </p>
                      {imageError && (
                        <p className="prefs-error">{imageError}</p>
                      )}
                    </div>
                  </div>
                </div>
              </section>

              {/* === Tema === */}
              <section className="prefs-section">
                <h3 className="prefs-section-title">Tema</h3>

                <div className="prefs-search">
                  <Search size={13} />
                  <input
                    type="text"
                    placeholder="Buscar tema…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    autoFocus
                  />
                </div>

                <div className="prefs-theme-grid">
                  {filteredThemes.length === 0 ? (
                    <div className="prefs-empty">
                      Ningún tema coincide con "{query}".
                    </div>
                  ) : (
                    filteredThemes.map((t) => (
                      <button
                        key={t}
                        className={
                          "prefs-theme-card" + (t === theme ? " active" : "")
                        }
                        onClick={() => onChange(t)}
                        title={t}
                      >
                        <span className={`theme-swatch theme-${t}`} />
                        <span className="prefs-theme-name">{t}</span>
                        {t === theme && (
                          <span className="prefs-theme-dot" aria-hidden="true" />
                        )}
                      </button>
                    ))
                  )}
                </div>
                <p className="prefs-hint">
                  {THEMES.length} temas · click para aplicar
                </p>
              </section>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
