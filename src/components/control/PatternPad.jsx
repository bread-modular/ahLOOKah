import { getOrderedSketches } from '../../sketch-registry.js';
import { useRuntime } from '../../app/RuntimeContext.jsx';
import { useVizStore } from '../../state/useVizStore.js';
import { slotLabel, selectionClassesFor } from './panelHelpers.js';
import { onDragStart, onDragEnd, onDragOver, onDragLeave, clearDropTargets, getDragSource } from './dragDrop.js';

export function PatternPad() {
  const { runtime, store } = useRuntime();
  const padOrder = useVizStore(store, (s) => s.padOrder);
  const liveSelection = useVizStore(store, (s) => s.liveSelection);
  const cue = useVizStore(store, (s) => s.cue);

  const ordered = padOrder.length ? padOrder : getOrderedSketches().map((s) => s.id);
  const cueSelection = cue?.selection || null;
  const takePending = cue?.takePending || false;

  const commitDrop = (targetIndex) => {
    const source = getDragSource();
    clearDropTargets(document.getElementById('config-panel'));
    if (!source || targetIndex === null) return;
    const ids = getOrderedSketches().map((s) => s.id);
    const existing = ids.indexOf(source.id);
    if (existing >= 0) {
      [ids[existing], ids[targetIndex]] = [ids[targetIndex], ids[existing]];
    } else {
      ids[targetIndex] = source.id;
    }
    runtime.commands.reorder(ids);
  };

  return (
    <div id="pattern-pad" className="pattern-pad">
      {ordered.slice(0, 10).map((id, i) => {
        const sketch = getOrderedSketches().find((s) => s.id === id) || null;
        const classes = ['pattern-btn', 'slot-btn', ...selectionClassesFor({ id, isSlot: true, liveSelection, cueSelection, slotOrder: ordered })];
        return (
          <button
            key={`slot-${i}`}
            className={classes.join(' ')}
            data-id={id || ''}
            data-index={String(i)}
            draggable
            disabled={takePending}
            title="Click to play live. Shift-click to stage this pattern as CUE."
            onClick={(event) => {
              if (!sketch || takePending) return;
              if (event.shiftKey) runtime.commands.cueSelect(i);
              else runtime.commands.select(i);
            }}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={(e) => { e.preventDefault(); commitDrop(i); }}
          >
            <span className="pattern-key">{slotLabel(i)}</span>
            <span className="pattern-name">{sketch ? sketch.name : '—'}</span>
            <span className="drag-handle" title="Drag to swap slots">⠿</span>
          </button>
        );
      })}
    </div>
  );
}
