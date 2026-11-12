import { Menu, Tray, nativeImage, type MenuItemConstructorOptions, type NativeImage } from 'electron';

export interface TrayState {
  snowing: boolean;
  settings: SnowSettings;
  /** null — пункт автозапуска не показываем (приложение запущено из исходников) */
  openAtLogin: boolean | null;
}

export interface TrayHandlers {
  getState: () => TrayState;
  onToggle: (snowing: boolean) => void;
  onSettings: (patch: Partial<SnowSettings>) => void;
  onOpenAtLogin: (enabled: boolean) => void;
  onClear: () => void;
  onPlow: () => void;
  onQuit: () => void;
  /** Сочетание клавиш для паузы — показывается рядом с пунктом меню */
  toggleShortcut: string;
}

const ICON_SIZE = 32; // физические пиксели; при scaleFactor 2 это 16pt
const ICON_SCALE = 2;

/** Расстояние от точки до отрезка */
function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Рисует снежинку прямо в буфер пикселей, чтобы не хранить картинки в проекте.
 * Пиксели либо полностью залиты, либо прозрачны; цвет — оттенок серого,
 * поэтому порядок каналов (RGBA/BGRA) значения не имеет.
 */
export function renderSnowflakeBitmap(size: number, shade: number): Buffer {
  const center = (size - 1) / 2;
  const armLength = size * 0.44;
  const branchLength = size * 0.14;
  const halfThickness = size * 0.04;

  const segments: Array<[number, number, number, number]> = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i + Math.PI / 2;
    const tipX = center + Math.cos(angle) * armLength;
    const tipY = center + Math.sin(angle) * armLength;
    segments.push([center, center, tipX, tipY]);

    // Две короткие «веточки» на каждом луче
    const baseX = center + Math.cos(angle) * armLength * 0.6;
    const baseY = center + Math.sin(angle) * armLength * 0.6;
    for (const turn of [-Math.PI / 3, Math.PI / 3]) {
      segments.push([
        baseX,
        baseY,
        baseX + Math.cos(angle + turn) * branchLength,
        baseY + Math.sin(angle + turn) * branchLength,
      ]);
    }
  }

  const bitmap = Buffer.alloc(size * size * 4);
  const pixel = Buffer.from([shade, shade, shade, 255]);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const filled = segments.some(([ax, ay, bx, by]) => distanceToSegment(x, y, ax, ay, bx, by) <= halfThickness);
      if (filled) pixel.copy(bitmap, (y * size + x) * 4);
    }
  }
  return bitmap;
}

function createIcon(): NativeImage {
  const isMac = process.platform === 'darwin';
  // macOS сам перекрашивает template-иконку под тему; на Windows рисуем белую
  const icon = nativeImage.createFromBitmap(renderSnowflakeBitmap(ICON_SIZE, isMac ? 0 : 255), {
    width: ICON_SIZE,
    height: ICON_SIZE,
    scaleFactor: ICON_SCALE,
  });
  if (isMac) icon.setTemplateImage(true);
  return icon;
}

/** Подменю с переключателем «один из нескольких» для одной настройки */
function choice<K extends keyof SnowSettings>(
  handlers: TrayHandlers,
  settings: SnowSettings,
  key: K,
  options: Array<[SnowSettings[K], string]>,
): MenuItemConstructorOptions[] {
  return options.map(([value, label]) => ({
    label,
    type: 'radio',
    checked: settings[key] === value,
    click: () => handlers.onSettings({ [key]: value } as unknown as Partial<SnowSettings>),
  }));
}

/** Галочка для настройки «вкл/выкл» */
function toggle(
  handlers: TrayHandlers,
  settings: SnowSettings,
  key: 'drifts' | 'frost' | 'garland' | 'plow' | 'hideInFullscreen',
  label: string,
): MenuItemConstructorOptions {
  return {
    label,
    type: 'checkbox',
    checked: settings[key],
    click: (item) => handlers.onSettings({ [key]: item.checked }),
  };
}

function buildMenu(handlers: TrayHandlers): Menu {
  const { snowing, settings, openAtLogin } = handlers.getState();

  const template: MenuItemConstructorOptions[] = [
    {
      label: 'Снег идёт',
      type: 'checkbox',
      checked: snowing,
      accelerator: handlers.toggleShortcut,
      click: (item) => handlers.onToggle(item.checked),
    },
    { type: 'separator' },
    {
      label: 'Снегопад',
      submenu: choice(handlers, settings, 'intensity', [
        ['light', 'Лёгкий'],
        ['steady', 'Ровный'],
        ['blizzard', 'Метель'],
        ['thaw', 'Оттепель — снег не идёт и тает'],
      ]),
    },
    {
      label: 'Ветер',
      submenu: choice(handlers, settings, 'wind', [
        ['calm', 'Штиль'],
        ['gusty', 'Порывистый'],
        ['left', 'Влево'],
        ['right', 'Вправо'],
      ]),
    },
    {
      label: 'Сугробы',
      submenu: [
        toggle(handlers, settings, 'drifts', 'Копить сугробы'),
        { type: 'separator' },
        ...choice(handlers, settings, 'pileSpeed', [
          ['slow', 'Растут медленно'],
          ['normal', 'Растут обычно'],
          ['fast', 'Растут быстро'],
        ]),
      ],
    },
    {
      label: 'Курсор',
      submenu: choice(handlers, settings, 'tool', [
        ['mitten', 'Варежка — смахивать снег'],
        ['shovel', 'Лопата — сгребать снег в кучу'],
        ['snowball', 'Снежки — катать шары, лепить и бросать'],
      ]),
    },
    {
      label: 'Украшения',
      submenu: [
        toggle(handlers, settings, 'frost', 'Иней по краям экрана'),
        toggle(handlers, settings, 'garland', 'Гирлянда'),
      ],
    },
    {
      label: 'Снегоуборочная машина',
      submenu: [
        toggle(handlers, settings, 'plow', 'Выезжает сама, когда намело'),
        { label: 'Вызвать сейчас', click: handlers.onPlow },
      ],
    },
    { label: 'Смести весь снег', click: handlers.onClear },
    { type: 'separator' },
    toggle(handlers, settings, 'hideInFullscreen', 'Скрывать в полноэкранном режиме'),
  ];

  if (openAtLogin !== null) {
    template.push({
      label: 'Запускать при входе в систему',
      type: 'checkbox',
      checked: openAtLogin,
      click: (item) => handlers.onOpenAtLogin(item.checked),
    });
  }

  template.push({ type: 'separator' }, { label: 'Выйти', click: handlers.onQuit });
  return Menu.buildFromTemplate(template);
}

export interface TrayMenu {
  /** Перестраивает меню после смены настроек или состояния паузы */
  refresh: () => void;
  destroy: () => void;
}

/** Иконка в меню-баре / трее: пауза, настройки снега, уборка сугробов и выход */
export function createTray(handlers: TrayHandlers): TrayMenu {
  const tray = new Tray(createIcon());
  tray.setToolTip('Snow');

  const refresh = (): void => tray.setContextMenu(buildMenu(handlers));
  refresh();
  return { refresh, destroy: () => tray.destroy() };
}
