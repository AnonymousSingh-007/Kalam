import { useState } from 'react'
import type { RocketParams } from '../types'

interface ParamPanelProps {
  onLaunch: (params: RocketParams) => void
  disabled?: boolean
}

const DEFAULT_PARAMS: RocketParams = {
  thrust: 2200,       // N — was 15000, way too punchy
  dryMass: 15,         // kg — was 50
  propellantMass: 20,  // kg — was 100
  burnRate: 1.2,       // kg/s -> ~17s burn, was 5
  dragCoefficient: 0.5,
  crossSectionArea: 0.05  // m^2 — was 0.3, too wide for a small model rocket
}

export function ParamPanel({ onLaunch, disabled }: ParamPanelProps) {
  const [params, setParams] = useState<RocketParams>(DEFAULT_PARAMS)

  function update<K extends keyof RocketParams>(key: K, value: string) {
    const num = parseFloat(value)
    setParams((prev) => ({ ...prev, [key]: isNaN(num) ? 0 : num }))
  }

  return (
    <div className="param-panel">
      <h2>Launch Parameters</h2>

      <label>
        Thrust (N)
        <input
          type="number"
          value={params.thrust}
          onChange={(e) => update('thrust', e.target.value)}
          disabled={disabled}
        />
      </label>

      <label>
        Dry Mass (kg)
        <input
          type="number"
          value={params.dryMass}
          onChange={(e) => update('dryMass', e.target.value)}
          disabled={disabled}
        />
      </label>

      <label>
        Propellant Mass (kg)
        <input
          type="number"
          value={params.propellantMass}
          onChange={(e) => update('propellantMass', e.target.value)}
          disabled={disabled}
        />
      </label>

      <label>
        Burn Rate (kg/s)
        <input
          type="number"
          value={params.burnRate}
          onChange={(e) => update('burnRate', e.target.value)}
          disabled={disabled}
        />
      </label>

      <label>
        Drag Coefficient
        <input
          type="number"
          step="0.05"
          value={params.dragCoefficient}
          onChange={(e) => update('dragCoefficient', e.target.value)}
          disabled={disabled}
        />
      </label>

      <label>
        Cross-Section Area (m²)
        <input
          type="number"
          step="0.05"
          value={params.crossSectionArea}
          onChange={(e) => update('crossSectionArea', e.target.value)}
          disabled={disabled}
        />
      </label>

      <button onClick={() => onLaunch(params)} disabled={disabled}>
        Launch
      </button>
    </div>
  )
}