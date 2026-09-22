import { assertFolderReference, confirmFolderReference, missingFolderFiles } from '../platform/folderReferences.js';
import { ensureProjectFolder } from '../platform/project-folders.js';
import { createHandleStorage } from '../platform/handleStorage.js';
import { chooseFolder, folderPermission, requireFolderPermission, scanFolder, linkedFile } from '../platform/folderAccess.js';
import { mediaKindForName, mimeForName } from './media-store.js';

// Folder links never contain media bytes. Existing media persistence/playback
// consumes the same file handles as the individual-file picker.
export class MediaFolder {
  constructor({ storage = createHandleStorage('viz2-media-folder'), onFiles = async () => {}, onStatus = () => {} } = {}) {
    this.storage = storage; this.onFiles = onFiles; this.onStatus = onStatus;
    this.handle = null; this.status = { folder: '', permission: 'prompt', errors: [] };
    this.channel = null; this.closed = false;
  }
  publish(patch) { this.status = { ...this.status, ...patch }; if (!this.closed) this.onStatus(this.status); }
  lock(fn) { return navigator.locks.request('viz2-media-folder', fn); }
  async restore() {
    this.handle = await this.storage('folder');
    this.publish({ folder: this.handle?.name || '', permission: this.handle ? await folderPermission(this.handle) : 'prompt', errors: [] });
  }
  async start() {
    this.channel = new BroadcastChannel('viz2-media-folder');
    this.channel.onmessage = () => this.lock(() => this.restore()).catch(e => this.publish({ errors: [e.message] }));
    try { await this.refresh(false); } catch (e) { this.publish({ errors: [e.message] }); }
  }
  async scan(handle, choosing = false) {
    assertFolderReference('media', handle, choosing);
    await requireFolderPermission(handle);
    return (await scanFolder(handle, { accepts: mediaKindForName, limit: 256 })).map(entry => ({ ...entry, kind: mediaKindForName(entry.name), mime: mimeForName(entry.name), folderName: handle.name }));
  }
  async link() {
    const handle = await chooseFolder({ id: 'viz2-media-folder', label: 'Media' });
    const files = await this.scan(handle, true); // canceled/denied/invalid folder leaves the previous link intact
    await this.lock(async () => {
      await this.storage('folder', handle);
      confirmFolderReference('media');
      // Remember the directory identity so a project reopened on this computer
      // resolves Media without asking for a re-link.
      await ensureProjectFolder('media', handle);
      await this.restore();
      this.publish({ errors: missingFolderFiles('media', files.map(file => file.name)) });
      try { await this.onFiles(files); }
      finally { this.channel?.postMessage('changed'); }
    });
  }
  async refresh(request = true) {
    // Permission must be requested from the gesture, before entering the lock.
    if (request && this.handle) await requireFolderPermission(this.handle, 'read', true);
    return this.lock(async () => {
      await this.restore();
      assertFolderReference('media', this.handle);
      if (!this.handle) return;
      if (!request && this.status.permission !== 'granted') await requireFolderPermission(this.handle);
      const files = await this.scan(this.handle);
      this.publish({ errors: missingFolderFiles('media', files.map(file => file.name)) });
      await this.onFiles(files);
    });
  }
  async browse() {
    assertFolderReference('media', this.handle);
    await requireFolderPermission(this.handle, 'read', true);
    return this.scan(this.handle);
  }
  async open(name) {
    assertFolderReference('media', this.handle);
    await requireFolderPermission(this.handle, 'read', true);
    const handle = await linkedFile(this.handle, name, mediaKindForName);
    await handle.getFile(); // Report a deleted/unreadable selection before adding.
    await this.onFiles([{ handle, name, kind: mediaKindForName(name), mime: mimeForName(name), folderName: this.handle.name }]);
  }
  async unlink() {
    await this.lock(async () => { await this.storage('folder', null); await this.restore(); });
    this.channel?.postMessage('changed');
  }
  close() { this.closed = true; this.channel?.close(); }
}
