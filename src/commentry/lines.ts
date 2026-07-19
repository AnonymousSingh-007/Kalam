import type { CommentaryTrigger, CommentaryLine } from '../types'

export const COMMENTARY_LINES: CommentaryLine[] = [
  { trigger: 'pre-launch', text: "Parameters locked in. No refunds past this point." },
  { trigger: 'pre-launch', text: "Fingers crossed. Literally, apparently, given how we got here." },

  { trigger: 'ignition', text: "And we have liftoff. Physics, don't embarrass me." },
  { trigger: 'ignition', text: "Engines lit. This is the part where we find out if you did the math right." },
  { trigger: 'ignition', text: "Ground control has left the chat." },

  { trigger: 'max-q', text: "Max aerodynamic pressure. The rocket is currently having a bad time." },
  { trigger: 'max-q', text: "This is the part where things are statistically most likely to go wrong. Cool, cool." },

  { trigger: 'burnout', text: "Fuel's gone. We're coasting on vibes now." },
  { trigger: 'burnout', text: "Engine cutoff. Everything from here is just momentum and hope." },

  { trigger: 'coast', text: "Still climbing, no thrust required. Efficient, if nothing else." },
  { trigger: 'coast', text: "Coasting upward like it's got somewhere better to be." },

  { trigger: 'apogee', text: "Peak altitude reached. It's all downhill from here, literally." },
  { trigger: 'apogee', text: "Apogee. The one moment this rocket wasn't going up or down. Savor it." },

  { trigger: 'descent', text: "And now it falls. Gravity, undefeated since forever." },
  { trigger: 'descent', text: "Coming back down. Hopefully slower than it went up." },

  { trigger: 'landed', text: "Touchdown. Or impact. The telemetry doesn't really editorialize." },
  { trigger: 'landed', text: "Flight complete. Go ahead, adjust the numbers and do it again." }
]

export function getRandomLine(trigger: CommentaryTrigger): string {
  const options = COMMENTARY_LINES.filter((l) => l.trigger === trigger)
  if (options.length === 0) return ''
  return options[Math.floor(Math.random() * options.length)].text
}