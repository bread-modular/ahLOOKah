import { useRef } from 'react';
import { getGroups, getSketchesByGroup, getOrderedSketches } from '../../sketch-registry.js';
import { MEDIA_GROUP } from '../../media/media-registry.js';
import { canUseFileSystemPicker } from '../../media/media-store.js';
import { useRuntime } from '../../app/RuntimeContext.jsx';
import { useVizStore } from '../../state/useVizStore.js';
import { slotLabel, selectionClassesFor } from './panelHelpers.js';
import { onDragStart, onDragEnd, onDragOver, onDragLeave, clearDropTargets, getDragSource } from './dragDrop.js';

export function PatternLibrary() {
  const { runtime, store } = useRuntime();
  const padOrder = useVizStore(store, (s) => s.padOrder);
  const liveSelection = useVizStore(store, (s) => s.liveSelection);
  const cue = useVizStore(store, (s) => s.cue);
  const mediaRevision = useVizStore(store, (s) => s.mediaRevision);
  const mediaInputRef = useRef(null);

  const ordered = padOrder.length ? padOrder : getOrderedSketches().map((s) => s.id);
  const slotOf = new Map(ordered.map((id, i) => [id, i]));
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
    <div id="pattern-library" className="pattern-library" data-media-revision={mediaRevision}>
      {getGroups().map((group) => {
        const sketches = getSketchesByGroup(group);
        const isMediaGroup = group === MEDIA_GROUP;
        // The Media group always renders so new files can be added even before
        // any media pattern exists.
        if (sketches.length === 0 && !isMediaGroup) return null;
        return (
          <div className="library-group" key={group}>
            <div className="library-group-header">
              <span>{group}</span>
              {isMediaGroup && (
                <>
                  <button
                    type="button"
                    className="media-add-btn"
                    aria-label="Add media"
                    title="Load images or videos from this computer as patterns (kept as file references; content is read from disk when played)"
                    onClick={() => {
                      // File System Access picker (Desktop Chrome): persists a
                      // path-equivalent handle only. Fallback: hidden input.
                      if (canUseFileSystemPicker()) runtime.commands.addMediaFiles();
                      else mediaInputRef.current?.click();
                    }}
                  >ADD</button>
                  {!canUseFileSystemPicker() && (
                    <input
                      ref={mediaInputRef}
                      type="file"
                      accept="image/*,video/*"
                      multiple
                      className="media-file-input"
                      onChange={(event) => {
                        const files = event.target.files;
                        if (files?.length) runtime.commands.addMediaFiles(files);
                        event.target.value = '';
                      }}
                    />
                  )}
                </>
              )}
            </div>
            {isMediaGroup && sketches.length === 0 && (
              <div className="media-empty">No media loaded — add an image or video file.</div>
            )}
            <div className="library-group-grid">
              {sketches.map((sketch) => {
                const slotIdx = slotOf.get(sketch.id);
                const classes = ['pattern-btn', 'library-btn', ...selectionClassesFor({ id: sketch.id, isSlot: false, liveSelection, cueSelection, slotOrder: ordered })];
                return (
                  <button
                    key={sketch.id}
                    className={classes.join(' ')}
                    data-id={sketch.id}
                    draggable
                    disabled={takePending}
                    title="Click to play live. Shift-click to stage this pattern as CUE."
                    onClick={(event) => {
                      if (takePending) return;
                      if (slotIdx !== undefined) {
                        if (event.shiftKey) runtime.commands.cueSelect(slotIdx);
                        else runtime.commands.select(slotIdx);
                      } else if (event.shiftKey) {
                        runtime.commands.cueSelectById(sketch.id);
                      } else {
                        runtime.commands.selectById(sketch.id);
                      }
                    }}
                    onDragStart={onDragStart}
                    onDragEnd={onDragEnd}
                    onDragOver={onDragOver}
                    onDragLeave={onDragLeave}
                    onDrop={(e) => { e.preventDefault(); if (slotIdx !== undefined) commitDrop(slotIdx); }}
                  >
                    <span className="pattern-name">{sketch.name}</span>
                    {sketch.camera && <span className="camera-badge" title="Uses camera input">📷</span>}
                    {sketch.media && sketch.kind === 'image' && <span className="media-badge" title="Loaded image">🖼️</span>}
                    {sketch.media && sketch.kind === 'video' && <span className="media-badge" title="Loaded video">🎬</span>}
                    {slotIdx !== undefined && <span className="slot-badge" title={`Assigned to pad slot ${slotLabel(slotIdx)}`}>{slotLabel(slotIdx)}</span>}
                    <span className="drag-handle" title="Drag to pad slot">⠿</span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
