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
import { GestureDetector } from './hand/gestures'
import { FixedStepDriver } from './renderInterp'
import type { CountdownState, Telemetry, RocketParams } from './types'
import './App.css'

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
  const rafRef = useRef<number>(0)
  const lastTimeRef = useRef<number>(0)
  const lastHudRef = useRef<number>(0)
  const stepVehicleRef = useRef<(dir: 1 | -1) => void>(() => {})
  const gestureTimerRef = useRef<number>(0)

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

    const held = { left: false, right: false }
    const syncGimbal = () => {
      gimbalInputRef.current = (held.right ? 1 : 0) - (held.left ? 1 : 0)
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (machine.getState().phase === 'selecting') {
        if (e.key === 'ArrowLeft'  && !e.repeat) { stepVehicle(-1); e.preventDefault(); return }
        if (e.key === 'ArrowRight' && !e.repeat) { stepVehicle(1);  e.preventDefault(); return }
        if (e.key === 'Enter') { machine.confirmSelection(); e.preventDefault(); return }
      }
      if (e.key === 'ArrowLeft')  { held.left = true;  e.preventDefault() }
      if (e.key === 'ArrowRight') { held.right = true; e.preventDefault() }
      syncGimbal()
    }
    function handleKeyUp(e: KeyboardEvent) {
      if (e.key === 'ArrowLeft')  held.left = false
      if (e.key === 'ArrowRight') held.right = false
      syncGimbal()
    }
    function handleBlur() {
      held.left = false
      held.right = false
      syncGimbal()
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
        setDebug(
          `hands: ${hands.length} | score: ${hands[0]?.score?.toFixed(2) ?? 'n/a'} | hand: ${hands[0]?.handedness ?? 'n/a'} | reading: ${reading}`
        )
        machine.tick(reading)

        if (machine.getState().phase === 'selecting') {
          const ev = gestures.update(hands, performance.now())
          if (ev === 'swipe-right') { stepVehicle(1); flashGesture('Swipe → next') }
          else if (ev === 'swipe-left') { stepVehicle(-1); flashGesture('Swipe ← previous') }
          else if (ev === 'clap') { flashGesture('Clap — confirmed'); machine.confirmSelection() }
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
            if (!engineRef.current.isAborted()) {
              const verdict = checkWatchdog(t)
              if (verdict) {
                engineRef.current.abort()
                setAbortMessage(verdict.message)
                setCommentary(`FLIGHT TERMINATION: ${verdict.message}`)
              }
            }

            const line = commentaryEngineRef.current.tick(t, t.airDensity)
            if (line) setCommentary(line)

            if (t.altitude <= 0 && t.stage === 'descent' && t.time > 1) {
              setCommentary((prev) =>
                prev || commentaryEngineRef.current.fireLanded(t)
              )
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
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(commentary)
    utterance.rate = 1.05
    utterance.pitch = 0.9
    window.speechSynthesis.speak(utterance)
  }, [commentary])

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
    </div>
  )
}

export default App