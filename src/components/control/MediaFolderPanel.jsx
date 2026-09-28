import { useRef, useState } from 'react';
import { useRuntime } from '../../app/RuntimeContext.jsx';
import { useVizStore } from '../../state/useVizStore.js';
import { FolderControls, FolderSupportNotice, useFolderAction } from './FolderControls.jsx';
import { DirectoryPicker } from './DirectoryPicker.jsx';

export function MediaFolderPanel() {
  const { runtime, store } = useRuntime();
  const service = runtime.mediaFolder;
  const status = useVizStore(store, s => s.mediaFolder) || service.status;
  const { busy, message, run } = useFolderAction();
  const [picker, setPicker] = useState(null);
  const opener = useRef(null);
  // ADD opens the linked folder's picker, and that is now its only path: a media
  // pattern is a reference into a directory this browser holds a handle for, so
  // without a link there is nothing to point at. The native picker and the hidden
  // <input type="file"> fallback are gone with the unlinked behaviour.
  const open = event => {
    opener.current = event.currentTarget;
    if (status.folder) setPicker(service.browse());
  };
  const linked = Boolean(status.folder);
  return <section className="media-folder-panel" aria-label="Media files" onKeyDown={e => e.stopPropagation()}>
    <FolderControls label="Media" folder={status.folder} permission={status.permission} busy={busy} run={run}
      link={() => service.link()} refresh={() => service.refresh()} unlink={() => service.unlink()}
      note="Unlink keeps loaded media and source files.">
      <button className="library-add-btn media-add-btn" aria-label="Add media" disabled={busy || !linked}
        title={linked ? 'Add media from the linked folder' : 'Link Folder before adding media'} onClick={open}>ADD</button>
    </FolderControls>
    {picker && <DirectoryPicker title="Open Media" label="Media" folder={status.folder} listing={picker} open={name => service.open(name)} opener={opener} onClose={() => setPicker(null)} />}
    <FolderSupportNotice label="Media" />
    {!linked && <p className="script-hint">Link Folder before adding media.</p>}
    {message && <p role="status">{message}</p>}
    {status.errors.map(error => <p role="alert" key={error}>{error}</p>)}
  </section>;
}
