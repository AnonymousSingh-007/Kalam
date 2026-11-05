import { useEffect, useRef, useState } from 'react'
import { HandTracker } from './hand/handTracker'
import { countFingers } from './hand/fingerCount'
import { CountdownMachine } from './state/countdownMachine'
import { RocketPhysicsEngine, EMPTY_TELEMETRY } from './physics/rocketPhysics'
import { checkFlightSanity } from './flightSanity'
import { checkWatchdog } from './flightWatchdog'
import { CommentaryEngine } from './commentary/commentaryEngine'
import { ParamPanel } from './ui/ParamPanel'
import { InstrumentPanel } from './ui/InstrumentPanel'
import { Scene } from './render/Scene'
import { VehicleSelect } from './ui/VehicleSelect'
import { VEHICLES } from './render/buildRocket'
import { GestureDetector, raisedHandPitch, debugRaiseY } from './hand/gestures'
import { FixedStepDriver } from './renderInterp'
import type { CountdownState, Telemetry, RocketParams } from './types'
import { generateReport } from './postFlightReport'
import { PostFlightReportPanel } from './ui/PostFlightReport'
import './App.css'
import './PostFlightReport.css'

const machine = new CountdownMachine()
const gestures = new GestureDetector()

function App() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const trackerRef = useRef<HandTracker | null>(null)
  const engineRef = useRef<RocketPhysicsEngine | null>(null)
  // Holds the interpolated RenderSnapshot (see renderInterp.ts) that Scene
  // reads every frame. Shaped exactly like Telemetry, so Scene's existing
  // `telemetry.xxx` reads are unchanged — only what produces this object
  // changed (fixed-step physics + lerp/SLERP instead of a raw per-frame
  // engine.step() result from a second, independent rAF loop).
  const telemetryRef = useRef<Telemetry | null>(null)
  const driverRef = useRef<FixedStepDriver>(new FixedStepDriver())
  const commentaryEngineRef = useRef<CommentaryEngine>(new CommentaryEngine())
  const gimbalInputRef = useRef<number>(0)
  // -1/0/+1 from held Up/Down keys (or a raised hand — see gesture
  // wiring below); read every physics tick the same way gimbalInputRef
  // is, via engine.setThrottleInput() in loop().
  const throttleInputRef = useRef<number>(0)
  const rafRef = useRef<number>(0)
  const lastTimeRef = useRef<number>(0)
  const lastHudRef = useRef<number>(0)
  const stepVehicleRef = useRef<(dir: 1 | -1) => void>(() => {})
  const gestureTimerRef = useRef<number>(0)
  // One-slot queue for a commentary line that arrived while a previous
  // line was still being read. Only "important" lines (stage transitions,
  // max-Q, events) get queued here — periodic filler is dropped instead,
  // since another filler line follows within a few seconds regardless.
  const pendingImportantRef = useRef<string | null>(null)
  // True once this flight's landed/crashed telemetry has been captured —
  // guards against re-capturing on every subsequent tick after touchdown
  // (outcome stays 'landed'/'crashed' for the rest of the frozen
  // post-touchdown state, see rocketPhysics.ts's touchdown(), so without
  // this guard the capture below would fire repeatedly, not once).
  const reportCapturedRef = useRef(false)
  // Mirrors the abortMessage state (set at the same two call sites) so
  // the report-capture code below can read the CURRENT abort reason
  // synchronously within the same loop() call that set it — React state
  // updates are batched, so reading the `abortMessage` closure variable
  // in the same synchronous block that just called setAbortMessage would
  // still see the previous render's (stale) value, same reasoning as why
  // pendingImportantRef is a ref and not state.
  const abortMessageRef = useRef<string | null>(null)
  // Sampled time series for the post-flight dashboard's per-phase graphs.
  // A ref (not state) because it's written every tick of every frame —
  // pushing through setState at that rate would mean a re-render per
  // physics tick, for data nothing reads until the flight is already over.
  // Downsampled to ~10/s (SAMPLE_INTERVAL) rather than every raw tick:
  // the graphs are read at a glance, not pixel-inspected, and a 3-minute
  // flight at the physics engine's actual substep rate would otherwise
  // build an array with nothing visually gained from the extra points.
  const telemetryHistoryRef = useRef<Telemetry[]>([])
  const lastSampleTimeRef = useRef(0)

  const [vehicleIndex, setVehicleIndex] = useState(1)
  const [lastGesture, setLastGesture] = useState('')
  const [state, setState] = useState<CountdownState>(machine.getState())
  const [status, setStatus] = useState('Loading model...')
  const [debug, setDebug] = useState('')
  const [launched, setLaunched] = useState(false)
  const [showDebug, setShowDebug] = useState(false)
  const [commentary, setCommentary] = useState('')
  const [telemetryDisplay, setTelemetryDisplay] = useState<Telemetry | null>(null)
  const [abortMessage, setAbortMessage] = useState('')
  // The exact Telemetry tick captured the instant outcome transitioned to
  // 'landed' or 'crashed' — not the live/interpolated telemetryDisplay,
  // which keeps updating after touchdown isn't physically meaningful
  // (the state is frozen, but re-deriving a report from a later poll
  // would just be reading the same frozen numbers through an extra
  // layer). null until a flight actually ends this way.
  const [finishedTelemetry, setFinishedTelemetry] = useState<Telemetry | null>(null)
  const [finishedParams, setFinishedParams] = useState<RocketParams | null>(null)
  const [finishedAbortMessage, setFinishedAbortMessage] = useState<string | null>(null)
  const [showReportPrompt, setShowReportPrompt] = useState(false)
  const [showReport, setShowReport] = useState(false)
  const [finishedHistory, setFinishedHistory] = useState<Telemetry[]>([])

  useEffect(() => {
    machine.onChange(setState)

    const stepVehicle = (dir: 1 | -1) => {
      setVehicleIndex((i) => (i + dir + VEHICLES.length) % VEHICLES.length)
    }
    stepVehicleRef.current = stepVehicle
    const flashGesture = (msg: string) => {
      setLastGesture(msg)
      window.clearTimeout(gestureTimerRef.current)
      gestureTimerRef.current = window.setTimeout(() => setLastGesture(''), 1200)
    }

    let cancelled = false

    const held = { left: false, right: false, up: false, down: false }
    const syncGimbal = () => {
      gimbalInputRef.current = (held.right ? 1 : 0) - (held.left ? 1 : 0)
    }
    // Up/Down -> throttle, same held-key-drives-a-rate-command shape as
    // Left/Right -> pitch. Read every frame in loop() (see
    // throttleInputRef below) rather than only on keydown/keyup, since the
    // engine integrates a continuous throttle lever from this -1/0/+1
    // direction, exactly like gimbalInputRef.
    const syncThrottle = () => {
      throttleInputRef.current = (held.up ? 1 : 0) - (held.down ? 1 : 0)
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (machine.getState().phase === 'selecting') {
        if (e.key === 'ArrowLeft'  && !e.repeat) { stepVehicle(-1); e.preventDefault(); return }
        if (e.key === 'ArrowRight' && !e.repeat) { stepVehicle(1);  e.preventDefault(); return }
        if (e.key === 'Enter') { machine.confirmSelection(); e.preventDefault(); return }
      }
      if (e.key === 'ArrowLeft')  { held.left = true;  e.preventDefault() }
      if (e.key === 'ArrowRight') { held.right = true; e.preventDefault() }
      if (e.key === 'ArrowUp')    { held.up = true;    e.preventDefault() }
      if (e.key === 'ArrowDown')  { held.down = true;  e.preventDefault() }
      syncGimbal()
      syncThrottle()
    }
    function handleKeyUp(e: KeyboardEvent) {
      if (e.key === 'ArrowLeft')  held.left = false
      if (e.key === 'ArrowRight') held.right = false
      if (e.key === 'ArrowUp')    held.up = false
      if (e.key === 'ArrowDown')  held.down = false
      syncGimbal()
      syncThrottle()
    }
    function handleBlur() {
      held.left = false
      held.right = false
      held.up = false
      held.down = false
      syncGimbal()
      syncThrottle()
    }
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('blur', handleBlur)

    // requirement 7: a backgrounded/throttled tab stops getting rAF
    // callbacks, so `lastTimeRef` goes stale while hidden. Without this,
    // the first frame after the tab regains visibility would compute a
    // multi-second (or multi-minute) dt and hand it to the physics driver
    // in one lump. FixedStepDriver's own MAX_FRAME_DT clamp is a second,
    // independent guard against that same class of problem (belt and
    // suspenders), but resetting lastTimeRef here means a resumed tab's
    // very first frame doesn't even attempt a huge dt — it just resumes
    // cleanly from "now", losing exactly the wall-clock time the tab was
    // hidden, which is the correct behavior (the flight pauses with it),
    // not a stutter or a runaway catch-up burst.
    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') {
        lastTimeRef.current = 0
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    async function setup() {
      const tracker = new HandTracker()
      await tracker.init()
      if (cancelled) return
      trackerRef.current = tracker

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480 }
      })
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      }

      setStatus('Ready')
      machine.start()
      loop()
    }

    function loop(timestamp?: number) {
      const video = videoRef.current
      const tracker = trackerRef.current
      if (video && tracker && tracker.isReady() && video.readyState >= 2) {
        const hands = tracker.detect(video, performance.now())
        const reading = hands.length > 0 ? countFingers(hands[0]) : null
        // raiseY/pitch are temporary debug fields (see gestures.ts's
        // debugRaiseY) added to pin down why raised-hand pitch wasn't
        // registering -- raiseY is the exact value tested against
        // RAISE_THRESHOLD_Y (0.35; lower y = higher in frame), pitch is
        // what raisedHandPitch(hands) actually returns this frame. Once
        // the right threshold/behavior is confirmed, these two fields
        // (and the debugRaiseY export) can be removed again.
        const raiseY = hands.length > 0 ? debugRaiseY(hands[0]).toFixed(2) : 'n/a'
        const debugPitch = raisedHandPitch(hands)
        setDebug(
          `hands: ${hands.length} | score: ${hands[0]?.score?.toFixed(2) ?? 'n/a'} | hand: ${hands[0]?.handedness ?? 'n/a'} | reading: ${reading} | raiseY: ${raiseY} | pitch: ${debugPitch}`
        )
        machine.tick(reading)

        if (machine.getState().phase === 'selecting') {
          const ev = gestures.update(hands, performance.now())
          if (ev === 'swipe-right') { stepVehicle(1); flashGesture('Swipe → next') }
          else if (ev === 'swipe-left') { stepVehicle(-1); flashGesture('Swipe ← previous') }
          else if (ev === 'clap') { flashGesture('Clap — confirmed'); machine.confirmSelection() }
        } else if (machine.getState().phase === 'launched') {
          // In-flight raised-hand pitch control. Deliberately does NOT call
          // gestures.reset() here (unlike every other non-selecting phase
          // below) -- that instance's swipe/clap trail-and-cooldown state
          // has nothing to do with raisedHandPitch, which is stateless and
          // reads the current hands[] directly every frame.
          //
          // Keyboard takes priority over the gesture by design: if either
          // pitch key is currently held, gimbalInputRef already reflects
          // that (nonzero), and a raised hand is ignored entirely this
          // frame rather than being averaged or summed with it -- avoids
          // the case of a player's own raised arm (steadying themselves,
          // reaching for the keyboard) fighting an intentional keypress.
          if (gimbalInputRef.current === 0) {
            gimbalInputRef.current = raisedHandPitch(hands)
          }
        } else {
          gestures.reset()
        }

        if (machine.getState().phase === 'counting' && Math.random() < 0.02) {
          const snap = engineRef.current?.snapshot() ?? EMPTY_TELEMETRY
          const line = commentaryEngineRef.current.fireCountdown(snap)
          if (line) setCommentary(line)
        }
      }

      if (engineRef.current && timestamp !== undefined) {
        engineRef.current.setGimbalInput(gimbalInputRef.current)
        engineRef.current.setThrottleInput(throttleInputRef.current)

        // Wall-clock time since the previous rAF callback. Deliberately
        // NOT clamped here to a "reasonable frame" value and handed
        // straight to the physics engine the way the old dual-loop code
        // did (Math.min(dt, 1/30)) — that clamp used to silently throw
        // away time on a slow frame, which is a different bug class from
        // what FixedStepDriver guards against. The driver's own
        // MAX_FRAME_DT clamp (renderInterp.ts) is the single place frame
        // time is bounded now, specifically to handle the
        // backgrounded-tab/huge-timestep case (requirement 7) without
        // also quietly losing time on every ordinary slow frame.
        const dt = lastTimeRef.current
          ? (timestamp - lastTimeRef.current) / 1000
          : 1 / 60
        lastTimeRef.current = timestamp

        const result = driverRef.current.advance(engineRef.current, dt)
        if (result) {
          // Single interpolated snapshot for every visual consumer —
          // Scene.tsx's rocket pose, camera and exhaust all read this one
          // ref, so they can never disagree about which simulated instant
          // they're drawing (requirement 4). bodyAngle/yawAngle/rollAngle
          // here come from quaternion SLERP, not from interpolating the
          // old Euler-style angles directly (requirement 3); lateralOffset/
          // altitude/positionZ are plain lerp (requirement 2).
          telemetryRef.current = result.render

          // Event-detection logic (watchdog, commentary cues, landing)
          // runs against every *raw* physics tick that actually completed
          // this frame — never against the interpolated render snapshot,
          // which can transiently read between two real states (e.g. an
          // interpolated altitude hovering near 0 right at touchdown) and
          // would otherwise risk a spurious or delayed trigger.
          for (const t of result.ticks) {
            // Flight termination always interrupts — a safety message
            // overriding whatever line is mid-read is correct, not a bug.
            if (!engineRef.current.isAborted()) {
              const verdict = checkWatchdog(t)
              if (verdict) {
                engineRef.current.abort()
                abortMessageRef.current = verdict.message
                setAbortMessage(verdict.message)
                setCommentary(`FLIGHT TERMINATION: ${verdict.message}`)
                continue
              }
            }

            // Let a line finish being spoken before replacing it. Without
            // this, a periodic/event line firing every few seconds would
            // overwrite the caption and queue a new utterance mid-word —
            // commentary.tick() still runs every tick so its internal
            // bookkeeping (max-Q tracking, stage-change detection, event
            // one-shot flags) stays correct, but the resulting line is
            // only surfaced once speech has actually finished.
            const speaking = 'speechSynthesis' in window && window.speechSynthesis.speaking
            const result2 = commentaryEngineRef.current.tick(t, t.airDensity)
            if (result2) {
              if (!speaking) {
                setCommentary(result2.text)
              } else if (result2.important) {
                // Don't drop a one-shot moment (ignition, burnout, max-Q,
                // an event threshold) just because filler was mid-sentence
                // — hold it and surface it the instant speech frees up.
                pendingImportantRef.current = result2.text
              }
              // periodic filler dropped silently when busy — another one
              // follows within a few seconds regardless
            } else if (pendingImportantRef.current && !speaking) {
              setCommentary(pendingImportantRef.current)
              pendingImportantRef.current = null
            }

            if (t.altitude <= 0 && t.stage === 'descent' && t.time > 1) {
              setCommentary((prev) =>
                prev || commentaryEngineRef.current.fireLanded(t)
              )
            }

            // Post-flight report capture — fires exactly once, the first
            // raw tick whose outcome is no longer 'flying'. Deliberately
            // reads `t` (the raw tick), never the interpolated render
            // snapshot, for the same reason the watchdog/commentary logic
            // above does: outcome is a discrete state, and lerping toward
            // it has no meaning. abortMessage is read from the ref-backed
            // state captured above in this same loop body, not re-derived,
            // so a report for an aborted flight always shows the exact
            // message that triggered the abort.
            if (!reportCapturedRef.current && t.outcome !== 'flying') {
              reportCapturedRef.current = true
              setFinishedTelemetry(t)
              setFinishedAbortMessage(abortMessageRef.current)
              // Snapshot the sampled history as of right now — a plain
              // array copy, not the live ref, so nothing the dashboard
              // later reads can change out from under it even though
              // telemetryHistoryRef keeps being written to by stray ticks
              // after this point (the frozen post-touchdown state still
              // produces a few more ticks before the loop settles).
              setFinishedHistory([...telemetryHistoryRef.current])
              setShowReportPrompt(true)
            }

            // Dashboard sampling — downsampled to ~10/s by simulated time,
            // not by frame/tick count, so the sample rate is the same
            // whether the engine is substepping at 60Hz or 240Hz. Always
            // keep the very first sample (t=0) and keep sampling through
            // 'landed'/'crashed' for a few ticks so the graphs show the
            // actual touchdown, not a flat line that stops just before it.
            const SAMPLE_INTERVAL = 0.1
            if (t.time === 0 || t.time - lastSampleTimeRef.current >= SAMPLE_INTERVAL) {
              lastSampleTimeRef.current = t.time
              telemetryHistoryRef.current.push(t)
            }
          }

          if (timestamp - lastHudRef.current >= 100) {
            lastHudRef.current = timestamp
            setTelemetryDisplay({ ...result.render })
          }
        }
      }

      rafRef.current = requestAnimationFrame(loop)
    }

    setup().catch((err) => setStatus(`Error: ${err.message}`))

    return () => {
      cancelled = true
      cancelAnimationFrame(rafRef.current)
      trackerRef.current?.dispose()
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('blur', handleBlur)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.clearTimeout(gestureTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (!commentary) return
    if (!('speechSynthesis' in window)) return
    // Previously called speechSynthesis.cancel() before every utterance,
    // which kills whatever's currently being spoken mid-word the instant
    // a new line is queued. With commentary firing every few seconds
    // during ascent, that meant most lines got cut off before finishing.
    // speak() already queues on its own when you don't cancel first — so
    // just enqueue and let each line finish before the next one starts.
    const utterance = new SpeechSynthesisUtterance(commentary)
    utterance.rate = 1.05
    utterance.pitch = 0.9
    window.speechSynthesis.speak(utterance)
  }, [commentary])

  // "Fly again": tear down the finished flight's report state and send the
  // countdown machine back through idle to selecting, exactly like the
  // app's very first entry into vehicle selection. Doesn't touch
  // engineRef/launched directly — selecting a vehicle and re-launching via
  // handleLaunch already resets those in the normal flow.
  function handleFlyAgain() {
    setShowReport(false)
    setShowReportPrompt(false)
    setFinishedTelemetry(null)
    setFinishedAbortMessage(null)
    setFinishedHistory([])
    setLaunched(false)
    machine.reset()
    machine.start()
  }

  function handleLaunch(params: RocketParams) {
    if (state.phase !== 'armed') return

    const sanity = checkFlightSanity(params)
    if (!sanity.ok) {
      const proceed = window.confirm(
        `Heads up — these parameters are outside what the simulator is tuned for:\n\n` +
        sanity.warnings.join('\n') +
        `\n\nYou can still launch, but the flight may tumble or show runaway numbers. Launch anyway?`
      )
      if (!proceed) return
    }

    const engine = new RocketPhysicsEngine(params)
    engine.launch()
    engineRef.current = engine
    lastTimeRef.current = 0
    // Fresh flight, fresh accumulator — a stale prevPose/currPose pair
    // from a previous engine instance (or leftover accumulated time) must
    // never bleed into the first frames of a new launch.
    driverRef.current.reset()
    machine.launch()
    setLaunched(true)
    setAbortMessage('')
    commentaryEngineRef.current.reset()
    pendingImportantRef.current = null
    // Fresh flight — clear any report/prompt left over from the previous
    // one, and un-arm the capture guard so this new flight's own
    // landed/crashed transition gets captured (not skipped as if it were
    // a stale repeat of the last flight's touchdown).
    reportCapturedRef.current = false
    abortMessageRef.current = null
    telemetryHistoryRef.current = []
    lastSampleTimeRef.current = 0
    setFinishedTelemetry(null)
    setFinishedParams(params)
    setFinishedAbortMessage(null)
    setFinishedHistory([])
    setShowReportPrompt(false)
    setShowReport(false)
    if ('speechSynthesis' in window) window.speechSynthesis.cancel()
    const snap = engine.snapshot()
    setCommentary(commentaryEngineRef.current.firePreLaunch(snap))
  }

  const phaseLabel: Record<CountdownState['phase'], string> = {
    idle: 'STANDBY',
    selecting: 'CHOOSE VEHICLE',
    counting: 'AWAITING GESTURE',
    armed: 'ARMED — SET PARAMETERS',
    launched: 'IN FLIGHT'
  }

  return (
    <div className="app">
      <header className="topbar">
        <h1>KALAM</h1>
        <div className="topbar-status">
          <span className="status-dot" data-phase={state.phase} />
          <span className="status-text">{phaseLabel[state.phase]}</span>
        </div>
      </header>

      <main className="stage">
        <div className="viewport">
          {abortMessage && (
            <div
              className="abort-banner"
              role="alert"
              style={{
                position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)',
                zIndex: 50, background: '#b00020', color: '#fff', padding: '8px 16px',
                borderRadius: 6, fontWeight: 700, fontSize: 14, maxWidth: '80%', textAlign: 'center',
              }}
            >
              FLIGHT TERMINATION — {abortMessage}
            </div>
          )}

          <InstrumentPanel
            telemetry={telemetryDisplay}
            isThrusting={telemetryDisplay?.stage === 'powered-ascent'}
          />

          <Scene
            telemetryRef={telemetryRef}
            launched={launched}
            vehicleId={VEHICLES[vehicleIndex].id}
            selecting={state.phase === 'selecting'}
          />

          {state.phase === 'selecting' && (
            <VehicleSelect
              index={vehicleIndex}
              lastGesture={lastGesture}
              onStep={(d) => stepVehicleRef.current(d)}
              onConfirm={() => machine.confirmSelection()}
            />
          )}

          <video ref={videoRef} className="webcam-pip" muted playsInline />

          {state.phase === 'counting' && (
            <div className="countdown-overlay">{state.expected}</div>
          )}

          {commentary && launched && (
            <div className="commentary-caption">{commentary}</div>
          )}

          {showReportPrompt && !showReport && (
            <button
              className="report-prompt-button"
              onClick={() => setShowReport(true)}
            >
              View post-flight report
            </button>
          )}
        </div>

        <aside className="side-dock">
          <ParamPanel onLaunch={handleLaunch} disabled={state.phase !== 'armed'} />

          <button
            className="debug-toggle"
            onClick={() => setShowDebug((s) => !s)}
          >
            {showDebug ? 'Hide' : 'Show'} diagnostics
          </button>

          {showDebug && (
            <div className="diagnostics">
              <div>{status}</div>
              <div>{JSON.stringify(state)}</div>
              <div>{debug}</div>
            </div>
          )}
        </aside>
      </main>

      {showReport && finishedTelemetry && finishedParams && (
        <PostFlightReportPanel
          report={generateReport(finishedTelemetry, finishedParams, finishedAbortMessage, finishedHistory)}
          onClose={() => setShowReport(false)}
          onFlyAgain={handleFlyAgain}
        />
      )}
    </div>
  )
}

export default App