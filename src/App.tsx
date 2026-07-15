import { useEffect, useRef, useState } from 'react'
import { HandTracker } from './hand/handTracker'
import { countFingers } from './hand/fingerCount'
import { CountdownMachine } from './state/countdownMachine'
import type { CountdownState } from './types'
import './App.css'

const machine = new CountdownMachine()

function App() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const trackerRef = useRef<HandTracker | null>(null)
  const rafRef = useRef<number>(0)
  const [state, setState] = useState<CountdownState>(machine.getState())
  const [status, setStatus] = useState('Loading model...')
  const [debug, setDebug] = useState('')

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

    function loop() {
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
      rafRef.current = requestAnimationFrame(loop)
    }

    setup().catch((err) => setStatus(`Error: ${err.message}`))

    return () => {
      cancelled = true
      cancelAnimationFrame(rafRef.current)
      trackerRef.current?.dispose()
    }
  }, [])

  return (
    <div className="app">
      <h1>Kalam</h1>
      <p className="status">{status}</p>
      <video ref={videoRef} className="webcam" muted playsInline />
      <div className="state-readout">
        <strong>State:</strong> {JSON.stringify(state)}
      </div>
      <div className="state-readout">{debug}</div>
    </div>
  )
}

export default App