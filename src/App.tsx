import { useEffect, useRef, useState } from 'react'
import { HandTracker } from './hand/handTracker'
import { countFingers } from './hand/fingerCount'
import { CountdownMachine } from './state/countdownMachine'
import { RocketPhysicsEngine } from './physics/rocketPhysics'
import { ParamPanel } from './ui/ParamPanel'
import { Scene } from './render/Scene'
import type { CountdownState, Telemetry, RocketParams } from './types'
import './App.css'

const machine = new CountdownMachine()

function App() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const trackerRef = useRef<HandTracker | null>(null)
  const engineRef = useRef<RocketPhysicsEngine | null>(null)
  const telemetryRef = useRef<Telemetry | null>(null)
  const rafRef = useRef<number>(0)
  const lastTimeRef = useRef<number>(0)

  const [state, setState] = useState<CountdownState>(machine.getState())
  const [status, setStatus] = useState('Loading model...')
  const [debug, setDebug] = useState('')
  const [launched, setLaunched] = useState(false)

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
          `hands detected: ${hands.length} | score: ${hands[0]?.score?.toFixed(2) ?? 'n/a'} | handedness: ${hands[0]?.handedness ?? 'n/a'} | reading: ${reading}`
        )
        machine.tick(reading)
      }

      // Physics step, only once armed/launched engine exists
      if (engineRef.current && timestamp !== undefined) {
        const dt = lastTimeRef.current ? (timestamp - lastTimeRef.current) / 1000 : 1 / 60
        lastTimeRef.current = timestamp
        telemetryRef.current = engineRef.current.step(Math.min(dt, 1 / 30))
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

  // React to countdown machine reaching 'armed' -> wait for explicit launch param submit
  // Launch button in ParamPanel triggers actual physics + rocket launch
  function handleLaunch(params: RocketParams) {
    if (state.phase !== 'armed') return
    const engine = new RocketPhysicsEngine(params)
    engine.launch()
    engineRef.current = engine
    lastTimeRef.current = 0
    machine.launch()
    setLaunched(true)
  }

  return (
    <div className="app">
      <h1>Kalam</h1>
      <p className="status">{status}</p>
      <video ref={videoRef} className="webcam" muted playsInline style={{ display: 'none' }} />
      <Scene telemetryRef={telemetryRef} launched={launched} />
      <div className="state-readout">
        <strong>State:</strong> {JSON.stringify(state)}
      </div>
      <div className="state-readout">{debug}</div>
      <ParamPanel onLaunch={handleLaunch} disabled={state.phase !== 'armed'} />
    </div>
  )
}

export default App