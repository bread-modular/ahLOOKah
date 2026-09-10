import { PerformanceBudget } from './PerformanceBudget.jsx';
import { useRef, useState } from 'react';
import { SKETCHES, getGroups, getSketchesByGroup, getOrderedSketches } from '../../sketch-registry.js';
import { PROJECTION_GROUP } from '../../projection/projection-registry.js';
import { MEDIA_GROUP } from '../../media/media-registry.js';
import { canUseFileSystemPicker } from '../../media/media-store.js';
import { STORAGE } from '../../platform/constants.js';
import { useRuntime } from '../../app/RuntimeContext.jsx';
import { useVizStore } from '../../state/useVizStore.js';
import { slotLabel, selectionClassesFor } from './panelHelpers.js';
import { onDragStart, onDragEnd, onDragOver, onDragLeave, clearDropTargets, getDragSource } from './dragDrop.js';
import { LibrarySearch } from './LibrarySearch.jsx';
import {
  FAVOURITES_GROUP,
  filterSketches,
  loadFavouriteIds,
  parseQuery,
  resolveFavourites,
  saveFavouriteIds,
  stopEnterPropagation,
  toggleFavourite,
} from './library-search.js';

// Collapsed library groups persist per-window as a JSON array of group names.
// A corrupted or missing entry must never break boot (same policy as media
// metadata): fall back to "everything expanded".
function loadCollapsedGroups() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE.libraryCollapsed));
    if (!Array.isArray(raw)) return [];
    return raw.filter((g) => typeof g === 'string');
  } catch {
    return [];
  }
}

// DOM id for a group's collapsible section (wires the toggle's aria-controls).
function groupSectionId(group) {
  return `library-section-${group.replace(/[^a-zA-Z0-9_-]+/g, '-')}`;
}

