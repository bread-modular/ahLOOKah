import { createPortal } from 'react-dom';
import { useRuntime } from '../../app/RuntimeContext.jsx';

export function KeyMapModal() {
  const { store } = useRuntime();
  const dismiss = () => store.setState({ keyMapOpen: false });

  return createPortal(
    <div id="key-map-modal" role="dialog" aria-modal="true" aria-labelledby="key-map-modal-title">
      <div className="key-map-modal-card">
        <button id="key-map-modal-close" className="device-setup-modal-close" type="button" aria-label="Close" onClick={dismiss}>&times;</button>
        <h2 id="key-map-modal-title">Key Map</h2>
        <table className="key-map-table">
          <tbody>
            <tr className="key-map-group"><td colSpan="2">Keyboard — patterns (1–9, 0)</td></tr>
            <tr><td><kbd>1</kbd>–<kbd>9</kbd> <kbd>0</kbd></td><td>Select a pattern</td></tr>
            <tr><td>Hold one key, press another</td><td>Merge two patterns into a blend</td></tr>

            <tr className="key-map-group"><td colSpan="2">CUE</td></tr>
            <tr><td><kbd>Shift</kbd> + Click a pattern</td><td>Stage it as CUE</td></tr>
            <tr><td><kbd>Shift</kbd> + <kbd>1</kbd>–<kbd>9</kbd> <kbd>0</kbd></td><td>Stage CUE (hold a second to blend)</td></tr>
            <tr><td><kbd>Enter</kbd></td><td>GO LIVE</td></tr>
            <tr><td><kbd>Esc</kbd></td><td>Cancel CUE</td></tr>

            <tr className="key-map-group"><td colSpan="2">Blend (while merging)</td></tr>
            <tr><td><kbd>+</kbd> / <kbd>−</kbd></td><td>Adjust blend amount</td></tr>
            <tr><td><kbd>Tab</kbd></td><td>Toggle blend mode</td></tr>
          </tbody>
        </table>
      </div>
    </div>,
    document.body,
  );
}
