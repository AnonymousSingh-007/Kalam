import { useState, useMemo } from 'react'
import type { RocketParams } from '../types'

interface ParamPanelProps {
  onLaunch: (params: RocketParams) => void
  disabled?: boolean
}

const DEFAULT_PARAMS: RocketParams = {
  thrust: 2200,
  dryMass: 15,
  propellantMass: 20,
  burnRate: 1.2,
  dragCoefficient: 0.5,
  crossSectionArea: 0.05
}

const GRAVITY = 9.81

interface FieldConfig {
  key: keyof RocketParams
  label: string
  unit: string
  help: string
  step?: string
}

const FIELDS: FieldConfig[] = [
  {
    key: 'thrust',
    label: 'Thrust',
    unit: 'N',
    help: 'Engine force. Must exceed total weight at liftoff or the rocket won\'t leave the pad.'
  },
  {
    key: 'dryMass',
    label: 'Dry Mass',
    unit: 'kg',
    help: 'Structure + payload, excluding fuel. This is what remains after burnout.'
  },
  {
    key: 'propellantMass',
    label: 'Propellant Mass',
    unit: 'kg',
    help: 'Fuel available at launch. Burns down to zero over the powered-ascent phase.'
  },
  {
    key: 'burnRate',
    label: 'Burn Rate',
    unit: 'kg/s',
    help: 'How fast fuel is consumed. Propellant ÷ burn rate = total burn duration.',
    step: '0.1'
  },
  {
    key: 'dragCoefficient',
    label: 'Drag Coefficient',
    unit: '—',
    help: 'Aerodynamic shape factor. Lower = sleeker. Real rockets: ~0.3–0.75.',
    step: '0.05'
  },
  {
    key: 'crossSectionArea',
    label: 'Cross-Section',
    unit: 'm²',
    help: 'Frontal area exposed to airflow. Larger = more drag at the same speed.',
    step: '0.01'
  }
]

export function ParamPanel({ onLaunch, disabled }: ParamPanelProps) {
  const [params, setParams] = useState<RocketParams>(DEFAULT_PARAMS)

  function update(key: keyof RocketParams, value: string) {
    const num = parseFloat(value)
    setParams((prev) => ({ ...prev, [key]: isNaN(num) ? 0 : num }))
  }

  const derived = useMemo(() => {
    const totalMass = params.dryMass + params.propellantMass
    const weight = totalMass * GRAVITY
    const twRatio = weight > 0 ? params.thrust / weight : 0
    const burnDuration =
      params.burnRate > 0 ? params.propellantMass / params.burnRate : 0
    return { totalMass, weight, twRatio, burnDuration }
  }, [params])

  const canLiftOff = derived.twRatio > 1

  return (
    <div className="param-panel">
      <h2>Launch Parameters</h2>

      {FIELDS.map((field) => (
        <label key={field.key} title={field.help}>
          <span className="field-label">
            {field.label}
            <span className="field-help">{field.help}</span>
          </span>
          <span className="field-input-group">
            <input
              type="number"
              step={field.step ?? '1'}
              value={params[field.key]}
              onChange={(e) => update(field.key, e.target.value)}
              disabled={disabled}
            />
            <span className="field-unit">{field.unit}</span>
          </span>
        </label>
      ))}

      <div className="derived-stats">
        <div className="derived-row">
          <span>Total mass at liftoff</span>
          <strong>{derived.totalMass.toFixed(1)} kg</strong>
        </div>
        <div className="derived-row">
          <span>Weight (gravity force)</span>
          <strong>{derived.weight.toFixed(0)} N</strong>
        </div>
        <div className="derived-row">
          <span>Thrust-to-weight ratio</span>
          <strong className={canLiftOff ? 'stat-ok' : 'stat-bad'}>
            {derived.twRatio.toFixed(2)}:1
          </strong>
        </div>
        <div className="derived-row">
          <span>Burn duration</span>
          <strong>{derived.burnDuration.toFixed(1)} s</strong>
        </div>
        {!canLiftOff && (
          <p className="warning-text">
            Thrust-to-weight ratio must exceed 1:1 to lift off. Increase
            thrust or reduce mass.
          </p>
        )}
      </div>

      <button onClick={() => onLaunch(params)} disabled={disabled || !canLiftOff}>
        Launch
      </button>
    </div>
  )
}