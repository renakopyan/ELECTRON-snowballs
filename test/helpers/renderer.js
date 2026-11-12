// Загружает собранный рендерер (dist/renderer/*.js) в песочницу с поддельным холстом,
// чтобы гонять анимацию снега в Node без браузера и Electron.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FILES = ['config', 'drift', 'snowballs', 'plow', 'decor', 'snow'];
const FRAME_MS = 1000 / 60;

/** Поддельный 2D-контекст: ничего не рисует, но падает на NaN в координатах */
function fakeContext(stats) {
  const finite = (name) => (...args) => {
    for (const value of args) {
      if (typeof value === 'number' && !Number.isFinite(value)) {
        throw new Error(`${name}: в координатах NaN или бесконечность (${args.join(', ')})`);
      }
    }
    stats[name] = (stats[name] || 0) + 1;
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
    arc(x, y, r, ...rest) {
      if (r < 0) throw new Error(`arc: отрицательный радиус ${r}`);
      finite('arc')(x, y, r, ...rest);
    },
    ellipse: finite('ellipse'),
    fill: finite('fill'),
    stroke: finite('stroke'),
    drawImage: (image, ...args) => finite('drawImage')(...args),
    createLinearGradient: (...args) => (finite('createLinearGradient')(...args), gradient),
    createRadialGradient: (...args) => (finite('createRadialGradient')(...args), gradient),
  };
}

function loadRenderer({ width = 1440, height = 900 } = {}) {
  const stats = {};
  const ctx = fakeContext(stats);
  const listeners = {};
  const bridge = { interactive: [] };
  let frameCallback = null;
  let now = 0;

  class HTMLCanvasElement {
    constructor() {
      this.style = {};
      this.width = 0;
      this.height = 0;
    }
    getContext() {
      return ctx;
    }
  }

  const window = {
    innerWidth: width,
    innerHeight: height,
    devicePixelRatio: 2,
    addEventListener: (name, listener) => {
      listeners[name] = listener;
    },
    snowBridge: {
      onScene: (cb) => (bridge.scene = cb),
      onClearDrifts: (cb) => (bridge.clear = cb),
      onSettings: (cb) => (bridge.settings = cb),
      onFrameRate: (cb) => (bridge.frameRate = cb),
      onMelt: (cb) => (bridge.melt = cb),
      onPlow: (cb) => (bridge.plow = cb),
      setInteractive: (value) => bridge.interactive.push(value),
    },
  };
  const mainCanvas = new HTMLCanvasElement();
  const document = {
    getElementById: () => mainCanvas,
    createElement: () => new HTMLCanvasElement(),
  };

  const context = vm.createContext({
    window,
    document,
    HTMLCanvasElement,
    requestAnimationFrame: (cb) => {
      frameCallback = cb;
    },
    console,
  });
  const dist = path.join(__dirname, '..', '..', 'dist', 'renderer');
  const code =
    FILES.map((file) => fs.readFileSync(path.join(dist, `${file}.js`), 'utf8')).join('\n') +
    '\n;globalThis.__snowfall = snowfall;';
  vm.runInContext(code, context, { filename: 'renderer.js' });

  const frame = () => {
    now += FRAME_MS;
    frameCallback(now);
  };

  return {
    snowfall: context.__snowfall,
    bridge,
    stats,
    /** Прогнать анимацию на seconds секунд при 60 кадрах в секунду */
    run(seconds) {
      for (let i = 0; i < Math.round(seconds * 60); i++) frame();
    },
    /** Нажать левую кнопку мыши в точке */
    click(x, y) {
      listeners.mousedown({ clientX: x, clientY: y, button: 0 });
      frame();
    },
    /** Поставить курсор в точку и прогнать один кадр */
    pointer(x, y) {
      listeners.mousemove({ clientX: x, clientY: y });
      frame();
    },
    /** Провести курсором по горизонтали на высоте y, по кадру на шаг */
    drag(fromX, toX, y, step = 4) {
      const direction = Math.sign(toX - fromX) || 1;
      for (let x = fromX; (toX - x) * direction >= 0; x += direction * Math.abs(step)) {
        listeners.mousemove({ clientX: x, clientY: y });
        frame();
      }
    },
  };
}

/** Сцена: два окна друг под другом и земля */
function twoWindowsScene(extra = {}) {
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

const SETTINGS = {
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

module.exports = { loadRenderer, twoWindowsScene, SETTINGS };
