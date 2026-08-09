import { useEffect, useRef, useState } from 'react'
import { HandTracker } from './hand/handTracker'
import { countFingers } from './hand/fingerCount'
import { CountdownMachine } from './state/countdownMachine'
import { RocketPhysicsEngine } from './physics/rocketPhysics'
import { CommentaryEngine } from './commentary/commentaryEngine'
import { getRandomLine } from './commentary/lines'
import { ParamPanel } from './ui/ParamPanel'
import { InstrumentPanel } from './ui/InstrumentPanel'
import { Scene } from './render/Scene'
import type { CountdownState, Telemetry, RocketParams } from './types'
import './App.css'

const machine = new CountdownMachine()

function App() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const trackerRef = useRef<HandTracker | null>(null)
  const engineRef = useRef<RocketPhysicsEngine | null>(null)
  const telemetryRef = useRef<Telemetry | null>(null)
  const commentaryEngineRef = useRef<CommentaryEngine>(new CommentaryEngine())
  const rafRef = useRef<number>(0)
  const lastTimeRef = useRef<number>(0)

  const [state, setState] = useState<CountdownState>(machine.getState())
  const [status, setStatus] = useState('Loading model...')
  const [debug, setDebug] = useState('')
  const [launched, setLaunched] = useState(false)
  const [showDebug, setShowDebug] = useState(false)
  const [commentary, setCommentary] = useState('')
  const [telemetryDisplay, setTelemetryDisplay] = useState<Telemetry | null>(null)

  useEffect(() => {
    machine.onChange(setState)

    let cancelled = false

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

        if (machine.getState().phase === 'counting' && Math.random() < 0.02) {
          const line = getRandomLine('countdown')
          if (line) setCommentary(line)
        }
      }

      if (engineRef.current && timestamp !== undefined) {
        const dt = lastTimeRef.current ? (timestamp - lastTimeRef.current) / 1000 : 1 / 60
        lastTimeRef.current = timestamp
        telemetryRef.current = engineRef.current.step(Math.min(dt, 1 / 30))

        const t = telemetryRef.current
        if (t) {
          const airDensity = 1.225 * Math.exp(-t.altitude / 8500)
          const line = commentaryEngineRef.current.tick(t, airDensity)
          if (line) setCommentary(line)
          if (t.altitude <= 0 && t.stage === 'descent' && t.time > 1) {
            setCommentary((prev) => prev || commentaryEngineRef.current.fireLanded())
          }

          // Throttle UI telemetry updates to ~5x/sec instead of every frame
          if (Math.floor(t.time * 10) % 2 === 0) {
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
    const engine = new RocketPhysicsEngine(params)
    engine.launch()
    engineRef.current = engine
    lastTimeRef.current = 0
    machine.launch()
    setLaunched(true)
    commentaryEngineRef.current.reset()
    setCommentary(commentaryEngineRef.current.firePreLaunch())
  }

  const phaseLabel: Record<CountdownState['phase'], string> = {
    idle: 'STANDBY',
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
          <InstrumentPanel telemetry={telemetryDisplay} />

          <Scene telemetryRef={telemetryRef} launched={launched} />

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

          <button className="debug-toggle" onClick={() => setShowDebug((s) => !s)}>
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