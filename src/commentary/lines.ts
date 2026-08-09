import type { CommentaryTrigger, CommentaryLine } from '../types'

export const COMMENTARY_LINES: CommentaryLine[] = [
  // countdown — fires as the hand-tracked countdown ticks down
  { trigger: 'countdown', text: "Five fingers. Bold opening statement." },
  { trigger: 'countdown', text: "Counting down. Try not to sneeze." },
  { trigger: 'countdown', text: "Your hand is doing more engineering than the rocket right now." },
  { trigger: 'countdown', text: "Almost there. The rocket is watching. It's nervous too." },

  // pre-launch — fires once params confirmed, right before ignition
  { trigger: 'pre-launch', text: "Parameters locked in. No refunds past this point." },
  { trigger: 'pre-launch', text: "Fingers crossed. Literally, apparently, given how we got here." },
  { trigger: 'pre-launch', text: "Numbers submitted. Let's see if you paid attention in physics." },
  { trigger: 'pre-launch', text: "Configuration locked. There's no undo button on a launch." },

  // ignition
  { trigger: 'ignition', text: "And we have liftoff. Physics, don't embarrass me." },
  { trigger: 'ignition', text: "Engines lit. This is the part where we find out if you did the math right." },
  { trigger: 'ignition', text: "Ground control has left the chat." },
  { trigger: 'ignition', text: "Thrust exceeds weight. Technically that counts as flying." },

  // max-q
  { trigger: 'max-q', text: "Max aerodynamic pressure. The rocket is currently having a bad time." },
  { trigger: 'max-q', text: "This is the part where things are statistically most likely to go wrong. Cool, cool." },
  { trigger: 'max-q', text: "Peak dynamic pressure reached. The rocket would like a moment, if that's alright." },
  { trigger: 'max-q', text: "This is the structurally tense part. Try not to think about it too hard." },

  // burnout
  { trigger: 'burnout', text: "Fuel's gone. We're coasting on vibes now." },
  { trigger: 'burnout', text: "Engine cutoff. Everything from here is just momentum and hope." },
  { trigger: 'burnout', text: "Propellant's spent. It gave what it had." },
  { trigger: 'burnout', text: "No more thrust. Whatever happens next was already decided a few seconds ago." },

  // coast
  { trigger: 'coast', text: "Still climbing, no thrust required. Efficient, if nothing else." },
  { trigger: 'coast', text: "Coasting upward like it's got somewhere better to be." },
  { trigger: 'coast', text: "Momentum's doing all the work now. Everyone else can relax." },
  { trigger: 'coast', text: "Rising on pure inertia. Newton's still got it." },

  // apogee
  { trigger: 'apogee', text: "Peak altitude reached. It's all downhill from here, literally." },
  { trigger: 'apogee', text: "Apogee. The one moment this rocket wasn't going up or down. Savor it." },
  { trigger: 'apogee', text: "Highest point of the flight. Somebody take a screenshot." },
  { trigger: 'apogee', text: "Zero vertical velocity. A brief, expensive pause." },

  // descent
  { trigger: 'descent', text: "And now it falls. Gravity, undefeated since forever." },
  { trigger: 'descent', text: "Coming back down. Hopefully slower than it went up." },
  { trigger: 'descent', text: "What goes up. You know the rest." },
  { trigger: 'descent', text: "Descending fast. This is where the drag coefficient earns its keep." },

  // landed
  { trigger: 'landed', text: "Touchdown. Or impact. The telemetry doesn't really editorialize." },
  { trigger: 'landed', text: "Flight complete. Go ahead, adjust the numbers and do it again." },
  { trigger: 'landed', text: "Back on the ground. However that went, it's over now." },
  { trigger: 'landed', text: "Mission concluded. The data doesn't lie, even when it's unflattering." }
]

export function getRandomLine(trigger: CommentaryTrigger): string {
  const options = COMMENTARY_LINES.filter((l) => l.trigger === trigger)
  if (options.length === 0) return ''
  return options[Math.floor(Math.random() * options.length)].text
}