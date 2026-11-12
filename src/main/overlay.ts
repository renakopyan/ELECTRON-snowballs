import { BrowserWindow, app, ipcMain, screen, type Display, type IpcMainEvent } from 'electron';
import * as path from 'node:path';
import { computeScene, isCoveredByFullscreenWindow } from './surfaces';
import { WindowTracker } from './window-tracker';

const SETTLING_FRAME_RATE = 20;
// Над снеговиком оверлей ловит клики. Если страница перестала подтверждать это
// (зависла, окно скрыто), через столько мс клики снова проходят сквозь снег.
const INTERACTIVE_TIMEOUT_MS = 1200;

interface Overlay {
  win: BrowserWindow;
  display: Display;
  ready: boolean;
  shown: boolean;
  interactive: boolean;
  interactiveTimer: NodeJS.Timeout | null;
}

/**
 * Держит по одному прозрачному окну-оверлею на каждый монитор,
 * следит за мониторами и сообщает оверлеям, где может лежать снег.
 */
export class OverlayManager {
  private readonly overlays = new Map<number, Overlay>();
  private readonly tracker = new WindowTracker((snapshot) => {
    this.setSettling(snapshot.settling === true);
    // Листают рабочие столы: сцена прежняя, лишних сообщений оверлеям не шлём
    if (snapshot.settling) return;
    this.snapshot = snapshot;
    for (const overlay of this.overlays.values()) {
      this.applyVisibility(overlay); // могло появиться или исчезнуть полноэкранное окно
      this.pushScene(overlay);
    }
  });
  private snapshot: ScreenSnapshot = { windows: [], dock: null, hidden: [] };
  private snowing = true;              // пауза из меню или по горячей клавише
  private pausedAt: number | null = null;
  private locked = false;              // экран заблокирован
  private frameRate = 0;
  private settling = false;            // листают рабочие столы — на это время снег рисуем реже

  constructor(private settings: SnowSettings) {}

  get visible(): boolean {
    return this.snowing;
  }

  start(): void {
    screen.getAllDisplays().forEach((display) => this.add(display));

    screen.on('display-added', (_event, display) => this.add(display));
    screen.on('display-removed', (_event, display) => this.remove(display.id));
    screen.on('display-metrics-changed', (_event, display) => {
      const overlay = this.overlays.get(display.id);
      if (!overlay) return;
      overlay.display = display;
      overlay.win.setBounds(display.bounds);
      this.pushScene(overlay);
    });

    ipcMain.on('overlay-interactive', this.onInteractive);
    this.tracker.start();
  }

  /** Вызвать снегоуборочную машину на всех мониторах */
  callPlow(): void {
    for (const overlay of this.overlays.values()) this.send(overlay, 'plow');
  }

  setVisible(visible: boolean): void {
    if (visible === this.snowing) return;
    this.snowing = visible;

    if (!visible) {
      this.pausedAt = Date.now();
    } else if (this.pausedAt !== null) {
      // Пока снег стоял на паузе, сугробы подтаяли
      const seconds = (Date.now() - this.pausedAt) / 1000;
      this.pausedAt = null;
      for (const overlay of this.overlays.values()) this.send(overlay, 'melt', seconds);
    }
    this.applyState();
  }

  setLocked(locked: boolean): void {
    this.locked = locked;
    this.applyState();
  }

  setSettings(settings: SnowSettings): void {
    this.settings = settings;
    for (const overlay of this.overlays.values()) {
      this.send(overlay, 'settings', settings);
      this.pushScene(overlay); // после включения сугробов оверлею нужны кромки заново
      this.applyVisibility(overlay);
    }
  }

  /** 0 — без ограничения */
  setFrameRate(fps: number): void {
    this.frameRate = fps;
    this.sendFrameRate();
  }

  clearDrifts(): void {
    for (const overlay of this.overlays.values()) this.send(overlay, 'clear-drifts');
  }

  dispose(): void {
    ipcMain.removeListener('overlay-interactive', this.onInteractive);
    for (const overlay of this.overlays.values()) this.setInteractive(overlay, false);
    this.tracker.stop();
  }

  private readonly onInteractive = (event: IpcMainEvent, interactive: unknown): void => {
    if (typeof interactive !== 'boolean') return;
    for (const overlay of this.overlays.values()) {
      // Принимаем только от наших собственных оверлеев
      if (overlay.win.isDestroyed() || overlay.win.webContents !== event.sender) continue;
      this.setInteractive(overlay, interactive && overlay.shown);
    }
  };

