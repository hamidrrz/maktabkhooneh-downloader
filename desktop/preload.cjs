const { contextBridge, ipcRenderer } = require('electron');
const invoke = name => arg => ipcRenderer.invoke('mk:' + name,arg);
contextBridge.exposeInMainWorld('downloader',{
  settings:invoke('settings'),save:invoke('save'),importEnv:invoke('importEnv'),auth:invoke('auth'),pick:invoke('pick'),
  discover:invoke('discover'),start:invoke('start'),control:invoke('control'),open:invoke('open'),
  library:invoke('library'),openSaved:invoke('openSaved'),fileStatus:invoke('fileStatus'),openLogs:invoke('openLogs'),
  updates:callback=>{ ipcRenderer.on('mk:update',(_event,value)=>callback(value)); }
});
