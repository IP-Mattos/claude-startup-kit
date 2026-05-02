import { useState } from "react";
import { Palette } from "lucide-react";
import { THEMES, type Theme } from "../types";

export function ThemePicker({
  theme,
  onChange,
}: {
  theme: Theme;
  onChange: (t: Theme) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="theme-picker">
      <button className="ghost icon-btn" onClick={() => setOpen((o) => !o)} title="Tema">
        <Palette size={14} />
      </button>
      {open && (
        <div className="theme-menu" onMouseLeave={() => setOpen(false)}>
          {THEMES.map((t) => (
            <button
              key={t}
              className={"theme-option" + (t === theme ? " active" : "")}
              onClick={() => {
                onChange(t);
                setOpen(false);
              }}
            >
              <span className={`theme-swatch theme-${t}`} />
              {t}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
