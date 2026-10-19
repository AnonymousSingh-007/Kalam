import type { Telemetry } from '../types'

interface InstrumentPanelProps {
  telemetry: Telemetry | null
  isThrusting: boolean
}

export function InstrumentPanel({ telemetry, isThrusting }: InstrumentPanelProps) {
  const altitude = telemetry?.altitude ?? 0
  const velocity = telemetry?.velocity ?? 0
  const axialG = telemetry?.axialGLoad ?? 0
  const aoa = telemetry?.angleOfAttack ?? 0
  const gimbal = telemetry?.gimbalAngle ?? 0
  const mach = telemetry?.machNumber ?? 0
  const qKpa = (telemetry?.dynamicPressure ?? 0) / 1000
  const rcs = telemetry?.rcsFuel ?? 0

  return (
    <div className="instrument-panel">
      <Gauge label="ALT" value={altitude} unit="m" max={10000} color="#4ade80" decimals={0} />
      <Gauge label="VEL" value={velocity} unit="m/s" max={500} color="#ff9100" decimals={1} allowNegative />
      <Gauge label="G-AX" value={axialG} unit="g" max={20} color="#f472b6" decimals={2} allowNegative />
      <Gauge label="AoA" value={aoa} unit="°" max={180} color="#38bdf8" decimals={1} />
      <Gauge label="MACH" value={mach} unit="" max={3} color="#a78bfa" decimals={2} />
      <Gauge label="Q" value={qKpa} unit="kPa" max={80} color="#facc15" decimals={1} />
      <Gauge label="RCS" value={rcs} unit="kg" max={0.6} color="#2dd4bf" decimals={2} />
      {isThrusting && (
        <GimbalIndicator angle={gimbal} />
      )}
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

function Gauge({ label, value, unit, max, color, decimals = 0, allowNegative = false }: GaugeProps) {
  const pct = allowNegative
    ? Math.min(Math.max((value + max) / (2 * max), 0), 1)
    : Math.min(Math.max(value / max, 0), 1)

  const radius = 34
  const circumference = 2 * Math.PI * radius
  const arcFraction = 0.75
  const arcLength = circumference * arcFraction
  const filledLength = arcLength * pct
  const gap = circumference - arcLength
  const startAngle = 135

  const isDanger =
    (label === 'G-AX' && Math.abs(value) > 12) ||
    (label === 'AoA' && value > 25) ||
    (label === 'Q' && value > 60) ||
    (label === 'RCS' && value < 0.05)

  return (
    <div className="gauge" title={`${label}: ${value.toFixed(decimals)} ${unit}`}>
      <svg viewBox="0 0 80 80" className="gauge-svg">
        <circle
          cx="40" cy="40" r={radius}
          fill="none" stroke="#1e2028" strokeWidth="5"
          strokeDasharray={`${arcLength} ${gap}`}
          strokeDashoffset={-gap / 2}
          transform={`rotate(${startAngle} 40 40)`}
          strokeLinecap="round"
        />
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
        {allowNegative && (
          <line x1="40" y1="8" x2="40" y2="14" stroke="#444" strokeWidth="1.5" />
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

// Gimbal indicator — a circle with a dot that moves left/right
// showing current nozzle deflection. Center = neutral, edges = ±6°.
function GimbalIndicator({ angle }: { angle: number }) {
  const GIMBAL_MAX = 6
  const pct = Math.max(-1, Math.min(1, angle / GIMBAL_MAX))   // -1 to +1
  const dotX = 40 + pct * 24                                    // moves ±24px from center
  const isDanger = Math.abs(angle) > 5

  return (
    <div className="gauge gimbal-gauge" title={`Gimbal: ${angle.toFixed(2)}°`}>
      <svg viewBox="0 0 80 80" className="gauge-svg">
        <circle cx="40" cy="40" r="32" fill="none" stroke="#1e2028" strokeWidth="3" />
        <line x1="40" y1="28" x2="40" y2="52" stroke="#2a2d3a" strokeWidth="1" />
        <line x1="16" y1="40" x2="22" y2="40" stroke="#2a2d3a" strokeWidth="1.5" />
        <line x1="58" y1="40" x2="64" y2="40" stroke="#2a2d3a" strokeWidth="1.5" />
        <line x1="16" y1="40" x2="64" y2="40" stroke="#1e2028" strokeWidth="2" />
        <circle
          cx={dotX}
          cy="40"
          r="6"
          fill={isDanger ? '#ef4444' : '#ff9100'}
          style={{ transition: 'cx 0.08s linear' }}
        />
      </svg>
      <div className="gauge-readout">
        <span className="gauge-label">GBL</span>
        <span className="gauge-value" style={{ color: isDanger ? '#ef4444' : '#eee' }}>
          {angle.toFixed(2)}
        </span>
        <span className="gauge-unit">°</span>
      </div>
    </div>
  )
}