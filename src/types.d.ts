// Общие типы главного процесса и рендерера (глобальные, без import/export)

interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Окно другой программы; список приходит в порядке «от переднего к заднему» */
interface TrackedWindow extends ScreenRect {
  id: number;
}

/** Что сейчас на экране */
interface ScreenSnapshot {
  windows: TrackedWindow[];
  /** Границы Dock, если удалось узнать */
  dock: ScreenRect | null;
  /** Окна, которые существуют, но сейчас не видны: свёрнуты или на другом рабочем столе */
  hidden: number[];
  /** Набор окон меняется прямо сейчас (листают рабочие столы): список прежний, лишнюю работу не делаем */
  settling?: boolean;
}

/**
 * window — верхняя кромка окна; dock — верх Dock;
 * ground — низ экрана; ground-thin — тонкая полоска под Dock, когда его границы неизвестны
 */
type SnowSurfaceKind = 'window' | 'dock' | 'ground' | 'ground-thin';

/** Горизонтальная кромка, на которой копится снег. Координаты — в пикселях оверлея */
interface SnowSurface {
  id: string;
  kind: SnowSurfaceKind;
  x: number;
  y: number;
  width: number;
  /** Участки кромки, не закрытые другими окнами: [от, до] по X */
  visible: Array<[number, number]>;
}

/** Всё, что оверлею нужно знать об экране. Координаты — в пикселях оверлея */
interface SnowScene {
  surfaces: SnowSurface[];
  /** Кромки скрытых окон: их сугробы надо сохранить, а не обрушивать */
  keep: string[];
  /** Окна на этом мониторе — о них разбиваются снежки */
  windows: ScreenRect[];
  /** Высота меню-бара сверху: под ним висит гирлянда */
  topInset: number;
}

type SnowIntensity = 'light' | 'steady' | 'blizzard' | 'thaw';
type WindMode = 'calm' | 'gusty' | 'left' | 'right';
type PileSpeed = 'slow' | 'normal' | 'fast';
type SnowTool = 'mitten' | 'shovel' | 'snowball';

/** Настройки, которые меняются из меню в трее и сохраняются между запусками */
interface SnowSettings {
  intensity: SnowIntensity;
  wind: WindMode;
  drifts: boolean;
  pileSpeed: PileSpeed;
  tool: SnowTool;
  frost: boolean;
  garland: boolean;
  /** Снегоуборочная машина выезжает сама, когда внизу намело */
  plow: boolean;
  hideInFullscreen: boolean;
}

interface SnowBridge {
  onScene(callback: (scene: SnowScene) => void): void;
  onClearDrifts(callback: () => void): void;
  onSettings(callback: (settings: SnowSettings) => void): void;
  /** Ограничение частоты кадров; 0 — без ограничения */
  onFrameRate(callback: (fps: number) => void): void;
  /** Снег был на паузе столько секунд — пусть сугробы подтают */
  onMelt(callback: (seconds: number) => void): void;
  /** Вызвать снегоуборочную машину сейчас */
  onPlow(callback: () => void): void;
  /** Окну нужно ловить клики (курсор над снеговиком) или снова пропускать их сквозь себя */
  setInteractive(interactive: boolean): void;
}

interface Window {
  snowBridge?: SnowBridge;
}
