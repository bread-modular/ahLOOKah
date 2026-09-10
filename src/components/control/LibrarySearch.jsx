import { useEffect, useRef } from 'react';
import { stopEnterPropagation } from './library-search.js';

// Mirrors the KeyboardController's text-entry test: a shortcut must never steal
// a keystroke from a control the operator is using. Range/checkbox inputs are
// not text entry, so `/` still works while a slider has focus.
const NON_TEXT_INPUT_TYPES = ['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'file', 'color', 'image'];

function isTextEntryTarget(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  // A <select> owns its own keystrokes (type-ahead / open list) exactly like a
  // text field, so it must win over a global shortcut too.
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  return !NON_TEXT_INPUT_TYPES.includes(target.type);
}

// Pattern-library search field.
//
// Sits above the scrolling `#pattern-library` list (sibling, not child) so it
// stays visible while the groups scroll, and owns the `/` shortcut that focuses
// and selects it. While this field has focus, Enter and Escape belong to it —
// the KeyboardController skips text-entry targets, so a typo can never take a
// staged CUE live or drop the cue.
export function LibrarySearch({ value, onChange, searching, matchCount, totalCount }) {
  const inputRef = useRef(null);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // The produced character only — never `event.code === 'Slash'`, which
      // would also fire for Shift+/ (that keystroke types "?").
      if (event.key !== '/') return;
      if (isTextEntryTarget(event.target)) return;
      // Any open modal owns the keyboard: the device setup, Key Map and notice
      // dialogs plus the projection editor all render `aria-modal`, and a native
      // <dialog> that is open is never a search target either.
      if (document.querySelector('[aria-modal="true"], dialog[open]')) return;
      event.preventDefault();
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.select();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="library-search">
      <div className="library-search-field">
        <input
          id="library-search"
          ref={inputRef}
          className="library-search-input"
          type="search"
          value={value}
          placeholder="Search patterns — press /"
          aria-label="Search patterns"
          autoComplete="off"
          spellCheck="false"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            // The field owns Escape: clear the query first, then leave the field.
            event.preventDefault();
            if (value) onChange('');
            else event.currentTarget.blur();
          }}
        />
        {value !== '' && (
          <button
            id="library-search-clear"
            type="button"
            className="library-search-clear"
            aria-label="Clear pattern search"
            title="Clear search"
            // Enter here clears the field instead of taking a staged CUE live.
            onKeyDown={stopEnterPropagation}
            onClick={() => {
              onChange('');
              inputRef.current?.focus();
            }}
          >
            ×
          </button>
        )}
      </div>
      {searching && matchCount > 0 && (
        <p className="library-search-status" role="status">
          {matchCount} of {totalCount} patterns
        </p>
      )}
    </div>
  );
}
