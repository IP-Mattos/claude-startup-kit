import { memo } from "react";

// Per-corner filigree. CSS class on parent decides which geometry shows
// (fantasy = filigree curl, terminal/bios = bracket+tick, blueprint = crosshair).
export const FrameCorners = memo(function FrameCorners() {
  return (
    <>
      <svg className="frame-corner fc-tl" viewBox="0 0 18 18" aria-hidden="true">
        <path className="fc-fantasy" d="M0 0 L8 0 L8 1 L4 1 L4 2 Q1 2 1 5 L1 8 L0 8 Z M2 4 Q3 3 4 3" stroke="currentColor" strokeWidth="0.8" fill="none" />
        <path className="fc-tech" d="M0 0 L10 0 M0 0 L0 10 M3 0 L3 4 M0 3 L4 3" stroke="currentColor" strokeWidth="1" fill="none" />
        <path className="fc-blue" d="M0 5 L0 0 L5 0 M2 0 L2 2 L0 2" stroke="currentColor" strokeWidth="1" fill="none" />
      </svg>
      <svg className="frame-corner fc-tr" viewBox="0 0 18 18" aria-hidden="true">
        <path className="fc-fantasy" d="M18 0 L10 0 L10 1 L14 1 L14 2 Q17 2 17 5 L17 8 L18 8 Z M16 4 Q15 3 14 3" stroke="currentColor" strokeWidth="0.8" fill="none" />
        <path className="fc-tech" d="M18 0 L8 0 M18 0 L18 10 M15 0 L15 4 M18 3 L14 3" stroke="currentColor" strokeWidth="1" fill="none" />
        <path className="fc-blue" d="M18 5 L18 0 L13 0 M16 0 L16 2 L18 2" stroke="currentColor" strokeWidth="1" fill="none" />
      </svg>
      <svg className="frame-corner fc-bl" viewBox="0 0 18 18" aria-hidden="true">
        <path className="fc-fantasy" d="M0 18 L8 18 L8 17 L4 17 L4 16 Q1 16 1 13 L1 10 L0 10 Z M2 14 Q3 15 4 15" stroke="currentColor" strokeWidth="0.8" fill="none" />
        <path className="fc-tech" d="M0 18 L10 18 M0 18 L0 8 M3 18 L3 14 M0 15 L4 15" stroke="currentColor" strokeWidth="1" fill="none" />
        <path className="fc-blue" d="M0 13 L0 18 L5 18 M2 18 L2 16 L0 16" stroke="currentColor" strokeWidth="1" fill="none" />
      </svg>
      <svg className="frame-corner fc-br" viewBox="0 0 18 18" aria-hidden="true">
        <path className="fc-fantasy" d="M18 18 L10 18 L10 17 L14 17 L14 16 Q17 16 17 13 L17 10 L18 10 Z M16 14 Q15 15 14 15" stroke="currentColor" strokeWidth="0.8" fill="none" />
        <path className="fc-tech" d="M18 18 L8 18 M18 18 L18 8 M15 18 L15 14 M18 15 L14 15" stroke="currentColor" strokeWidth="1" fill="none" />
        <path className="fc-blue" d="M18 13 L18 18 L13 18 M16 18 L16 16 L18 16" stroke="currentColor" strokeWidth="1" fill="none" />
      </svg>
    </>
  );
});
