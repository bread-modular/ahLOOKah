import { useRef, useState } from 'react';
import { useRuntime } from '../../app/RuntimeContext.jsx';
import { useVizStore } from '../../state/useVizStore.js';
import { canUseFileSystemPicker } from '../../media/media-store.js';
import { FolderControls, useFolderAction } from './FolderControls.jsx';
import { DirectoryPicker } from './DirectoryPicker.jsx';

export function MediaFolderPanel() {
  const { runtime, store } = useRuntime();
  const service = runtime.mediaFolder;
  const status = useVizStore(store, s => s.mediaFolder) || service.status;
  const { busy, message, run } = useFolderAction();
  const [picker, setPicker] = useState(null);
  const opener = useRef(null);
  const input = useRef(null);
  const open = event => {
    opener.current = event.currentTarget;
    if (status.folder) setPicker(service.browse());
    else if (canUseFileSystemPicker()) run(() => runtime.commands.addMediaFiles());
    else input.current?.click();
  };
  // One ADD control covers both paths: a linked folder opens its file picker,
  // otherwise the native/multi-file picker adds files directly.
  return <section className="media-folder-panel" aria-label="Media files" onKeyDown={e => e.stopPropagation()}>
    <FolderControls label="Media" folder={status.folder} permission={status.permission} busy={busy} run={run}
      link={() => service.link()} refresh={() => service.refresh()} unlink={() => service.unlink()}
      note="Unlink keeps loaded media and source files.">
      <button className="library-add-btn media-add-btn" aria-label="Add media" disabled={busy} onClick={open}>ADD</button>
    </FolderControls>
    {picker && <DirectoryPicker title="Open Media" label="Media" folder={status.folder} listing={picker} open={name => service.open(name)} opener={opener} onClose={() => setPicker(null)} />}
    <input ref={input} type="file" accept="image/*,video/*" multiple className="media-file-input" onChange={event => {
      const files = Array.from(event.target.files || []);
      if (files.length) run(() => runtime.commands.addMediaFiles(files));
      event.target.value = '';
    }} />
    {message && <p role="status">{message}</p>}
    {status.errors.map(error => <p role="alert" key={error}>{error}</p>)}
  </section>;
}
