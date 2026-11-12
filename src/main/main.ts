import { app, globalShortcut, powerMonitor } from 'electron';
import { OverlayManager } from './overlay';
import { startProfiler } from './profiler';
import { denyAllPermissions, hardenWebContents } from './security';
import { SettingsStore } from './settings';
import { createTray, type TrayMenu } from './tray';

const TOGGLE_SHORTCUT = 'CommandOrControl+Alt+Shift+S';
const BATTERY_FRAME_RATE = 30; // от аккумулятора рисуем вдвое реже

// Ссылку на меню нужно держать, иначе сборщик мусора уберёт иконку из меню-бара
let trayMenu: TrayMenu | null = null;

function bootstrap(): void {
  denyAllPermissions();

  // На macOS прячем иконку из Dock, чтобы был чистый фоновой процесс
  if (process.platform === 'darwin') app.dock?.hide();

  startProfiler();

  const settings = new SettingsStore();
  const overlays = new OverlayManager(settings.value);
  overlays.start();

  const setSnowing = (snowing: boolean): void => {
    overlays.setVisible(snowing);
    trayMenu?.refresh();
  };

  trayMenu = createTray({
    getState: () => ({
      snowing: overlays.visible,
      settings: settings.value,
      // Автозапуск имеет смысл только для собранного приложения
      openAtLogin: app.isPackaged ? app.getLoginItemSettings().openAtLogin : null,
    }),
    onToggle: setSnowing,
    onSettings: (patch) => settings.update(patch),
    onOpenAtLogin: (enabled) => {
      app.setLoginItemSettings({ openAtLogin: enabled });
      trayMenu?.refresh();
    },
    onClear: () => overlays.clearDrifts(),
    onPlow: () => overlays.callPlow(),
    onQuit: () => app.quit(),
    toggleShortcut: TOGGLE_SHORTCUT,
  });

  settings.onChange((value) => {
    overlays.setSettings(value);
    trayMenu?.refresh();
  });

  if (!globalShortcut.register(TOGGLE_SHORTCUT, () => setSnowing(!overlays.visible))) {
    console.warn(`Сочетание ${TOGGLE_SHORTCUT} занято другой программой — пауза доступна только из меню.`);
  }

  // Экран заблокирован — рисовать не для кого
  powerMonitor.on('lock-screen', () => overlays.setLocked(true));
  powerMonitor.on('unlock-screen', () => overlays.setLocked(false));

  // От аккумулятора снижаем частоту кадров
  const applyPowerMode = (): void => {
    overlays.setFrameRate(powerMonitor.isOnBatteryPower() ? BATTERY_FRAME_RATE : 0);
  };
  powerMonitor.on('on-battery', applyPowerMode);
  powerMonitor.on('on-ac', applyPowerMode);
  applyPowerMode();

  app.on('before-quit', () => {
    globalShortcut.unregisterAll();
    overlays.dispose();
    trayMenu?.destroy();
  });
}

// Закрыть навигацию и новые окна нужно до создания первого окна
hardenWebContents();

// Второй запуск не должен удваивать снег
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app
    .whenReady()
    .then(bootstrap)
    .catch((error: unknown) => {
      console.error('Не удалось запустить снег:', error);
      app.quit();
    });

  // Окон может временно не остаться (например, при переподключении монитора) —
  // приложение при этом продолжает жить. Выход — через меню в трее или Ctrl+C.
  app.on('window-all-closed', () => {});
}
