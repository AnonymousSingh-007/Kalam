import { VEHICLES } from '../render/buildRocket'
import './VehicleSelect.css'

interface Props {
  index: number
  lastGesture: string
  onStep: (dir: 1 | -1) => void
  onConfirm: () => void
}

export function VehicleSelect({ index, lastGesture, onStep, onConfirm }: Props) {
  const v = VEHICLES[index]
  return (
    <div className="vsel">
      <button className="vsel-arrow vsel-left" onClick={() => onStep(-1)} aria-label="Previous vehicle">‹</button>
      <button className="vsel-arrow vsel-right" onClick={() => onStep(1)} aria-label="Next vehicle">›</button>

      <div className="vsel-card">
        <div className="vsel-role">{v.role}</div>
        <div className="vsel-name">{v.name}</div>
        <div className="vsel-blurb">{v.blurb}</div>
        <div className="vsel-dots">
          {VEHICLES.map((x, i) => (
            <span key={x.id} className={i === index ? 'on' : ''} />
          ))}
        </div>
        <button className="vsel-confirm" onClick={onConfirm}>Select &amp; start countdown</button>
        <div className="vsel-hint">
          Swipe an open hand sideways to browse · Clap (or press Enter) to confirm · ← → keys also work
        </div>
        {lastGesture && <div className="vsel-gesture">{lastGesture}</div>}
      </div>
    </div>
  )
}