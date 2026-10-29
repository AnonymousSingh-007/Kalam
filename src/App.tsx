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
import type { CountdownState, Telemetry, RocketParams } from './types'
import './App.css'

const machine = new CountdownMachine()
const gestures = new GestureDetector()

function App() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const trackerRef = useRef<HandTracker | null>(null)
  const engineRef = useRef<RocketPhysicsEngine | null>(null)
  const telemetryRef = useRef<Telemetry | null>(null)
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

        const dt = lastTimeRef.current
          ? (timestamp - lastTimeRef.current) / 1000
          : 1 / 60
        lastTimeRef.current = timestamp
        telemetryRef.current = engineRef.current.step(Math.min(dt, 1 / 30))

        const t = telemetryRef.current
        if (t) {
          // local, rule-based watchdog — no 3rd-party API, just threshold
          // checks against telemetry the engine already produces. Catches
          // the control loop losing attitude authority (extreme-TWR
          // tumbles, runaway rates) and triggers a flight-termination
          // abort before the integrator produces garbage numbers.
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

          if (timestamp - lastHudRef.current >= 100) {
            lastHudRef.current = timestamp
            setTelemetryDisplay({ ...t })
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