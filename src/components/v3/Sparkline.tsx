// Pure-SVG sparkline. No dependency, no canvas, no animation.
//
// Used by the data-dense theme to give numeric KPIs a 30-day shape so
// the user reads "trend" at a glance instead of just "current value".
// Renders nothing if `data` is empty or all-zero — avoids drawing a
// flat line that suggests "no signal" when really it's "no data".
//
// Why inline SVG, not a chart library: a) zero bundle weight, b) lives
// inside the existing div+CSS layout (no Canvas resize gotchas), c) the
// data-dense aesthetic is intentionally minimal — a 60×16 polyline is
// the right level of detail.

interface SparklineProps {
  /** Sequence of numbers, oldest → newest. Length 1-60 reasonable. */
  data: number[];
  /** Pixel width. Default fits the dense KPI cards. */
  width?: number;
  /** Pixel height. Default fits the dense KPI cards. */
  height?: number;
  /** Stroke colour. Default uses the active theme's accent var. */
  color?: string;
  /** Optional accessible description. */
  label?: string;
}

export function Sparkline({
  data,
  width = 64,
  height = 18,
  color = "currentColor",
  label,
}: SparklineProps) {
  if (!data || data.length === 0) return null;
  // Filter to numbers; bail out if there's no signal at all.
  const nums = data.filter((n) => Number.isFinite(n));
  if (nums.length === 0) return null;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min;
  // Flat line if everything's identical — render at vertical centre.
  const norm =
    span === 0
      ? nums.map(() => height / 2)
      : nums.map((n) => height - ((n - min) / span) * height);
  const stepX = nums.length > 1 ? width / (nums.length - 1) : 0;
  const points = norm.map((y, i) => `${(i * stepX).toFixed(1)},${y.toFixed(1)}`);

  return (
    <svg
      className="v3-sparkline"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role={label ? "img" : "presentation"}
      aria-label={label}
    >
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke={color}
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
