// Загружает собранный рендерер (скомпилированные src/renderer/*.ts) в песочницу с поддельным холстом,
// чтобы гонять анимацию снега в Node без браузера и Electron.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const FILES = ['config', 'drift', 'snowballs', 'plow', 'decor', 'snow'];
const FRAME_MS = 1000 / 60;

// Поля рендерера приватны, а тестам нужно смотреть внутрь. Здесь — только то, что тесты читают
// и меняют; если рендерер переименует поле, тест упадёт на этих интерфейсах, а не молча.

export interface DriftProbe {
  volume: number;
  left: number;
  heights: ArrayLike<number>;
  deposit(x: number, area: number): void;
}

export interface PileProbe {
  driftId: string;
  offset: number;
  areas: number[];
  poke?: { kind: string };
}

export interface SnowballsProbe {
  pileCount: number;
  flyingCount: number;
  splatCount: number;
  pokeCount: number;
  volume: number;
  nextPoke: number;
  piles: PileProbe[];
}

export interface SnowfallProbe {
  drifts: Map<string, DriftProbe>;
  dormant: Map<string, DriftProbe>;
  flakes: unknown[];
  particles: unknown[];
  snowballs: SnowballsProbe;
  frost: { value: number };
  plow: { running: boolean };
  config: { meltPerSecond: number };
  draw(time: number): void;
}

/** Колбэки, которые страница зарегистрировала в мосте; тест вызывает их, как главный процесс */
export interface BridgeHandles {
  scene: (scene: SnowScene) => void;
  clear: () => void;
  settings: (settings: SnowSettings) => void;
  frameRate: (fps: number) => void;
  melt: (seconds: number) => void;
  plow: () => void;
  /** Всё, что страница передала в setInteractive, по порядку */
  interactive: boolean[];
}

export interface Renderer {
  snowfall: SnowfallProbe;
  bridge: BridgeHandles;
  /** Сколько раз вызван каждый метод контекста холста */
  stats: Record<string, number>;
  /** Прогнать анимацию на seconds секунд при 60 кадрах в секунду */
  run(seconds: number): void;
  /** Нажать левую кнопку мыши в точке */
  click(x: number, y: number): void;
  /** Поставить курсор в точку и прогнать один кадр */
  pointer(x: number, y: number): void;
  /** Провести курсором по горизонтали на высоте y, по кадру на шаг */
  drag(fromX: number, toX: number, y: number, step?: number): void;
}

interface FakeMouseEvent {
  clientX: number;
  clientY: number;
  button?: number;
}

type Listener = (event: FakeMouseEvent) => void;

/** Поддельный 2D-контекст: ничего не рисует, но падает на NaN в координатах */
function fakeContext(stats: Record<string, number>): Record<string, unknown> {
  const finite =
    (name: string) =>
    (...args: unknown[]): void => {
      for (const value of args) {
        if (typeof value === 'number' && !Number.isFinite(value)) {
          throw new Error(`${name}: в координатах NaN или бесконечность (${args.join(', ')})`);
        }
      }
      stats[name] = (stats[name] ?? 0) + 1;
    };
  const gradient = { addColorStop: finite('addColorStop') };
  return {
    globalAlpha: 1,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    save: finite('save'),
    restore: finite('restore'),
    rotate: finite('rotate'),
    scale: finite('scale'),
    setTransform: finite('setTransform'),
    translate: finite('translate'),
    clearRect: finite('clearRect'),
    fillRect: finite('fillRect'),
    beginPath: finite('beginPath'),
    closePath: finite('closePath'),
    moveTo: finite('moveTo'),
    lineTo: finite('lineTo'),
    quadraticCurveTo: finite('quadraticCurveTo'),
    arc(x: number, y: number, r: number, ...rest: unknown[]): void {
      if (r < 0) throw new Error(`arc: отрицательный радиус ${r}`);
      finite('arc')(x, y, r, ...rest);
    },
    ellipse: finite('ellipse'),
    fill: finite('fill'),
    stroke: finite('stroke'),
    drawImage: (_image: unknown, ...args: unknown[]): void => finite('drawImage')(...args),
    createLinearGradient: (...args: unknown[]) => {
      finite('createLinearGradient')(...args);
      return gradient;
    },
    createRadialGradient: (...args: unknown[]) => {
      finite('createRadialGradient')(...args);
      return gradient;
    },
  };
}

