import type { CommentaryTrigger } from '../types'

export interface CommentaryLine {
  trigger: CommentaryTrigger
  // text can be a string or a function that receives live telemetry values
  text: string | ((data: CommentaryData) => string)
  // minimum condition to fire — optional guard so telemetry lines
  // don't fire when the value isn't interesting yet
  guard?: (data: CommentaryData) => boolean
}

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
  { trigger: 'countdown', text: "Five fingers. Bold opening statement." },
  { trigger: 'countdown', text: "Counting down. Try not to sneeze." },
  { trigger: 'countdown', text: "Your hand is doing more engineering than the rocket right now." },
  { trigger: 'countdown', text: "Almost there. The rocket is watching. It's nervous too." },
  { trigger: 'countdown', text: "T-minus whatever your hand says." },
  { trigger: 'countdown', text: "Biometric launch authorization. Very fancy. Very unnecessary." },
  { trigger: 'countdown', text: "Each finger you lower is a promise to physics." },
  { trigger: 'countdown', text: "Hand tracking nominal. Sanity: unconfirmed." },

  // ---- pre-launch ----
  { trigger: 'pre-launch', text: "Parameters locked in. No refunds past this point." },
  { trigger: 'pre-launch', text: "Numbers submitted. Let's see if you paid attention in physics." },
  { trigger: 'pre-launch', text: "Configuration locked. There's no undo button on a launch." },
  { trigger: 'pre-launch', text: "All systems are go. Whether they should be is a separate question." },
  { trigger: 'pre-launch', text: "Propellant loaded. Prayers optional but not discouraged." },
  { trigger: 'pre-launch', text: "This is fine. Everything is fine. Launch is go." },
  { trigger: 'pre-launch', text: "Pre-launch checks complete. Some of them, anyway." },
  { trigger: 'pre-launch', text: "Fingers crossed. Literally, apparently, given how we got here." },

  // ---- ignition ----
  { trigger: 'ignition', text: "And we have liftoff. Physics, don't embarrass me." },
  { trigger: 'ignition', text: "Engines lit. This is the part where we find out if you did the math right." },
  { trigger: 'ignition', text: "Ground control has left the chat." },
  { trigger: 'ignition', text: "Thrust exceeds weight. Technically that counts as flying." },
  { trigger: 'ignition', text: "T-zero. The pad is someone else's problem now." },
  { trigger: 'ignition', text: "Liftoff confirmed. The rocket is aggressively leaving." },
  { trigger: 'ignition', text: "Engines at full thrust. The ground strongly disagrees with this." },
  {
    trigger: 'ignition',
    text: (d) => `${d.axialGLoad.toFixed(1)}g at ignition. The rocket is not subtle about this.`
  },

  // ---- max-q ----
  { trigger: 'max-q', text: "Max aerodynamic pressure. The rocket is currently having a bad time." },
  { trigger: 'max-q', text: "This is statistically the most likely moment for things to go wrong. Cool, cool." },
  { trigger: 'max-q', text: "Peak dynamic pressure. The rocket would like a moment." },
  { trigger: 'max-q', text: "The atmosphere is pushing back. Hard." },
  { trigger: 'max-q', text: "Structure holding. Barely counts as a compliment but here we are." },
  { trigger: 'max-q', text: "We are through max-Q. Everything from here is structurally more relaxing." },
  {
    trigger: 'max-q',
    text: (d) => `Max-Q at ${d.altitude.toFixed(0)}m. The air up here has opinions.`
  },
  {
    trigger: 'max-q',
    text: (d) => `${d.velocity.toFixed(0)} metres per second through peak pressure. Aggressive.`
  },

  // ---- burnout ----
  { trigger: 'burnout', text: "Fuel's gone. We're coasting on vibes now." },
  { trigger: 'burnout', text: "Engine cutoff. Everything from here is just momentum and hope." },
  { trigger: 'burnout', text: "MECO. We are now a very expensive ballistic object." },
  { trigger: 'burnout', text: "Tank empty. The rocket is now a passenger." },
  { trigger: 'burnout', text: "All that fuel, gone in seconds. Rocketry is a humbling field." },
  {
    trigger: 'burnout',
    text: (d) => `Burnout at ${d.altitude.toFixed(0)}m with ${d.velocity.toFixed(0)}m/s. The math checks out.`
  },
  {
    trigger: 'burnout',
    text: (d) => `${d.axialGLoad.toFixed(1)}g at cutoff. From here, gravity takes over.`
  },

  // ---- coast ----
  { trigger: 'coast', text: "Still climbing, no thrust required. Efficient, if nothing else." },
  { trigger: 'coast', text: "Momentum doing all the work now. Everyone else can relax." },
  { trigger: 'coast', text: "Rising on pure inertia. Newton's still got it." },
  { trigger: 'coast', text: "Coast phase. The rocket is gliding on its own confidence." },
  { trigger: 'coast', text: "Ballistic arc in progress. Art, basically." },
  {
    trigger: 'coast',
    text: (d) => `Coasting at ${d.altitude.toFixed(0)}m, still doing ${d.velocity.toFixed(0)}m/s. Impressive.`
  },
  {
    trigger: 'coast',
    text: (d) => `${d.velocity.toFixed(0)} metres per second and no engine running. That's just physics being polite.`
  },

  // ---- apogee ----
  { trigger: 'apogee', text: "Peak altitude reached. It's all downhill from here. Literally." },
  { trigger: 'apogee', text: "Apogee. The one moment this rocket wasn't going up or down. Savor it." },
  { trigger: 'apogee', text: "Zero vertical velocity. A brief, expensive pause." },
  { trigger: 'apogee', text: "This is as far as we go. Gravity has been very patient." },
  { trigger: 'apogee', text: "Top of the arc. Peaceful up here. Won't last." },
  {
    trigger: 'apogee',
    text: (d) => `Apogee at ${d.altitude.toFixed(0)} metres. Dr. Kalam would have done the orbital math by now.`
  },
  {
    trigger: 'apogee',
    text: (d) => `Peak reached: ${d.altitude.toFixed(0)}m. The view is great. The next part is less great.`
  },

  // ---- descent ----
  { trigger: 'descent', text: "And now it falls. Gravity, undefeated since forever." },
  { trigger: 'descent', text: "What goes up. You know the rest." },
  { trigger: 'descent', text: "Falling with style. Or just falling. Hard to say from here." },
  { trigger: 'descent', text: "Descent confirmed. Physics remains undefeated." },
  {
    trigger: 'descent',
    text: (d) => `Descending from ${d.altitude.toFixed(0)}m at ${Math.abs(d.velocity).toFixed(0)}m/s downward. The ground is approaching with enthusiasm.`
  },
  {
    trigger: 'descent',
    text: (d) => `${Math.abs(d.velocity).toFixed(0)} metres per second, downward. Drag is doing its best.`
  },

  // ---- landed ----
  { trigger: 'landed', text: "Touchdown. Or impact. The telemetry doesn't really editorialize." },
  { trigger: 'landed', text: "Flight complete. Go ahead, adjust the numbers and do it again." },
  { trigger: 'landed', text: "Mission concluded. The data doesn't lie, even when it's unflattering." },
  { trigger: 'landed', text: "Contact. That's a wrap on this one." },
  { trigger: 'landed', text: "End of flight. The pad team would like a word about the scorch marks." },
  {
    trigger: 'landed',
    text: (d) => `Landed after ${d.time.toFixed(1)} seconds. ${d.time < 30 ? "Short flight. Bold attempt." : d.time < 60 ? "Respectable flight time." : "That was a proper mission."}`
  },
  {
    trigger: 'landed',
    text: (d) => `Impact velocity: ${Math.abs(d.velocity).toFixed(1)}m/s. ${Math.abs(d.velocity) > 50 ? "That's not a landing, that's a geological event." : Math.abs(d.velocity) > 20 ? "Firm but survivable. Probably." : "Clean touchdown."}`
  },

  // ---- event-reactive: high G ----
  { trigger: 'high-g', text: "G-load is getting uncomfortable. The rocket disagrees with this trajectory." },
  { trigger: 'high-g', text: "Structural margins are being consulted right now." },
  {
    trigger: 'high-g',
    text: (d) => `${d.axialGLoad.toFixed(1)}g axial load. Things are getting physically intense.`
  },
  {
    trigger: 'high-g',
    text: (d) => `${d.axialGLoad.toFixed(1)}g. For reference, fighter pilots black out at around 9g. Just saying.`
  },

  // ---- event-reactive: steep AoA ----
  { trigger: 'high-aoa', text: "Angle of attack is climbing. The rocket is developing opinions about its direction." },
  { trigger: 'high-aoa', text: "That's a lot of lateral drift. Wind is winning this argument." },
  {
    trigger: 'high-aoa',
    text: (d) => `${d.angleOfAttack.toFixed(1)} degrees angle of attack. Stability is a suggestion at this point.`
  },
  {
    trigger: 'high-aoa',
    text: (d) => `AoA at ${d.angleOfAttack.toFixed(1)}°. Real rockets have guidance computers for exactly this reason.`
  },

  // ---- event-reactive: fast descent ----
  { trigger: 'fast-descent', text: "Velocity on the way down is ambitious. The ground is not moving." },
  { trigger: 'fast-descent', text: "Coming in fast. Very fast. Concerningly fast." },
  {
    trigger: 'fast-descent',
    text: (d) => `${Math.abs(d.velocity).toFixed(0)}m/s downward. Terminal velocity is a term that feels relevant here.`
  },
  {
    trigger: 'fast-descent',
    text: (d) => `Descending at ${Math.abs(d.velocity).toFixed(0)}m/s. The drag coefficient is trying its best.`
  }
]

export function getLine(trigger: CommentaryTrigger, data: CommentaryData, exclude: Set<string>): string {
  const options = COMMENTARY_LINES.filter((l) => {
    if (l.trigger !== trigger) return false
    if (l.guard && !l.guard(data)) return false
    const text = typeof l.text === 'function' ? l.text(data) : l.text
    return !exclude.has(text)
  })
  if (options.length === 0) {
    // All lines excluded — reset and try again without exclusions
    const fallback = COMMENTARY_LINES.filter((l) => l.trigger === trigger)
    if (fallback.length === 0) return ''
    const picked = fallback[Math.floor(Math.random() * fallback.length)]
    return typeof picked.text === 'function' ? picked.text(data) : picked.text
  }
  const picked = options[Math.floor(Math.random() * options.length)]
  return typeof picked.text === 'function' ? picked.text(data) : picked.text
}