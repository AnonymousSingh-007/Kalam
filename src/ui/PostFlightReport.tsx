/**
 * PostFlightReport.tsx — the debrief panel shown after a flight ends.
 *
 * Pure presentation: takes the already-built PostFlightReport object
 * (from postFlightReport.ts's generateReport()) and an onFlyAgain
 * callback, renders it. Holds no logic of its own about when a flight
 * ended or what the numbers mean — that's the generator's job, this
 * component just lays the result out.
 */
import type { PostFlightReport } from '../postFlightReport'
import { FlightDashboard } from './FlightDashboard'

interface Props {
  report: PostFlightReport
  onClose: () => void
  onFlyAgain: () => void
}

export function PostFlightReportPanel({ report, onClose, onFlyAgain }: Props) {
  const isGood = report.outcome === 'landed' && !report.wasAborted

  return (
    <div className="report-overlay">
      <div className="report-panel">
        <div className="report-header">
          <span
            className="report-badge"
            style={{
              background: isGood ? '#00f0ff' : '#ff2bd6',
              color: isGood ? '#04141a' : '#1a0414',
            }}
          >
            {report.wasAborted ? 'ABORTED' : report.outcome === 'landed' ? 'LANDED' : 'CRASHED'}
          </span>
          <h2>Post-Flight Report</h2>
          <button className="report-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <section className="report-section">
          <h3>Stats</h3>
          <div className="report-stats-grid">
            {report.stats.map((s) => (
              <div className="report-stat" key={s.label}>
                <span className="report-stat-label">{s.label}</span>
                <span className="report-stat-value">{s.value}</span>
              </div>
            ))}
          </div>
        </section>

        {report.series.length > 0 && (
          <section className="report-section">
            <h3>Flight Telemetry</h3>
            <FlightDashboard series={report.series} phases={report.phases} />
          </section>
        )}

        <section className="report-section">
          <h3>Feedback</h3>
          <ul className="report-list">
            {report.feedback.map((line, i) => <li key={i}>{line}</li>)}
          </ul>
        </section>

        {report.suggestions.length > 0 && (
          <section className="report-section">
            <h3>Suggestions for next launch</h3>
            <ul className="report-list">
              {report.suggestions.map((line, i) => <li key={i}>{line}</li>)}
            </ul>
          </section>
        )}

        <div className="report-actions">
          <button className="report-fly-again" onClick={onFlyAgain}>Fly again</button>
        </div>
      </div>
    </div>
  )
}