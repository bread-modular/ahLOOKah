// Portable hints, never native handles or file contents. Names are not identities:
// every imported folder must be explicitly selected, even if its name matches.
export const FOLDER_REFERENCES_KEY = 'viz2_folder_references';
export const FOLDER_SECTIONS = ['scripts', 'nodes', 'media'];
const labels = { scripts: 'Custom Scripts', nodes: 'Node Patterns', media: 'Media' };
const safeName = value => typeof value === 'string' && value.length <= 255 && value.length > 0 && !/[\\/\x00-\x1f]/.test(value) && value !== '.' && value !== '..';

export function sanitizeFolderReferences(raw) {
  if (raw === undefined) return undefined; // Old exports did not carry references.
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid folder references.');
  const result = {};
  for (const section of FOLDER_SECTIONS) {
    const entry = raw[section];
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.files) || entry.files.length > 256 ||
        (entry.folderName !== null && !safeName(entry.folderName))) throw new Error(`Invalid ${labels[section]} folder reference.`);
    const ids = new Set();
    const files = entry.files.map(file => {
      if (!file || !safeName(file.fileName)) throw new Error(`Invalid ${labels[section]} filename.`);
      if (file.id !== undefined && (typeof file.id !== 'string' || !/^[\w-]{1,100}$/.test(file.id) || (section === 'nodes' && !file.id.startsWith('nodes-')) || ids.has(file.id))) throw new Error(`Invalid or duplicate ${labels[section]} file ID.`);
      if (file.id) ids.add(file.id);
      return { fileName: file.fileName, linked: file.linked === true,
        ...(typeof file.id === 'string' && /^[\w-]{1,100}$/.test(file.id) ? { id: file.id } : {}) };
    });
    result[section] = { folderName: entry.folderName, files };
  }
  return result;
}

export function folderReference(section) {
  const raw = localStorage.getItem(FOLDER_REFERENCES_KEY);
  return raw ? JSON.parse(raw)[section] : undefined;
}
export function importFolderReferences(references) {
  if (!references) { localStorage.removeItem(FOLDER_REFERENCES_KEY); return; }
  const clean = sanitizeFolderReferences(references);
  for (const entry of Object.values(clean)) entry.needsRelink = !!entry.folderName;
  localStorage.setItem(FOLDER_REFERENCES_KEY, JSON.stringify(clean));
}
export function assertFolderReference(section, handle, choosing = false) {
  const ref = folderReference(section);
  if (!ref?.folderName) return;
  const label = labels[section];
  if (handle?.name !== ref.folderName) throw new Error(`${label}: expected folder “${ref.folderName}”, found ${handle ? `“${handle.name}”` : 'no linked folder'}. Use Relink Folder to select “${ref.folderName}”.`);
  if (ref.needsRelink && !choosing) throw new Error(`${label}: Relink Folder to confirm “${ref.folderName}”. Folder names alone cannot identify a directory.`);
}
export function confirmFolderReference(section) {
  const raw = localStorage.getItem(FOLDER_REFERENCES_KEY);
  if (!raw) return;
  const refs = JSON.parse(raw);
  if (refs[section]) refs[section].needsRelink = false;
  localStorage.setItem(FOLDER_REFERENCES_KEY, JSON.stringify(refs));
}
export function missingFolderFiles(section, names) {
  return (folderReference(section)?.files || []).filter(file => file.linked && !names.includes(file.fileName))
    .map(file => `${labels[section]}: missing “${file.fileName}”. Restore the file, then Refresh folder or Relink Folder.`);
}
export function referencedFileId(section, name, linked) {
  const matches = folderReference(section)?.files.filter(file => file.fileName === name && file.linked === linked) || [];
  if (matches.length > 1) throw new Error(`${name}: multiple imported references share this filename. Names alone cannot identify the original file.`);
  return matches[0]?.id;
}

export function forgetFolderFile(section, value) {
  const raw = localStorage.getItem(FOLDER_REFERENCES_KEY);
  if (!raw) return;
  const refs = JSON.parse(raw);
  if (!refs[section]) return;
  refs[section].files = refs[section].files.filter(file => section === 'media' ? file.id !== value : file.fileName !== value);
  localStorage.setItem(FOLDER_REFERENCES_KEY, JSON.stringify(refs));
}
