import { Menu, Tray, nativeImage, nativeTheme, type MenuItemConstructorOptions, type NativeImage } from 'electron';

export interface TrayState {
  snowing: boolean;
  settings: SnowSettings;
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
  toggleShortcut: string;
}

class SnowflakeIcon {
  private static readonly SIZE = 32;
  private static readonly SCALE = 2;

  static current(): NativeImage {
    const isMac = process.platform === 'darwin';
    const shade = isMac ? 0 : nativeTheme.shouldUseDarkColors ? 236 : 30;
    const icon = nativeImage.createFromBitmap(this.bitmap(this.SIZE, shade), {
      width: this.SIZE,
      height: this.SIZE,
      scaleFactor: this.SCALE,
    });
    if (isMac) icon.setTemplateImage(true);
    return icon;
  }

  static bitmap(size: number, shade: number): Buffer {
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
        const filled = segments.some(
          ([ax, ay, bx, by]) => this.distanceToSegment(x, y, ax, ay, bx, by) <= halfThickness,
        );
        if (filled) pixel.copy(bitmap, (y * size + x) * 4);
      }
    }
    return bitmap;
  }

  private static distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }
}

class TrayMenuBuilder {
  constructor(private readonly handlers: TrayHandlers) {}

  build(): Menu {
    const { snowing, settings, openAtLogin } = this.handlers.getState();

    const template: MenuItemConstructorOptions[] = [
      {
        label: 'Снег идёт',
        type: 'checkbox',
        checked: snowing,
        accelerator: this.handlers.toggleShortcut,
        click: (item) => this.handlers.onToggle(item.checked),
      },
      { type: 'separator' },
      {
        label: 'Снегопад',
        submenu: this.choice(settings, 'intensity', [
          ['light', 'Лёгкий'],
          ['steady', 'Ровный'],
          ['blizzard', 'Метель'],
          ['thaw', 'Оттепель — снег не идёт и тает'],
        ]),
      },
      {
        label: 'Ветер',
        submenu: this.choice(settings, 'wind', [
          ['calm', 'Штиль'],
          ['gusty', 'Порывистый'],
          ['left', 'Влево'],
          ['right', 'Вправо'],
        ]),
      },
      {
        label: 'Сугробы',
        submenu: [
          this.toggle(settings, 'drifts', 'Копить сугробы'),
          { type: 'separator' },
          ...this.choice(settings, 'pileSpeed', [
            ['slow', 'Растут медленно'],
            ['normal', 'Растут обычно'],
            ['fast', 'Растут быстро'],
          ]),
        ],
      },
      {
        label: 'Курсор',
        submenu: this.choice(settings, 'tool', [
          ['mitten', 'Варежка — смахивать снег'],
          ['shovel', 'Лопата — сгребать снег в кучу'],
          ['snowball', 'Снежки — катать шары, лепить и бросать'],
        ]),
      },
      {
        label: 'Украшения',
        submenu: [this.toggle(settings, 'frost', 'Иней по краям экрана'), this.toggle(settings, 'garland', 'Гирлянда')],
      },
      {
        label: 'Снегоуборочная машина',
        submenu: [
          this.toggle(settings, 'plow', 'Выезжает сама, когда намело'),
          { label: 'Вызвать сейчас', click: this.handlers.onPlow },
        ],
      },
      { label: 'Смести весь снег', click: this.handlers.onClear },
      { type: 'separator' },
      this.toggle(settings, 'hideInFullscreen', 'Скрывать в полноэкранном режиме'),
    ];

    if (openAtLogin !== null) {
      template.push({
        label: 'Запускать при входе в систему',
        type: 'checkbox',
        checked: openAtLogin,
        click: (item) => this.handlers.onOpenAtLogin(item.checked),
      });
    }

    template.push({ type: 'separator' }, { label: 'Выйти', click: this.handlers.onQuit });
    return Menu.buildFromTemplate(template);
  }

  private choice<K extends keyof SnowSettings>(
    settings: SnowSettings,
    key: K,
    options: Array<[SnowSettings[K], string]>,
  ): MenuItemConstructorOptions[] {
    return options.map(([value, label]) => ({
      label,
      type: 'radio',
      checked: settings[key] === value,
      click: () => this.handlers.onSettings({ [key]: value } as unknown as Partial<SnowSettings>),
    }));
  }

  private toggle(
    settings: SnowSettings,
    key: 'drifts' | 'frost' | 'garland' | 'plow' | 'hideInFullscreen',
    label: string,
  ): MenuItemConstructorOptions {
    return {
      label,
      type: 'checkbox',
      checked: settings[key],
      click: (item) => this.handlers.onSettings({ [key]: item.checked }),
    };
  }
}

export class SnowTray {
  private readonly tray: Tray;
  private readonly menu: TrayMenuBuilder;
  private readonly updateIcon = (): void => this.tray.setImage(SnowflakeIcon.current());

  constructor(handlers: TrayHandlers) {
    this.menu = new TrayMenuBuilder(handlers);
    this.tray = new Tray(SnowflakeIcon.current());
    this.tray.setToolTip('Snow');

    if (process.platform !== 'darwin') {
      this.tray.on('click', () => this.tray.popUpContextMenu());
    }

    nativeTheme.on('updated', this.updateIcon);
    this.refresh();
  }

  refresh(): void {
    this.tray.setContextMenu(this.menu.build());
  }

  destroy(): void {
    nativeTheme.off('updated', this.updateIcon);
    this.tray.destroy();
  }
}
