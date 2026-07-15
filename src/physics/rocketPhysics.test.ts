import { RocketPhysicsEngine } from './rocketPhysics'
import type { RocketParams } from '../types'

const testParams: RocketParams = {
  thrust: 15000,
  dryMass: 50,
  propellantMass: 100,
  burnRate: 5,
  dragCoefficient: 0.5,
  crossSectionArea: 0.3
}

export function runPhysicsTest() {
  const engine = new RocketPhysicsEngine(testParams)
  engine.launch()

  const dt = 1 / 60
  const logs: string[] = []

  for (let i = 0; i < 60 * 30; i++) {
    // simulate 30 seconds
    const t = engine.step(dt)
    if (i % 30 === 0) {
      // log twice a second
      logs.push(
        `t=${t.time.toFixed(1)}s alt=${t.altitude.toFixed(1)}m vel=${t.velocity.toFixed(1)}m/s mass=${t.mass.toFixed(1)}kg stage=${t.stage}`
      )
    }
  }

  console.log(logs.join('\n'))
  return logs
}