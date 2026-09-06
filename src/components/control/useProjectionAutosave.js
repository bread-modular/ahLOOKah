import { useEffect, useRef, useState } from 'react';
import { sanitizeProjection, surfaceQuad, surfaceMappingValues, surfaceEdgeBlur } from '../../projection/projection-registry.js';

// Corners and edge smoothing use the numeric parameter channel, never the topology/rebuild path.
// Metadata is serialized against the last accepted pattern. Both channels keep
// local intent separate from delayed echoes, so dragging never waits for an ACK.
export function useProjectionAutosave({ runtime, store, sketch, surface, name, setName, patternId, quad, edgeBlur,
  geometryEdited, locked, structuralLock, onClose }) {
  const session = useRef(store.getState().cue?.sessionId);
  const inContext = () => store.getState().cue?.sessionId === session.current
    && store.getState().editingSelection.ids.includes(sketch.id);
  const [base, setBase] = useState(() => sanitizeProjection(sketch));
  const [pending, setPending] = useState(null);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState('');
  const [retryRevision, setRetryRevision] = useState(0);
  const [sentGeometry, setSentGeometry] = useState(null);
  const geometryRetry = useRef(0);
  const latestGeometry = useRef(null);
  latestGeometry.current = surfaceMappingValues(surface.id, quad, edgeBlur);
  const current = sketch.surfaces.find((s) => s.id === surface.id);
  const currentPattern = JSON.stringify(sanitizeProjection(sketch));
  const stale = currentPattern !== JSON.stringify(base) && currentPattern !== pending?.serialized;
  const metadataDirty = name.trim() && (!current || current.name !== name.trim() || current.patternId !== patternId);
  const geometry = JSON.stringify(latestGeometry.current);
  const values = runtime.getEditingParams(sketch.id);
  const currentGeometry = JSON.stringify(surfaceMappingValues(surface.id, surfaceQuad(surface, values), surfaceEdgeBlur(surface, values)));
  const geometryAccepted = Boolean(current) && currentGeometry === geometry;
  const geometryPending = Boolean(sentGeometry || ((current || pending) && geometryEdited && !geometryAccepted));
  const saving = Boolean(pending || metadataDirty || geometryPending);
  const conflict = stale ? 'This layout changed elsewhere. Close and reopen the editor to continue.' : '';

  useEffect(() => {
    if (pending?.serialized !== currentPattern) return;
    setBase(pending.pattern);
    setPending(null);
    setError('');
  }, [pending, currentPattern]);

  useEffect(() => {
    if (!metadataDirty || pending || stale || locked || structuralLock || error) return;
    // Renaming is debounced; source switches and Close flush immediately.
    const timer = window.setTimeout(() => {
      if (!inContext()) return;
      const nextSurface = { ...surface, name: name.trim(), patternId };
      const pattern = { ...base, surfaces: current
        ? base.surfaces.map((s) => s.id === surface.id ? nextSurface : s)
        : [...base.surfaces, nextSurface] };
      setPending({ pattern, serialized: JSON.stringify(pattern) });
      // Only creation includes geometry. Later metadata edits preserve the
      // authority's newest numeric bank, including any drag already in flight.
      if (!runtime.commands.saveProjection(pattern, current ? {} : latestGeometry.current, base)) {
        setPending(null);
        setClosing(false);
        setError('Automatic saving is unavailable. Finish CUE or reopen the editor.');
      }
    }, closing || current?.patternId !== patternId ? 0 : 250);
    return () => window.clearTimeout(timer);
  }, [metadataDirty, name, patternId, pending, stale, locked, structuralLock, error, closing, base, current?.id, current?.patternId, retryRevision]);

  useEffect(() => {
    if (!geometryEdited) return;
    if (sentGeometry && sentGeometry === currentGeometry) {
      setSentGeometry(null);
      return;
    }
    if (!current || stale || locked || error) return;
    // Keep one geometry packet in flight and coalesce newer local intent. In
    // particular, A→B→A cannot mistake the old A mirror for acknowledgement of
    // the final A while B is still pending. Dragging itself never waits.
    if (sentGeometry && geometryRetry.current === retryRevision) return;
    if (!sentGeometry && geometryAccepted) return;
    const outgoing = sentGeometry || geometry;
    const frame = requestAnimationFrame(() => {
      if (!inContext()) return;
      geometryRetry.current = retryRevision;
      setSentGeometry(outgoing);
      runtime.commands.changeParams(sketch.id, JSON.parse(outgoing));
    });
    return () => cancelAnimationFrame(frame);
  }, [geometry, geometryEdited, geometryAccepted, sentGeometry, current?.id, stale, locked, error, retryRevision,
    // Only accepted geometry matters here; unrelated audio/child param updates
    // must not cancel an already scheduled geometry packet.
    currentGeometry]);

  useEffect(() => {
    if (!saving || (!pending && !geometryPending) || stale || error) return;
    const timer = window.setTimeout(() => {
      setClosing(false);
      setError('Automatic saving was not confirmed. Check the output connection and retry.');
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [pending, geometry, geometryPending, saving, stale, error]);

  useEffect(() => {
    if (closing && !saving && !error && !stale) onClose();
  }, [closing, saving, error, stale, onClose]);

  const close = () => {
    if (error || stale) {
      if (window.confirm('Some changes are not confirmed. Close anyway? Already saved changes will be kept.')) onClose();
      return;
    }
    // Empty names never create a surface or erase the last valid saved name.
    if (!name.trim()) {
      if (!current && !pending) { onClose(); return; }
      setName(current?.name || pending.pattern.surfaces.find((s) => s.id === surface.id).name);
    }
    setClosing(true);
  };
  const retry = () => {
    setPending(null);
    setError('');
    setRetryRevision((value) => value + 1);
  };
  return { saving, closing, error: error || conflict, stale, close, retry };
}
