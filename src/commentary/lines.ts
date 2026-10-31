import type { CommentaryTrigger } from '../types'

export interface CommentaryLine {
  trigger: CommentaryTrigger
  text: string
}

// CommentaryData is kept as an export for backward compatibility with
// anything still importing the type, but lines no longer read live
// telemetry values into their wording — every line below is a fixed,
// pre-written string. Reading a number into a spoken/displayed line
// couples the commentary to render-frame timing (which tick's value
// happened to be current when the line fired) and reads as a HUD
// readout rather than a called-out flight event; mission-control-style
// callouts describe what's happening, not what the gauges say, since the
// instrument panel already shows the numbers continuously.
export interface CommentaryData {
  altitude: number
  velocity: number
  axialGLoad: number
  lateralGLoad: number
  angleOfAttack: number
  time: number
}

export const COMMENTARY_LINES: CommentaryLine[] = [
  // ---- countdown ----
  { trigger: 'countdown', text: "Countdown in progress." },
  { trigger: 'countdown', text: "Crew interface reporting nominal hand-tracking lock." },
  { trigger: 'countdown', text: "Final countdown sequence underway." },
  { trigger: 'countdown', text: "Holding for confirmed gesture input." },
  { trigger: 'countdown', text: "Countdown proceeding. Standing by for launch authorization." },
  { trigger: 'countdown', text: "Range is green. Awaiting final count." },

  // ---- pre-launch ----
  { trigger: 'pre-launch', text: "Vehicle parameters locked. Configuration finalized." },
  { trigger: 'pre-launch', text: "Propellant load confirmed. Standing by for launch." },
  { trigger: 'pre-launch', text: "Pre-launch checklist complete. Vehicle is go for launch." },
  { trigger: 'pre-launch', text: "All systems report go. Awaiting terminal count." },
  { trigger: 'pre-launch', text: "Flight computer armed. Holding at the pad." },
  { trigger: 'pre-launch', text: "Range safety clear. Vehicle is go." },

  // ---- ignition ----
  { trigger: 'ignition', text: "Ignition. We have liftoff." },
  { trigger: 'ignition', text: "Engine ignition confirmed. Vehicle has cleared the tower." },
  { trigger: 'ignition', text: "Liftoff. Thrust is nominal." },
  { trigger: 'ignition', text: "Main engine start. Vehicle is clear of the pad." },
  { trigger: 'ignition', text: "Ignition sequence complete. Climbing out." },
  { trigger: 'ignition', text: "Engines at full thrust. Vehicle is away." },

  // ---- ascent (continuous, fires every few seconds through the burn) ----
  { trigger: 'ascent', text: "Powered ascent continuing. Trajectory nominal." },
  { trigger: 'ascent', text: "Engine performance nominal. Vehicle is tracking the planned profile." },
  { trigger: 'ascent', text: "Still under power. All systems report normal." },
  { trigger: 'ascent', text: "Ascent continuing. No anomalies reported." },
  { trigger: 'ascent', text: "Vehicle is tracking nominal. Powered flight continues." },
  { trigger: 'ascent', text: "Thrust nominal. Pitch program proceeding as planned." },
  { trigger: 'ascent', text: "Flight controller reports a clean ascent so far." },
  { trigger: 'ascent', text: "Powered flight continues. Attitude nominal." },
  { trigger: 'ascent', text: "Guidance is tracking the planned ascent profile." },
  { trigger: 'ascent', text: "Vehicle performance remains within nominal limits." },

  // ---- max-q ----
  { trigger: 'max-q', text: "Max-Q. Vehicle is now through the period of peak aerodynamic load." },
  { trigger: 'max-q', text: "Passing through maximum dynamic pressure." },
  { trigger: 'max-q', text: "Max-Q confirmed. Structural loads peaking and easing." },
  { trigger: 'max-q', text: "Through the max-Q region. Vehicle is structurally sound." },
  { trigger: 'max-q', text: "Dynamic pressure past its peak. Proceeding through ascent." },

  // ---- burnout ----
  { trigger: 'burnout', text: "Main engine cutoff. Propellant depleted." },
  { trigger: 'burnout', text: "MECO confirmed. Vehicle is now in unpowered flight." },
  { trigger: 'burnout', text: "Engine shutdown. Coasting on momentum." },
  { trigger: 'burnout', text: "Burnout confirmed. Powered ascent complete." },
  { trigger: 'burnout', text: "Cutoff confirmed. Vehicle is now ballistic." },

  // ---- coast ----
  { trigger: 'coast', text: "Coast phase. No thrust, trajectory nominal." },
  { trigger: 'coast', text: "Vehicle continuing upward on momentum alone." },
  { trigger: 'coast', text: "Unpowered ascent continuing. Tracking nominal." },
  { trigger: 'coast', text: "Coasting toward apogee. All systems nominal." },
  { trigger: 'coast', text: "Ballistic trajectory confirmed. No anomalies." },

  // ---- apogee ----
  { trigger: 'apogee', text: "Apogee. Vehicle has reached peak altitude." },
  { trigger: 'apogee', text: "Peak altitude confirmed. Vertical velocity at zero." },
  { trigger: 'apogee', text: "Apogee reached. Beginning the descent phase." },
  { trigger: 'apogee', text: "Vehicle at apogee. Trajectory now reversing." },

  // ---- descent ----
  { trigger: 'descent', text: "Descent confirmed. Vehicle is returning to the ground." },
  { trigger: 'descent', text: "Entering descent phase." },
  { trigger: 'descent', text: "Vehicle descending. Recovery sequence standing by." },
  { trigger: 'descent', text: "Descent underway. Monitoring for recovery deployment." },

  // ---- landed ----
  { trigger: 'landed', text: "Touchdown confirmed. Flight complete." },
  { trigger: 'landed', text: "Vehicle has landed. Mission concluded." },
  { trigger: 'landed', text: "Contact confirmed. End of flight." },
  { trigger: 'landed', text: "Flight terminated at touchdown. Recovery can proceed." },

  // ---- event-reactive: high G ----
  { trigger: 'high-g', text: "High axial load detected. Monitoring structural margins." },
  { trigger: 'high-g', text: "Axial acceleration elevated. Structure holding within limits." },
  { trigger: 'high-g', text: "Load factor elevated. Flight controller monitoring closely." },

  // ---- event-reactive: steep AoA ----
  { trigger: 'high-aoa', text: "Angle of attack elevated. Monitoring vehicle stability." },
  { trigger: 'high-aoa', text: "Significant aerodynamic sideslip detected." },
  { trigger: 'high-aoa', text: "Attitude deviation noted. Guidance compensating." },

  // ---- event-reactive: fast descent ----
  { trigger: 'fast-descent', text: "Descent rate elevated. Monitoring for recovery deployment." },
  { trigger: 'fast-descent', text: "High descent rate detected. Awaiting chute deployment." },
  { trigger: 'fast-descent', text: "Rate of descent above nominal. Recovery system standing by." },
]

export function getLine(trigger: CommentaryTrigger, _data: CommentaryData, exclude: Set<string>): string {
  const options = COMMENTARY_LINES.filter((l) => l.trigger === trigger && !exclude.has(l.text))
  if (options.length === 0) {
    // All lines for this trigger were excluded — fall back to the full
    // set for this trigger, ignoring the exclusion set, rather than
    // return nothing.
    const fallback = COMMENTARY_LINES.filter((l) => l.trigger === trigger)
    if (fallback.length === 0) return ''
    return fallback[Math.floor(Math.random() * fallback.length)].text
  }
  return options[Math.floor(Math.random() * options.length)].text
}