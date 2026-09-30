import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Select } from './Select.jsx';

// The single hand-off to an external coding agent. ahLOOKah still never creates,
// writes or deletes a file in the linked folder: this dialog only names the agents,
// the steps the operator performs in their own editor and the prompt to paste. The
// agent writes the file; OPEN remains the explicit trust gesture that loads it.
export const SCRIPT_DOCS = 'https://ahlookah.com/docs/custom-scripts.html';

// One prompt per kind. The docs reference changes with the kind: a Pattern starts at
// the page's complete API reference, while an FX lands directly on the image-input
// contract that makes an effect an FX at all — the wired image, not a mode flag,
// is what selects FX at runtime.
export const SCRIPT_KINDS = {
  pattern: {
    label: 'Pattern',
    task: 'Create an ahLOOKah script-based pattern.',
    docs: SCRIPT_DOCS,
    placeholder: '<your prompt for the pattern here>',
  },
  fx: {
    label: 'FX (image input)',
    task: 'Create an ahLOOKah script-based FX. Declare fx: { input: \'image\' } and draw from ctx.imageInput; a connected image input is what selects FX at runtime.',
    docs: `${SCRIPT_DOCS}#api-image-input-fx-opt-in-graph-contract`,
    placeholder: '<your prompt for the FX here>',
  },
};

export function scriptPrompt(kind) {
  const { task, docs, placeholder } = SCRIPT_KINDS[kind];
  return `${task} Then use this as the documentation: ${docs}\n\n"${placeholder}"`;
}

// Desktop app pages only: the operator installs and signs in themselves, and the
// dialog never suggests running anything on the operator's machine.
const AGENTS = [
  ['Codex', 'https://openai.com/codex/'],
  ['Claude', 'https://claude.com/download'],
  ['OpenCode', 'https://opencode.ai/download'],
];

export function CreateScriptModal({ opener, onClose }) {
  const dialog = useRef(null);
  const id = useId();
  const [kind, setKind] = useState('pattern');
  const [copy, setCopy] = useState('idle');
  useEffect(() => {
    const element = dialog.current;
    element.showModal();
    return () => { element.close(); opener.current?.focus(); };
  }, []);
  const prompt = scriptPrompt(kind);
  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopy('copied');
    } catch {
      setCopy('failed');
    }
  };
  return createPortal(<dialog ref={dialog} className="create-script key-map-modal-card" aria-labelledby={`${id}-title`} onCancel={onClose} onKeyDown={e => e.stopPropagation()}>
    <button className="device-setup-modal-close" aria-label="Close create script" onClick={onClose}>×</button>
    <h2 id={`${id}-title`}>Create a script</h2>
    <p className="device-setup-modal-desc">ahLOOKah does not write code or files. Use a coding agent &amp; then <strong>OPEN</strong> the created script.</p>
    <div className="device-setup-modal-field">
      <label htmlFor={`${id}-kind`}>Create</label>
      <Select id={`${id}-kind`} value={kind} onChange={e => { setKind(e.target.value); setCopy('idle'); }}>
        {Object.entries(SCRIPT_KINDS).map(([value, entry]) => <option key={value} value={value}>{entry.label}</option>)}
      </Select>
    </div>
    <ol className="create-script-steps">
      <li>
        <p>Install and run a coding agent like Codex, Claude or OpenCode. These links open their desktop-app pages:</p>
        <ul className="create-script-agents">
          {AGENTS.map(([name, href]) => <li key={name}><a href={href} target="_blank" rel="noreferrer">{name}</a></li>)}
        </ul>
      </li>
      <li>
        <p>Open the linked folder as a project in your coding editor.</p>
      </li>
      <li>
        <p>Paste this prompt into the agent, replacing the quoted line with what you want it to build:</p>
        <pre className="create-script-prompt"><code>{prompt}</code></pre>
      </li>
    </ol>
    <p className="script-hint">The agent saves a <code>.viz.js</code> file. Once done, <strong>OPEN</strong> it as a script.</p>
    <div className="device-setup-modal-actions">
      <button className="btn btn--md" disabled={copy === 'copied'} onClick={copyPrompt}>{copy === 'copied' ? 'Copied' : 'Copy prompt'}</button>
      <button className="btn btn--md" onClick={onClose}>Close</button>
    </div>
    {copy === 'failed' && <p role="status">Copy failed — select the prompt above and copy it manually.</p>}
  </dialog>, document.body);
}
