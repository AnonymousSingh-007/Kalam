import type { Telemetry } from '../types'

interface InstrumentPanelProps {
  telemetry: Telemetry | null
}

export function InstrumentPanel({ telemetry }: InstrumentPanelProps) {
  const altitude = telemetry?.altitude ?? 0
  const velocity = telemetry?.velocity ?? 0
  const axialG = telemetry?.axialGLoad ?? 0
  const aoa = telemetry?.angleOfAttack ?? 0

  return (
    <div className="instrument-panel">
      <Gauge
        label="ALT"
        value={altitude}
        unit="m"
        max={10000}
        color="#4ade80"
        decimals={0}
      />
      <Gauge
        label="VEL"
        value={velocity}
        unit="m/s"
        max={500}
        color="#ff9100"
        decimals={1}
        allowNegative
      />
      <Gauge
        label="G-AX"
        value={axialG}
        unit="g"
        max={12}
        color="#f472b6"
        decimals={2}
        allowNegative
      />
      <Gauge
        label="AoA"
        value={aoa}
        unit="°"
        max={30}
        color="#38bdf8"
        decimals={1}
      />
    </div>
  )
}

interface GaugeProps {
  label: string
  value: number
  unit: string
  max: number
  color: string
  decimals?: number
  allowNegative?: boolean
}

function Gauge({
  label,
  value,
  unit,
  max,
  color,
  decimals = 0,
  allowNegative = false
}: GaugeProps) {
  // For negative-capable gauges (velocity during descent, negative g during coast):
  // map [-max, +max] → [0, 1] with 0.5 at zero. For positive-only: [0, max] → [0, 1].
  const pct = allowNegative
    ? Math.min(Math.max((value + max) / (2 * max), 0), 1)
    : Math.min(Math.max(value / max, 0), 1)

  const radius = 34
  const circumference = 2 * Math.PI * radius

  // Arc runs from -135° to +135° (270° sweep), not a full circle.
  // We use stroke-dashoffset on a full-circumference circle but only
  // show 75% of it (270/360), offset by the starting gap.
  const arcFraction = 0.75 // 270 degrees out of 360
  const arcLength = circumference * arcFraction
  const filledLength = arcLength * pct
  const gap = circumference - arcLength

  // Rotate so arc starts bottom-left (-135° from top = 225° from 3 o'clock)
  const startAngle = 135

  // Danger zones: red tick if axial-G > 8g or AoA > 20°
  const isDanger =
    (label === 'G-AX' && Math.abs(value) > 8) ||
    (label === 'AoA' && value > 20)

  return (
    <div className="gauge" title={`${label}: ${value.toFixed(decimals)} ${unit}`}>
      <svg viewBox="0 0 80 80" className="gauge-svg">
        {/* Track arc */}
        <circle
          cx="40" cy="40" r={radius}
          fill="none"
          stroke="#1e2028"
          strokeWidth="5"
          strokeDasharray={`${arcLength} ${gap}`}
          strokeDashoffset={-gap / 2}
          transform={`rotate(${startAngle} 40 40)`}
          strokeLinecap="round"
        />
        {/* Filled arc */}
        <circle
          cx="40" cy="40" r={radius}
          fill="none"
          stroke={isDanger ? '#ef4444' : color}
          strokeWidth="5"
          strokeDasharray={`${filledLength} ${circumference - filledLength}`}
          strokeDashoffset={-gap / 2}
          transform={`rotate(${startAngle} 40 40)`}
          strokeLinecap="round"
          style={{ transition: 'stroke-dasharray 0.15s linear' }}
        />
        {/* Centre tick mark at zero for allowNegative gauges */}
        {allowNegative && (
          <line
            x1="40" y1="8"
            x2="40" y2="14"
            stroke="#444"
            strokeWidth="1.5"
          />
        )}
      </svg>
      <div className="gauge-readout">
        <span className="gauge-label">{label}</span>
        <span className="gauge-value" style={{ color: isDanger ? '#ef4444' : '#eee' }}>
          {value.toFixed(decimals)}
        </span>
        <span className="gauge-unit">{unit}</span>
      </div>
    </div>
  )
}