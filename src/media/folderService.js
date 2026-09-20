import { createHandleStorage } from '../platform/handleStorage.js';
import { chooseFolder, folderPermission, requireFolderPermission, scanFolder } from '../platform/folderAccess.js';
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
  async scan(handle) {
    await requireFolderPermission(handle);
    return (await scanFolder(handle, { accepts: mediaKindForName, limit: 256 })).map(entry => ({ ...entry, kind: mediaKindForName(entry.name), mime: mimeForName(entry.name) }));
  }
  async link() {
    const handle = await chooseFolder({ id: 'viz2-media-folder', label: 'Media' });
    const files = await this.scan(handle); // canceled/denied/invalid folder leaves the previous link intact
    await this.lock(async () => {
      await this.storage('folder', handle);
      await this.restore();
      try { await this.onFiles(files); }
      finally { this.channel?.postMessage('changed'); }
    });
  }
  async refresh(request = true) {
    // Permission must be requested from the gesture, before entering the lock.
    if (request && this.handle) await requireFolderPermission(this.handle, 'read', true);
    return this.lock(async () => {
      await this.restore();
      if (!this.handle) return;
      if (!request && this.status.permission !== 'granted') return;
      await this.onFiles(await this.scan(this.handle));
    });
  }
  async unlink() {
    await this.lock(async () => { await this.storage('folder', null); await this.restore(); });
    this.channel?.postMessage('changed');
  }
  close() { this.closed = true; this.channel?.close(); }
}
