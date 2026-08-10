import type { CommentaryTrigger, CommentaryLine } from '../types'

export const COMMENTARY_LINES: CommentaryLine[] = [
  // countdown
  { trigger: 'countdown', text: "Five fingers. Bold opening statement." },
  { trigger: 'countdown', text: "Counting down. Try not to sneeze." },
  { trigger: 'countdown', text: "Your hand is doing more engineering than the rocket right now." },
  { trigger: 'countdown', text: "Almost there. The rocket is watching. It's nervous too." },
  { trigger: 'countdown', text: "T-minus whatever your hand says." },
  { trigger: 'countdown', text: "Biometric launch authorization. Very fancy. Very unnecessary." },
  { trigger: 'countdown', text: "Each finger you lower is a promise to physics." },
  { trigger: 'countdown', text: "Hand tracking nominal. Sanity: unconfirmed." },

  // pre-launch
  { trigger: 'pre-launch', text: "Parameters locked in. No refunds past this point." },
  { trigger: 'pre-launch', text: "Fingers crossed. Literally, apparently, given how we got here." },
  { trigger: 'pre-launch', text: "Numbers submitted. Let's see if you paid attention in physics." },
  { trigger: 'pre-launch', text: "Configuration locked. There's no undo button on a launch." },
  { trigger: 'pre-launch', text: "All systems are go. Whether they should be is a separate question." },
  { trigger: 'pre-launch', text: "Propellant loaded. Prayers optional but not discouraged." },
  { trigger: 'pre-launch', text: "This is fine. Everything is fine. Launch is go." },
  { trigger: 'pre-launch', text: "Pre-launch checks complete. Some of them, anyway." },

  // ignition
  { trigger: 'ignition', text: "And we have liftoff. Physics, don't embarrass me." },
  { trigger: 'ignition', text: "Engines lit. This is the part where we find out if you did the math right." },
  { trigger: 'ignition', text: "Ground control has left the chat." },
  { trigger: 'ignition', text: "Thrust exceeds weight. Technically that counts as flying." },
  { trigger: 'ignition', text: "T-zero. The pad is someone else's problem now." },
  { trigger: 'ignition', text: "Rising. Slowly at first, then embarrassingly fast." },
  { trigger: 'ignition', text: "Liftoff confirmed. The rocket is aggressively leaving." },
  { trigger: 'ignition', text: "Engines at full thrust. The ground strongly disagrees with this." },

  // max-q
  { trigger: 'max-q', text: "Max aerodynamic pressure. The rocket is currently having a bad time." },
  { trigger: 'max-q', text: "This is statistically the most likely moment for things to go wrong. Cool, cool." },
  { trigger: 'max-q', text: "Peak dynamic pressure reached. The rocket would like a moment." },
  { trigger: 'max-q', text: "The atmosphere is pushing back. Hard." },
  { trigger: 'max-q', text: "Max-Q. If anything was going to break, it would have been now." },
  { trigger: 'max-q', text: "Structure holding. Barely counts as a compliment but here we are." },
  { trigger: 'max-q', text: "Aerodynamic forces at maximum. The rocket is not enjoying this." },
  { trigger: 'max-q', text: "We are through max-Q. Everything from here is structurally more relaxing." },

  // burnout
  { trigger: 'burnout', text: "Fuel's gone. We're coasting on vibes now." },
  { trigger: 'burnout', text: "Engine cutoff. Everything from here is just momentum and hope." },
  { trigger: 'burnout', text: "Propellant spent. It gave what it had." },
  { trigger: 'burnout', text: "No more thrust. Whatever happens next was decided a few seconds ago." },
  { trigger: 'burnout', text: "MECO. Main engine cutoff. We are now a very expensive ballistic object." },
  { trigger: 'burnout', text: "Burnout confirmed. Gravity is now in charge." },
  { trigger: 'burnout', text: "Tank empty. The rocket is now a passenger." },
  { trigger: 'burnout', text: "All that fuel, gone in seconds. Rocketry is a humbling field." },

  // coast
  { trigger: 'coast', text: "Still climbing, no thrust required. Efficient, if nothing else." },
  { trigger: 'coast', text: "Coasting upward like it has somewhere better to be." },
  { trigger: 'coast', text: "Momentum doing all the work now. Everyone else can relax." },
  { trigger: 'coast', text: "Rising on pure inertia. Newton's still got it." },
  { trigger: 'coast', text: "Coast phase. The rocket is gliding on its own confidence." },
  { trigger: 'coast', text: "No engine, still climbing. This is the good part." },
  { trigger: 'coast', text: "Ballistic arc in progress. Art, basically." },
  { trigger: 'coast', text: "Unpowered ascent. The atmosphere is getting noticeably thinner." },

  // apogee
  { trigger: 'apogee', text: "Peak altitude reached. It's all downhill from here. Literally." },
  { trigger: 'apogee', text: "Apogee. The one moment this rocket wasn't going up or down. Savor it." },
  { trigger: 'apogee', text: "Highest point of the flight. Someone take a screenshot." },
  { trigger: 'apogee', text: "Zero vertical velocity. A brief, expensive pause." },
  { trigger: 'apogee', text: "This is as far as we go. Gravity has been very patient." },
  { trigger: 'apogee', text: "Apogee confirmed. The view is great. The next part is less great." },
  { trigger: 'apogee', text: "Peak reached. The rocket is about to remember gravity exists." },
  { trigger: 'apogee', text: "Top of the arc. Peaceful up here. Won't last." },

  // descent
  { trigger: 'descent', text: "And now it falls. Gravity, undefeated since forever." },
  { trigger: 'descent', text: "Coming back down. Hopefully slower than it went up." },
  { trigger: 'descent', text: "What goes up. You know the rest." },
  { trigger: 'descent', text: "Descending fast. This is where drag coefficient earns its keep." },
  { trigger: 'descent', text: "Reentry phase. Technically." },
  { trigger: 'descent', text: "Falling with style. Or just falling. Hard to say from here." },
  { trigger: 'descent', text: "Velocity increasing. The ground is approaching with enthusiasm." },
  { trigger: 'descent', text: "Descent confirmed. Physics remains undefeated." },

  // landed
  { trigger: 'landed', text: "Touchdown. Or impact. The telemetry doesn't really editorialize." },
  { trigger: 'landed', text: "Flight complete. Go ahead, adjust the numbers and do it again." },
  { trigger: 'landed', text: "Back on the ground. However that went, it's over now." },
  { trigger: 'landed', text: "Mission concluded. The data doesn't lie, even when it's unflattering." },
  { trigger: 'landed', text: "Terminal velocity met the terminal. Flight over." },
  { trigger: 'landed', text: "Contact. That's a wrap on this one." },
  { trigger: 'landed', text: "Landed. Or something in that general category of events." },
  { trigger: 'landed', text: "End of flight. The pad team would like a word about the scorch marks." },
]

export function getRandomLine(trigger: CommentaryTrigger): string {
  const options = COMMENTARY_LINES.filter((l) => l.trigger === trigger)
  if (options.length === 0) return ''
  return options[Math.floor(Math.random() * options.length)].text
}