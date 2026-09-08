import { useRuntime } from '../../app/RuntimeContext.jsx';
import { useVizStore } from '../../state/useVizStore.js';

export function PerformanceBudget({ patternId, surfaceId, compact = false, scope = 'live' }) {
  const { store } = useRuntime();
  const sample = useVizStore(store, (s) => s.renderPerformance);
  const selection = useVizStore(store, (s) => s.liveSelection);
  const online = useVizStore(store, (s) => s.screenOnline);
  const current = online && sample && sample.ids.length === selection.ids.length
    && sample.ids.every((id, i) => id === selection.ids[i]);
  const pattern = current ? sample.patterns[patternId] : null;
  const cost = scope === 'cue' ? null : (surfaceId ? pattern?.surfaces?.[surfaceId] : patternId ? pattern : current && sample);
  if (!cost) return compact ? null : <div className="performance-budget is-unmeasured">Performance budget · {scope === 'cue' ? 'Measured when LIVE' : 'Waiting for live output'}</div>;
  const level = cost.cpuPercent >= 90 ? 'high' : cost.cpuPercent >= 60 ? 'warn' : 'low';
  const title = `${cost.cpuMs.toFixed(2)} ms of the 16.67 ms target frame budget (${cost.cpuPercent.toFixed(1)}%). Measured LIVE main-thread rendering and texture submission, not GPU utilization or video decoding. Output animation-frame cadence: ${sample.fps.toFixed(1)} fps; ${sample.slowPercent.toFixed(1)}% slow frames. Low CPU does not guarantee GPU headroom.`;
  const label = `LIVE performance budget: CPU ${Math.round(cost.cpuPercent)}%`;
  if (compact) return <span className={`performance-badge is-${level}`} title={title} aria-label={label}>CPU {Math.round(cost.cpuPercent)}%</span>;
  return <div className={`performance-budget is-${level}`} title={title} aria-label={label}>
    <div className="performance-budget-heading"><span>LIVE performance budget</span><strong>CPU {Math.round(cost.cpuPercent)}%</strong></div>
    <div className="performance-budget-track" aria-hidden="true"><span style={{ width: `${Math.min(100, cost.cpuPercent)}%` }} /></div>
    <div className="performance-budget-detail"><span>{cost.cpuMs.toFixed(2)} / 16.67 ms</span><span className={sample.fps < 50 ? 'performance-slow' : ''}>Output {Math.round(sample.fps)} fps</span></div>
    <small>CPU render time · GPU/decoder load not included</small>
  </div>;
}

export function OutputPerformance() {
  const { store } = useRuntime();
  const sample = useVizStore(store, (s) => s.renderPerformance);
  const online = useVizStore(store, (s) => s.screenOnline);
  const selection = useVizStore(store, (s) => s.liveSelection);
  if (!online) return null;
  const current = sample && sample.ids.length === selection.ids.length && sample.ids.every((id, i) => id === selection.ids[i]);
  return <span className={`output-performance${current && sample.fps < 50 ? ' performance-slow' : ''}`} title="Output animation-frame cadence, not the video's encoded frame rate. CPU figures measure main-thread rendering, not total GPU utilization.">
    {current ? `${Math.round(sample.fps)} fps · CPU ${Math.round(sample.cpuPercent)}%` : 'Performance pending'}
  </span>;
}
