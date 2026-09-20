import { createHandleStorage } from './handleStorage.js';
import { scanFolder, folderPermission } from './folderAccess.js';
import { folderReference, sanitizeFolderReferences, importFolderReferences } from './folderReferences.js';
import { scriptStorage } from '../custom-scripts/storage.js';
import { nodeFileId } from '../nodes/repository.js';

const nodesStorage = createHandleStorage('viz2-node-patterns');
const mediaStorage = createHandleStorage('viz2-media-folder');
const merge = (pending, files) => [...new Map([...(pending || []), ...files].map(file => [file.id || `${file.linked}:${file.fileName}`, file])).values()];

export async function collectFolderReferences(media) {
  const script = await scriptStorage('active');
  const scriptsHandle = script && 'folder' in script ? script.folder : await scriptStorage('folder');
  const nodes = await nodesStorage('handles');
  const mediaHandle = await mediaStorage('folder');
  const result = {};
  result.scripts = {
    folderName: folderReference('scripts')?.folderName || scriptsHandle?.name || null,
    files: merge(folderReference('scripts')?.files, (script?.sources || []).map(source => ({ fileName: source.name, linked: true }))),
  };
  let nodeFiles = [];
  const pendingNodes = folderReference('nodes');
  if (nodes?.folder && !pendingNodes?.needsRelink && (!pendingNodes?.folderName || pendingNodes.folderName === nodes.folder.handle.name) && await folderPermission(nodes.folder.handle) === 'granted') {
    // Export names only. No graph contents, native handles or standalone node export.
    nodeFiles = await Promise.all((await scanFolder(nodes.folder.handle, { accepts: name => name.endsWith('.nodes.json'), limit: 64 })).map(async file => ({
      fileName: file.name, linked: true,
      id: folderReference('nodes')?.files.find(f => f.linked && f.fileName === file.name)?.id || await nodeFileId(nodes.folder.id, file.name),
    })));
  } else nodeFiles = pendingNodes ? [] : nodes?.references || []; // Last successful scan if permissions expired.
  result.nodes = {
    folderName: folderReference('nodes')?.folderName || nodes?.folder?.handle.name || null,
    files: merge(folderReference('nodes')?.files, [...nodeFiles, ...(nodes?.opened || []).map(file => ({ fileName: file.handle.name, id: file.id, linked: false }))]),
  };
  const mediaFolderName = folderReference('media')?.folderName || mediaHandle?.name || null;
  result.media = {
    folderName: mediaFolderName,
    files: merge(folderReference('media')?.files, media.filter(file => file.fileName).map(file => ({ fileName: file.fileName, id: file.id, linked: !!mediaFolderName && file.folderName === mediaFolderName }))),
  };
  return sanitizeFolderReferences(result);
}

export async function applyFolderReferences(references) {
  importFolderReferences(references);
  if (!references) return; // Old exports keep their historical library behavior.
  // Forget executable script snapshots on import: selecting a folder does not
  // confer trust in scripts. The user must Open each desired script explicitly.
  const script = await scriptStorage('active');
  const folder = references.scripts.folderName ? (script?.folder || await scriptStorage('folder')) : null;
  await scriptStorage('active', { selectionVersion: 1, revision: Date.now(), sources: [], files: [], folder, changed: [] });
  const nodes = await nodesStorage('handles');
  await nodesStorage('handles', { folder: references.nodes.folderName ? nodes?.folder || null : null, opened: [] });
  if (!references.media.folderName) await mediaStorage('folder', null);
}
