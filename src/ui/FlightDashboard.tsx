/**
 * FlightDashboard.tsx — cyberpunk-styled per-phase telemetry graphs for
 * the post-flight report. Pure presentation: takes the SeriesData[] and
 * FlightPhase[] that postFlightReport.ts already derived from the
 * sampled flight history, and draws them as a stack of neon line charts
 * with phase bands and dividers behind them.
 *
 * Hand-rolled inline SVG rather than a charting library — there's no
 * charting dependency already in this project, and these are small,
 * fixed-shape line charts (one polyline + axis labels + phase bands),
 * well within what's reasonable to draw by hand without pulling in a
 * new dependency for it.
 */
import type { SeriesData, FlightPhase } from '../postFlightReport'

interface Props {
  series: SeriesData[]
  phases: FlightPhase[]
}

const PHASE_COLOR: Record<string, string> = {
  'pre-launch': 'rgba(0, 240, 255, 0.06)',
  'powered-ascent': 'rgba(255, 43, 214, 0.08)',
  coast: 'rgba(160, 107, 255, 0.07)',
  apogee: 'rgba(255, 209, 102, 0.1)',
  descent: 'rgba(124, 255, 107, 0.07)',
}

const CHART_W = 640
const CHART_H = 130
const PAD_L = 42
const PAD_R = 10
const PAD_T = 10
const PAD_B = 20

function niceMax(v: number): number {
  if (v <= 0) return 1
  const mag = Math.pow(10, Math.floor(Math.log10(v)))
  const norm = v / mag
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10
  return step * mag
}

function Chart({ s, tMax, phases }: { s: SeriesData; tMax: number; phases: FlightPhase[] }) {
  const vals = s.points.map((p) => p[1])
  const vMin = Math.min(0, ...vals)
  const rawMax = Math.max(...vals, 0.001)
  const vMax = niceMax(rawMax)
  const innerW = CHART_W - PAD_L - PAD_R
  const innerH = CHART_H - PAD_T - PAD_B
  const safeTMax = tMax > 0 ? tMax : 1

  const x = (t: number) => PAD_L + (t / safeTMax) * innerW
  const y = (v: number) => PAD_T + innerH - ((v - vMin) / (vMax - vMin || 1)) * innerH

  const pathD = s.points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(p[0]).toFixed(1)} ${y(p[1]).toFixed(1)}`).join(' ')
  const areaD = s.points.length > 0
    ? `${pathD} L ${x(s.points[s.points.length - 1][0]).toFixed(1)} ${y(vMin).toFixed(1)} L ${x(s.points[0][0]).toFixed(1)} ${y(vMin).toFixed(1)} Z`
    : ''

  return (
    <div className="fd-chart-wrap">
      <div className="fd-chart-title">
        <span className="fd-chart-label">{s.label}</span>
        <span className="fd-chart-unit">{s.unit && `(${s.unit})`}</span>
      </div>
      <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} className="fd-chart-svg" preserveAspectRatio="none">
        <defs>
          <linearGradient id={`fd-grad-${s.label}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={s.color} stopOpacity="0.35" />
            <stop offset="100%" stopColor={s.color} stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* phase bands */}
        {phases.map((p, i) => (
          <rect
            key={i}
            x={x(p.startTime)}
            y={PAD_T}
            width={Math.max(0, x(p.endTime) - x(p.startTime))}
            height={innerH}
            fill={PHASE_COLOR[p.stage] ?? 'transparent'}
          />
        ))}
        {/* phase divider lines */}
        {phases.slice(1).map((p, i) => (
          <line
            key={i}
            x1={x(p.startTime)} x2={x(p.startTime)}
            y1={PAD_T} y2={PAD_T + innerH}
            stroke="rgba(160,190,255,0.18)" strokeDasharray="2,3"
          />
        ))}

        {/* zero line, if the series dips negative */}
        {vMin < 0 && (
          <line x1={PAD_L} x2={CHART_W - PAD_R} y1={y(0)} y2={y(0)} stroke="rgba(255,255,255,0.15)" />
        )}

        {/* y-axis labels */}
        <text x={PAD_L - 6} y={PAD_T + 4} textAnchor="end" className="fd-axis-text">{fmtAxis(vMax)}</text>
        <text x={PAD_L - 6} y={PAD_T + innerH} textAnchor="end" className="fd-axis-text">{fmtAxis(vMin)}</text>

        {s.points.length > 1 && (
          <>
            <path d={areaD} fill={`url(#fd-grad-${s.label})`} stroke="none" />
            <path d={pathD} fill="none" stroke={s.color} strokeWidth={1.6} style={{ filter: `drop-shadow(0 0 3px ${s.color})` }} />
          </>
        )}
      </svg>
    </div>
  )
}

function fmtAxis(v: number): string {
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)}k`
  if (Math.abs(v) < 1 && v !== 0) return v.toFixed(2)
  return v.toFixed(0)
}

export function FlightDashboard({ series, phases }: Props) {
  if (series.length === 0) return null
  const tMax = Math.max(1, ...series.map((s) => s.points[s.points.length - 1]?.[0] ?? 0))

  return (
    <div className="fd-root">
      {phases.length > 0 && (
        <div className="fd-phase-legend">
          {phases.map((p, i) => (
            <span key={i} className="fd-phase-chip" style={{ borderColor: PHASE_COLOR[p.stage]?.replace('0.0', '0.6') ?? '#888' }}>
              {p.label}
              <span className="fd-phase-time">{p.startTime.toFixed(0)}–{p.endTime.toFixed(0)}s</span>
            </span>
          ))}
        </div>
      )}
      <div className="fd-grid">
        {series.map((s) => <Chart key={s.label} s={s} tMax={tMax} phases={phases} />)}
      </div>
    </div>
  )
}