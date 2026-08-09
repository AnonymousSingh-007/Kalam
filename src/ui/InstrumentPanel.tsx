import type { Telemetry } from '../types'

interface InstrumentPanelProps {
  telemetry: Telemetry | null
}

export function InstrumentPanel({ telemetry }: InstrumentPanelProps) {
  const altitude = telemetry?.altitude ?? 0
  const velocity = telemetry?.velocity ?? 0

  return (
    <div className="instrument-panel">
      <Gauge label="ALT" value={altitude} unit="m" max={10000} color="#4ade80" />
      <Gauge label="VEL" value={velocity} unit="m/s" max={500} color="#ff9100" />
    </div>
  )
}

function Gauge({
  label,
  value,
  unit,
  max,
  color
}: {
  label: string
  value: number
  unit: string
  max: number
  color: string
}) {
  const pct = Math.min(Math.max(Math.abs(value) / max, 0), 1)
  const circumference = 2 * Math.PI * 34
  const offset = circumference * (1 - pct)

  return (
    <div className="gauge">
      <svg viewBox="0 0 80 80" className="gauge-svg">
        <circle cx="40" cy="40" r="34" className="gauge-track" />
        <circle
          cx="40"
          cy="40"
          r="34"
          stroke={color}
          strokeWidth="4"
          fill="none"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          transform="rotate(-90 40 40)"
          className="gauge-arc"
        />
      </svg>
      <div className="gauge-readout">
        <span className="gauge-label">{label}</span>
        <span className="gauge-value">{value.toFixed(0)}</span>
        <span className="gauge-unit">{unit}</span>
      </div>
    </div>
  )
}