  /** true — окно ловит клики и движения мыши; false — пропускает клики сквозь себя */
  private setInteractive(overlay: Overlay, interactive: boolean): void {
    if (overlay.interactiveTimer) clearTimeout(overlay.interactiveTimer);
    overlay.interactiveTimer = null;
    if (overlay.win.isDestroyed()) return;

    if (interactive) {
      overlay.win.setIgnoreMouseEvents(false);
      overlay.interactiveTimer = setTimeout(() => this.setInteractive(overlay, false), INTERACTIVE_TIMEOUT_MS);
    } else if (overlay.interactive) {
      overlay.win.setIgnoreMouseEvents(true, { forward: true });
    }
    overlay.interactive = interactive;
  }

  private add(display: Display): void {
    if (this.overlays.has(display.id)) return;

    const win = new BrowserWindow({
      ...display.bounds,
      show: false,
      transparent: true, // прозрачный фон
      frame: false,      // без рамки и заголовка
      hasShadow: false,
      alwaysOnTop: true, // поверх всех окон
      skipTaskbar: true, // не показывать в Dock / панели задач
      focusable: false,  // окно не перехватывает фокус
      resizable: false,
      movable: false,
      enableLargerThanScreen: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    const overlay: Overlay = { win, display, ready: false, shown: false, interactive: false, interactiveTimer: null };

    // Клики проходят сквозь снег; forward нужен, чтобы оверлей всё же видел
    // движение курсора и снег можно было смахнуть
    win.setIgnoreMouseEvents(true, { forward: true });
    // Самый высокий уровень — поверх почти всего
    win.setAlwaysOnTop(true, 'screen-saver');
    // Снег виден на всех рабочих столах (macOS Spaces)
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    win.webContents.on('did-finish-load', () => {
      overlay.ready = true;
      this.send(overlay, 'settings', this.settings);
      this.send(overlay, 'frame-rate', this.effectiveFrameRate());
      this.pushScene(overlay);
      this.applyVisibility(overlay);
    });
    win.on('closed', () => this.overlays.delete(display.id));

    this.overlays.set(display.id, overlay);
    win.loadFile(path.join(app.getAppPath(), 'index.html')).catch((error: unknown) => {
      console.error('Не удалось загрузить оверлей:', error);
    });
  }

  /** Во время перехода между рабочими столами не мешаем системной анимации */
  private effectiveFrameRate(): number {
    if (!this.settling) return this.frameRate;
    return this.frameRate > 0 ? Math.min(this.frameRate, SETTLING_FRAME_RATE) : SETTLING_FRAME_RATE;
  }

  private sendFrameRate(): void {
    const fps = this.effectiveFrameRate();
    for (const overlay of this.overlays.values()) this.send(overlay, 'frame-rate', fps);
  }

  private setSettling(settling: boolean): void {
    if (settling === this.settling) return;
    this.settling = settling;
    this.sendFrameRate();
  }

  private remove(displayId: number): void {
    const overlay = this.overlays.get(displayId);
    if (overlay?.interactiveTimer) clearTimeout(overlay.interactiveTimer);
    overlay?.win.destroy();
    this.overlays.delete(displayId);
  }

  /** Пауза или блокировка экрана: прячем снег и перестаём следить за окнами */
  private applyState(): void {
    if (this.snowing && !this.locked) this.tracker.start();
    else this.tracker.stop();
    for (const overlay of this.overlays.values()) this.applyVisibility(overlay);
  }

  private applyVisibility(overlay: Overlay): void {
    if (!overlay.ready || overlay.win.isDestroyed()) return;

    const inFullscreen =
      this.settings.hideInFullscreen &&
      isCoveredByFullscreenWindow(overlay.display.bounds, this.snapshot.windows);
    const shouldShow = this.snowing && !this.locked && !inFullscreen;
    if (shouldShow === overlay.shown) return;

    overlay.shown = shouldShow;
    if (shouldShow) {
      overlay.win.showInactive();
    } else {
      this.setInteractive(overlay, false);
      overlay.win.hide();
    }
  }

  private pushScene(overlay: Overlay): void {
    const { bounds, workArea } = overlay.display;
    this.send(overlay, 'scene', computeScene(bounds, workArea, this.snapshot, process.platform));
  }

  private send(overlay: Overlay, channel: string, payload?: unknown): void {
    if (overlay.ready && !overlay.win.isDestroyed()) overlay.win.webContents.send(channel, payload);
  }
}
