import { useState } from 'react'
import type { RocketParams } from '../types'

interface ParamPanelProps {
  onLaunch: (params: RocketParams) => void
  disabled?: boolean
}

const DEFAULT_PARAMS: RocketParams = {
  thrust: 15000, // N
  dryMass: 50, // kg
  propellantMass: 100, // kg
  burnRate: 5, // kg/s -> 20s burn
  dragCoefficient: 0.5,
  crossSectionArea: 0.3 // m^2
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