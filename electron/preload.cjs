// Preload runs before the renderer and is the only bridge across the isolation
// boundary. It exposes named operations, never `ipcRenderer` itself.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('studio', {
  openProject: (path) => ipcRenderer.invoke('project:open', path),
  prepareProject: (project, basePath) =>
    ipcRenderer.invoke('project:prepare', { project, basePath }),
  saveProject: (project, path, saveAs) =>
    ipcRenderer.invoke('project:save', { project, path, saveAs }),
  listExamples: () => ipcRenderer.invoke('project:examples'),

  importAssets: (kind) => ipcRenderer.invoke('asset:import', kind),
  // Electron 32 removed File.path; webUtils is the supported way to turn a
  // dropped File back into a filesystem path, and it only exists in preload.
  pathForFile: (file) => webUtils.getPathForFile(file),
  describeFiles: (paths) => ipcRenderer.invoke('asset:describe', paths),
  // Fallback when a dropped File has no filesystem path: send the bytes.
  ingestFiles: (files) => ipcRenderer.invoke('asset:ingest', files),
  // Bytes for the preview mixer to decode; the renderer has no file access.
  readAudio: (path) => ipcRenderer.invoke('audio:read', path),
  listFonts: () => ipcRenderer.invoke('fonts:list'),
  listHands: () => ipcRenderer.invoke('hands:list'),

  exportCapabilities: () => ipcRenderer.invoke('export:capabilities'),
  startExport: (project, out) => ipcRenderer.invoke('export:start', { project, out }),
  // Returns an unsubscribe function so React effects can clean up; handing the
  // caller's own function to removeListener would not match the wrapper we
  // actually registered.
  onExportProgress: (fn) => {
    const wrapped = (_e, p) => fn(p);
    ipcRenderer.on('export:progress', wrapped);
    return () => ipcRenderer.removeListener('export:progress', wrapped);
  },
  reveal: (path) => ipcRenderer.invoke('shell:reveal', path),
});
