const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openFiles: () => ipcRenderer.invoke('open-files'),
  probeFile: (filePath) => ipcRenderer.invoke('probe-file', filePath),
  chooseSavePath: (defaultName) => ipcRenderer.invoke('choose-save-path', defaultName),
  exportVideo: (payload) => ipcRenderer.invoke('export-video', payload),
  onExportProgress: (callback) => {
    ipcRenderer.removeAllListeners('export-progress');
    ipcRenderer.on('export-progress', (event, data) => callback(data));
  },
});
