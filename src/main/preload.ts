import { contextBridge, ipcRenderer } from 'electron';

function subscribe<T>(channel: string): (callback: (payload: T) => void) => void {
  return (callback) => {
    ipcRenderer.on(channel, (_event, payload: T) => callback(payload));
  };
}

// Единственный мост между главным процессом и страницей со снегом
const bridge: SnowBridge = {
  onScene: subscribe<SnowScene>('scene'),
  onClearDrifts: subscribe<void>('clear-drifts'),
  onSettings: subscribe<SnowSettings>('settings'),
  onFrameRate: subscribe<number>('frame-rate'),
  onMelt: subscribe<number>('melt'),
  onPlow: subscribe<void>('plow'),
  setInteractive: (interactive) => ipcRenderer.send('overlay-interactive', interactive),
};

contextBridge.exposeInMainWorld('snowBridge', bridge);