export function loadRenderer({ width = 1440, height = 900 }: { width?: number; height?: number } = {}): Renderer {
  const stats: Record<string, number> = {};
  const ctx = fakeContext(stats);
  const listeners: Partial<Record<'mousedown' | 'mousemove', Listener>> = {};
  const noop = (): void => {};
  const bridge: BridgeHandles = {
    scene: noop,
    clear: noop,
    settings: noop,
    frameRate: noop,
    melt: noop,
    plow: noop,
    interactive: [],
  };
  let frameCallback: ((time: number) => void) | null = null;
  let now = 0;

  class FakeCanvas {
    style: Record<string, string> = {};
    width = 0;
    height = 0;
    getContext(): Record<string, unknown> {
      return ctx;
    }
  }

  const window = {
    innerWidth: width,
    innerHeight: height,
    devicePixelRatio: 2,
    addEventListener: (name: 'mousedown' | 'mousemove', listener: Listener): void => {
      listeners[name] = listener;
    },
    snowBridge: {
      onScene: (cb: BridgeHandles['scene']): void => {
        bridge.scene = cb;
      },
      onClearDrifts: (cb: BridgeHandles['clear']): void => {
        bridge.clear = cb;
      },
      onSettings: (cb: BridgeHandles['settings']): void => {
        bridge.settings = cb;
      },
      onFrameRate: (cb: BridgeHandles['frameRate']): void => {
        bridge.frameRate = cb;
      },
      onMelt: (cb: BridgeHandles['melt']): void => {
        bridge.melt = cb;
      },
      onPlow: (cb: BridgeHandles['plow']): void => {
        bridge.plow = cb;
      },
      setInteractive: (value: boolean): void => {
        bridge.interactive.push(value);
      },
    },
  };
  const mainCanvas = new FakeCanvas();
  const document = {
    getElementById: () => mainCanvas,
    createElement: () => new FakeCanvas(),
  };

  const context = vm.createContext({
    window,
    document,
    HTMLCanvasElement: FakeCanvas,
    requestAnimationFrame: (cb: (time: number) => void): void => {
      frameCallback = cb;
    },
    console,
  });

  // Тесты компилируются вместе с src в dist-test: dist-test/test/helpers → dist-test/src/renderer
  const compiled = path.join(__dirname, '..', '..', 'src', 'renderer');
  const code =
    FILES.map((file) => fs.readFileSync(path.join(compiled, `${file}.js`), 'utf8')).join('\n') +
    '\n;globalThis.__snowfall = snowfall;';
  vm.runInContext(code, context, { filename: 'renderer.js' });

  const frame = (): void => {
    if (!frameCallback) throw new Error('рендерер не запросил кадр через requestAnimationFrame');
    now += FRAME_MS;
    frameCallback(now);
  };
  const fire = (name: 'mousedown' | 'mousemove', event: FakeMouseEvent): void => {
    const listener = listeners[name];
    if (!listener) throw new Error(`рендерер не подписался на ${name}`);
    listener(event);
  };

  return {
    snowfall: context.__snowfall as SnowfallProbe,
    bridge,
    stats,
    run(seconds) {
      for (let i = 0; i < Math.round(seconds * 60); i++) frame();
    },
    click(x, y) {
      fire('mousedown', { clientX: x, clientY: y, button: 0 });
      frame();
    },
    pointer(x, y) {
      fire('mousemove', { clientX: x, clientY: y });
      frame();
    },
    drag(fromX, toX, y, step = 4) {
      const direction = Math.sign(toX - fromX) || 1;
      for (let x = fromX; (toX - x) * direction >= 0; x += direction * Math.abs(step)) {
        fire('mousemove', { clientX: x, clientY: y });
        frame();
      }
    },
  };
}

/** Сцена: два окна друг под другом и земля */
export function twoWindowsScene(extra: Partial<SnowScene> = {}): SnowScene {
  return {
    surfaces: [
      { id: 'window-1', kind: 'window', x: 308, y: 200, width: 384, visible: [[308, 692]] },
      { id: 'window-2', kind: 'window', x: 108, y: 500, width: 784, visible: [[108, 892]] },
      { id: 'ground', kind: 'ground', x: 0, y: 900, width: 1440, visible: [[0, 1440]] },
    ],
    keep: [],
    windows: [
      { x: 300, y: 200, width: 400, height: 250 },
      { x: 100, y: 500, width: 800, height: 300 },
    ],
    topInset: 25,
    ...extra,
  };
}

export const SETTINGS: SnowSettings = {
  intensity: 'steady',
  wind: 'calm',
  drifts: true,
  pileSpeed: 'normal',
  tool: 'mitten',
  frost: true,
  garland: false,
  plow: false, // в тестах машина выезжает только по вызову, чтобы не убирать снег посреди проверок
  hideInFullscreen: true,
};
