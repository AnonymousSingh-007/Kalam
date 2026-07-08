import type { CountdownState, FingerCount } from '../types'

const HOLD_FRAMES_REQUIRED = 15 // ~0.5s at 30fps, avoids flicker triggering

export class CountdownMachine {
  private state: CountdownState = { phase: 'idle' }
  private listeners: ((s: CountdownState) => void)[] = []

  getState(): CountdownState {
    return this.state
  }

  onChange(cb: (s: CountdownState) => void): void {
    this.listeners.push(cb)
  }

  private emit(): void {
    for (const cb of this.listeners) cb(this.state)
  }

  start(): void {
    this.state = { phase: 'counting', expected: 5, heldFrames: 0 }
    this.emit()
  }

  reset(): void {
    this.state = { phase: 'idle' }
    this.emit()
  }

  // Call every frame with the latest finger count reading (or null)
  tick(reading: FingerCount): void {
    if (this.state.phase !== 'counting') return

    const { expected, heldFrames } = this.state

    if (reading === expected) {
      const newHeld = heldFrames + 1
      if (newHeld >= HOLD_FRAMES_REQUIRED) {
        const next = (expected as number) - 1
        if (next < 0) {
          this.state = { phase: 'armed' }
        } else {
          this.state = {
            phase: 'counting',
            expected: next as FingerCount,
            heldFrames: 0
          }
        }
      } else {
        this.state = { phase: 'counting', expected, heldFrames: newHeld }
      }
    } else {
      // Reading doesn't match — reset the hold, don't reset the countdown
      this.state = { phase: 'counting', expected, heldFrames: 0 }
    }
    this.emit()
  }

  // Called externally once armed + launch conditions (params set) are met
  launch(): void {
    if (this.state.phase === 'armed') {
      this.state = { phase: 'launched' }
      this.emit()
    }
  }
}