// ===== Настройки снега =====
// То, что переключается из меню в трее (снегопад, ветер, скорость сугробов),
// описано ниже в таблицах INTENSITY, WIND и PILE_RATE.
interface SnowConfig {
  minR: number; // минимальный радиус снежинки
  maxR: number; // максимальный радиус снежинки
  sway: number; // амплитуда покачивания
  opacity: number; // прозрачность ближних снежинок (дальние — бледнее)
  starDepth: number; // снежинки ближе этой глубины (0..1) рисуются звёздочками, дальние — точками

  landChance: number; // доля снежинок, которые ложатся в сугроб (0..1), остальные пролетают мимо
  windowDriftHeight: number; // предельная высота сугроба на окне и на Dock, px
  groundDriftHeight: number; // предельная высота сугроба внизу экрана, px
  meltPerSecond: number; // насколько оседает сугроб за секунду оттепели или паузы, px

  sweepRadius: number; // размер «варежки»: радиус, в котором курсор сметает снег, px
  shovelRadius: number; // ширина захвата лопаты, px
  maxBallRadius: number; // до какого размера можно скатать снежный шар, px
  throwSpeed: number; // с какой скорости курсора шар не катится, а летит (px за кадр)
}

const CONFIG: SnowConfig = {
  minR: 1.0,
  maxR: 4.2,
  sway: 1.2,
  opacity: 0.95,
  starDepth: 0.72,

  landChance: 0.85,
  windowDriftHeight: 26,
  groundDriftHeight: 60,
  meltPerSecond: 0.3,

  sweepRadius: 24,
  shovelRadius: 40,
  maxBallRadius: 30,
  throwSpeed: 16,
};

/** Снегопад: сколько снежинок, как быстро падают, во сколько раз усилен ветер и сколько инея */
const INTENSITY: Record<SnowIntensity, { count: number; fallSpeed: number; windScale: number; frost: number }> = {
  light: { count: 110, fallSpeed: 0.8, windScale: 0.8, frost: 0.15 },
  steady: { count: 240, fallSpeed: 1.0, windScale: 1.0, frost: 0.35 },
  blizzard: { count: 560, fallSpeed: 1.5, windScale: 2.2, frost: 0.9 },
  thaw: { count: 0, fallSpeed: 1.0, windScale: 0.6, frost: 0 },
};

/** Ветер: постоянная часть и сила порывов (px за кадр; минус — влево) */
const WIND: Record<WindMode, { base: number; gust: number }> = {
  calm: { base: 0, gust: 0.12 },
  gusty: { base: 0.2, gust: 1.3 },
  left: { base: -0.7, gust: 0.3 },
  right: { base: 0.7, gust: 0.3 },
};

/** Скорость роста сугробов */
const PILE_RATE: Record<PileSpeed, number> = { slow: 1.5, normal: 4, fast: 10 };

/** С какой силы ветер начинает сдувать верхушки сугробов */
const EROSION_WIND = 1.6;

/** Цвета лампочек гирлянды */
const GARLAND_COLORS = ['#ff4d4d', '#ffcc33', '#4dd96b', '#4da6ff', '#ff6ec7'];
// ===============================================================

/** Настройки до того, как главный процесс пришлёт сохранённые */
const INITIAL_SETTINGS: SnowSettings = {
  intensity: 'steady',
  wind: 'gusty',
  drifts: true,
  pileSpeed: 'normal',
  tool: 'mitten',
  frost: true,
  garland: false,
  plow: true,
  hideInFullscreen: true,
};

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Вспомогательный холст для заранее нарисованных картинок (снежинки, иней, свечение) */
function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}