export function PatternLibrary() {
  const { runtime, store } = useRuntime();
  const padOrder = useVizStore(store, (s) => s.padOrder);
  const liveSelection = useVizStore(store, (s) => s.liveSelection);
  const cue = useVizStore(store, (s) => s.cue);
  const mediaRevision = useVizStore(store, (s) => s.mediaRevision);
  useVizStore(store, (s) => s.projectionRevision);
  const mediaInputRef = useRef(null);
  const [collapsedGroups, setCollapsedGroups] = useState(loadCollapsedGroups);
  const [query, setQuery] = useState('');
  const [favouriteIds, setFavouriteIds] = useState(loadFavouriteIds);

  const toggleGroup = (group) => {
    const next = collapsedGroups.includes(group)
      ? collapsedGroups.filter((g) => g !== group)
      : [...collapsedGroups, group];
    setCollapsedGroups(next);
    try {
      localStorage.setItem(STORAGE.libraryCollapsed, JSON.stringify(next));
    } catch {
      // Persistence is best-effort (quota / privacy modes); UI state still applies.
    }
  };

  const toggleFavouriteId = (id) => {
    const next = toggleFavourite(favouriteIds, id);
    setFavouriteIds(next);
    saveFavouriteIds(next);
  };

  const ordered = padOrder.length ? padOrder : getOrderedSketches().map((s) => s.id);
  const slotOf = new Map(ordered.map((id, i) => [id, i]));
  const cueSelection = cue?.selection || null;
  const takePending = cue?.takePending || false;

  const terms = parseQuery(query);
  const searching = terms.length > 0;
  const favouriteSketches = resolveFavourites(favouriteIds, SKETCHES);

  // Library sections in render order. The Favourites mirror comes first and is
  // hidden while a query is active so a search result never appears twice.
  const sections = [];
  if (!searching && favouriteSketches.length) {
    sections.push({ group: FAVOURITES_GROUP, sketches: favouriteSketches });
  }
  let matchCount = 0;
  for (const group of getGroups()) {
    const sketchesInGroup = getSketchesByGroup(group);
    const isProjectionGroup = group === PROJECTION_GROUP;
    const isMediaGroup = group === MEDIA_GROUP;
    // The Media group always renders so new files can be added even before
    // any media pattern exists.
    if (sketchesInGroup.length === 0 && !isMediaGroup && !isProjectionGroup) continue;
    const sketches = filterSketches(sketchesInGroup, terms);
    if (searching && sketches.length === 0) continue;
    matchCount += sketches.length;
    sections.push({ group, sketches, isProjectionGroup, isMediaGroup });
  }
  const hasResults = sections.some((section) => section.sketches.length);

  const commitDrop = (targetIndex) => {
    const source = getDragSource();
    clearDropTargets(document.getElementById('config-panel'));
    if (!source || targetIndex === null || source.type === 'surface') return;
    const ids = getOrderedSketches().map((s) => s.id);
    const existing = ids.indexOf(source.id);
    if (existing >= 0) {
      [ids[existing], ids[targetIndex]] = [ids[targetIndex], ids[existing]];
    } else {
      ids[targetIndex] = source.id;
    }
    runtime.commands.reorder(ids);
  };

  // One library item: the pattern button plus its favourite toggle. The star is
  // a sibling (a button may not contain another control), so starring never
  // selects, cues or drags the pattern.
  const renderPattern = (sketch) => {
    const slotIdx = slotOf.get(sketch.id);
    const classes = ['pattern-btn', 'library-btn', ...selectionClassesFor({ id: sketch.id, isSlot: false, liveSelection, cueSelection, slotOrder: ordered })];
    const isFavourite = favouriteIds.includes(sketch.id);
    return (
      <div className="library-cell" key={sketch.id}>
        <button
          className={classes.join(' ')}
          data-id={sketch.id}
          draggable
          disabled={takePending}
          title={`${sketch.description ? `${sketch.description} ` : ''}Click to play live. Shift-click to stage this pattern as CUE.`}
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
          <span className="pattern-label"><span className="pattern-name">{sketch.name}</span><PerformanceBudget patternId={sketch.id} compact /></span>
          {sketch.projection && <span className="media-badge" title="Projection mapping">▱</span>}
          {sketch.camera && <span className="camera-badge" title="Uses camera input">📷</span>}
          {sketch.media && sketch.kind === 'image' && <span className="media-badge" title="Loaded image">🖼️</span>}
          {sketch.media && sketch.kind === 'video' && <span className="media-badge" title="Loaded video">🎬</span>}
          {slotIdx !== undefined && <span className="slot-badge" title={`Assigned to pad slot ${slotLabel(slotIdx)}`}>{slotLabel(slotIdx)}</span>}
          <span className="drag-handle" title="Drag to pad slot">⠿</span>
        </button>
        <button
          type="button"
          className={`library-favourite-btn${isFavourite ? ' is-favourite' : ''}`}
          aria-pressed={isFavourite}
          aria-label={`${isFavourite ? 'Remove' : 'Add'} ${sketch.name} ${isFavourite ? 'from' : 'to'} favourites`}
          title={isFavourite ? 'Remove from favourites' : 'Add to favourites'}
          // Enter toggles the star instead of taking a staged CUE live.
          onKeyDown={stopEnterPropagation}
          onClick={() => toggleFavouriteId(sketch.id)}
        >
          {isFavourite ? '★' : '☆'}
        </button>
      </div>
    );
  };

  return (
    <>
      <LibrarySearch
        value={query}
        onChange={setQuery}
        searching={searching}
        matchCount={matchCount}
        totalCount={SKETCHES.length}
      />
      <div id="pattern-library" className="pattern-library" data-media-revision={mediaRevision}>
        {searching && !hasResults && (
          <div className="library-empty" role="status">
            <span>No patterns match “{query.trim()}”.</span>
            <button type="button" className="library-empty-clear" onKeyDown={stopEnterPropagation} onClick={() => setQuery('')}>Clear search</button>
          </div>
        )}
        {sections.map(({ group, sketches, isProjectionGroup, isMediaGroup }) => {
          const isFavouritesGroup = group === FAVOURITES_GROUP;
          // While searching every matching group is revealed; the operator's
          // saved collapse state is never rewritten by a search.
          const collapsed = !searching && collapsedGroups.includes(group);
          return (
            <div className={`library-group${isFavouritesGroup ? ' library-group-favourites' : ''}`} key={group}>
              <div className="library-group-header">
                <button
                  type="button"
                  className={`library-group-toggle${collapsed ? ' is-collapsed' : ''}`}
                  aria-expanded={!collapsed}
                  aria-controls={groupSectionId(group)}
                  // Every matching group is forced open while a query is active, so
                  // toggling would persist a collapse the operator cannot see.
                  disabled={searching}
                  title={searching ? 'Groups stay open while searching' : collapsed ? `Expand ${group}` : `Collapse ${group}`}
                  onClick={() => toggleGroup(group)}
                >
                  <span>{group}</span>
                </button>
                {isProjectionGroup && <button type="button" className="library-add-btn projection-add-btn" aria-label="Add projection mapping pattern" disabled={Boolean(cue)} onClick={() => {
                  const name = window.prompt('Name your projection mapping pattern');
                  if (name?.trim()) runtime.commands.addProjection(name);
                }}>ADD</button>}
                {isMediaGroup && (
                  <>
                    <button
                      type="button"
                      className="library-add-btn media-add-btn"
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
              {/* Always-mounted controlled region: `hidden` keeps aria-controls
                  valid while collapsed and keeps the Media empty state inside it. */}
              <div
                className="library-group-body"
                id={groupSectionId(group)}
                hidden={collapsed}
              >
                {isMediaGroup && sketches.length === 0 && (
                  <div className="media-empty">No media loaded — add an image or video file.</div>
                )}
                {isProjectionGroup && sketches.length === 0 && <div className="media-empty">Add a pattern with named projection surfaces.</div>}
                <div className="library-group-grid">
                  {sketches.map((sketch) => renderPattern(sketch))}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
