import { FrameCorners } from "./FrameCorners";

// Generic suspense fallback for lazy-loaded views.
export function ViewSkeleton() {
  return (
    <ul className="projects" aria-busy="true" aria-label="Cargando…">
      {[0, 1, 2, 3].map((i) => (
        <li key={i} className="project skeleton">
          <FrameCorners />
          <div className="project-main">
            <div className="sk-line" style={{ width: "40%", height: 16 }} />
            <div className="sk-line" style={{ width: "70%", height: 12, marginTop: 6 }} />
            <div className="sk-line" style={{ width: "55%", height: 12, marginTop: 8 }} />
          </div>
        </li>
      ))}
    </ul>
  );
}
