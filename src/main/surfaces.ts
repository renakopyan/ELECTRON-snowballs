// Расчёт кромок, на которые может лечь снег. Чистые функции без Electron — покрыты тестами.

type Range = [number, number];

const CORNER_INSET = 8; // не кладём снег на скруглённые углы окна
const MIN_WINDOW_WIDTH = 120; // мелкие служебные окна пропускаем
const MIN_WINDOW_HEIGHT = 60;
const MIN_VISIBLE_WIDTH = 10; // слишком узкие просветы между окнами не считаем
const TOP_MARGIN = 24; // окно под самым верхом экрана: сугробу негде лежать
const DOCK_INSET = 12; // скруглённые края Dock
const DOCK_GAP = 6; // зазор между Dock и сугробом на «земле»

function subtract(ranges: Range[], cut: Range): Range[] {
  const result: Range[] = [];
  for (const [from, to] of ranges) {
    if (cut[1] <= from || cut[0] >= to) {
      result.push([from, to]);
      continue;
    }
    if (cut[0] > from) result.push([from, cut[0]]);
    if (cut[1] < to) result.push([cut[1], to]);
  }
  return result;
}

/** Закрывает ли окно точку прямо над линией y */
function coversLine(win: ScreenRect, y: number): boolean {
  return win.y < y && y <= win.y + win.height;
}

function intersects(a: ScreenRect, b: ScreenRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Есть ли на мониторе окно во весь экран (полноэкранное видео, игра, презентация) */
export function isCoveredByFullscreenWindow(bounds: ScreenRect, windows: ScreenRect[]): boolean {
  return windows.some(
    (win) =>
      win.x <= bounds.x &&
      win.y <= bounds.y &&
      win.x + win.width >= bounds.x + bounds.width &&
      win.y + win.height >= bounds.y + bounds.height,
  );
}

/**
 * Считает, где на мониторе может лежать снег: верхние кромки окон
 * (за вычетом участков, закрытых окнами спереди), Dock и «земля» внизу экрана.
 * Окна передаются в порядке от переднего к заднему, в экранных координатах.
 */
export function computeSurfaces(
  bounds: ScreenRect,
  workArea: ScreenRect,
  { windows, dock }: Pick<ScreenSnapshot, 'windows' | 'dock'>,
  platform: string,
): SnowSurface[] {
  const left = bounds.x;
  const right = bounds.x + bounds.width;
  const bottom = bounds.y + bounds.height;

  const visibleRanges = (from: number, to: number, y: number, inFront: ScreenRect[]): Range[] => {
    let ranges: Range[] = [[Math.max(from, left), Math.min(to, right)]];
    for (const win of inFront) {
      if (coversLine(win, y)) ranges = subtract(ranges, [win.x, win.x + win.width]);
    }
    return ranges.filter(([a, b]) => b - a >= MIN_VISIBLE_WIDTH).map(([a, b]): Range => [a - left, b - left]);
  };

  const surfaces: SnowSurface[] = [];

  windows.forEach((win, index) => {
    if (win.width < MIN_WINDOW_WIDTH || win.height < MIN_WINDOW_HEIGHT) return;
    if (win.y < workArea.y + TOP_MARGIN || win.y >= bottom) return;
    if (win.x + win.width <= left || win.x >= right) return;

    const from = win.x + CORNER_INSET;
    const to = win.x + win.width - CORNER_INSET;
    surfaces.push({
      id: `window-${win.id}`,
      kind: 'window',
      x: from - left,
      y: win.y - bounds.y,
      width: to - from,
      // Полностью закрытое окно тоже отдаём (с пустым списком), чтобы его сугроб не пропал
      visible: visibleRanges(from, to, win.y, windows.slice(0, index)),
    });
  });

  const workBottom = workArea.y + workArea.height;
  const barAtBottom = workBottom < bottom;
  const toLocal = ([a, b]: Range): Range => [a - left, b - left];

  // Панель задач Windows идёт во всю ширину — снег ложится прямо на неё
  if (barAtBottom && platform !== 'darwin') {
    surfaces.push({
      id: 'ground',
      kind: 'ground',
      x: 0,
      y: workBottom - bounds.y,
      width: bounds.width,
      visible: visibleRanges(left, right, workBottom, windows),
    });
    return surfaces;
  }

  // Dock на macOS уже экрана. Если его границы известны — кладём сугроб на него,
  // а «землю» по бокам; если нет — оставляем под ним только тонкую полоску.
  const dockHere =
    barAtBottom &&
    dock !== null &&
    dock.y > bounds.y + bounds.height / 2 &&
    dock.y < bottom &&
    dock.x >= left &&
    dock.x + dock.width <= right &&
    dock.width > 2 * DOCK_INSET + MIN_VISIBLE_WIDTH;

  let ground = visibleRanges(left, right, bottom, windows);
  if (dockHere && dock) {
    const from = dock.x + DOCK_INSET;
    const to = dock.x + dock.width - DOCK_INSET;
    surfaces.push({
      id: 'dock',
      kind: 'dock',
      x: from - left,
      y: dock.y - bounds.y,
      width: to - from,
      visible: visibleRanges(from, to, dock.y, windows),
    });
    ground = subtract(ground, toLocal([dock.x - DOCK_GAP, dock.x + dock.width + DOCK_GAP]));
  }

  surfaces.push({
    id: 'ground',
    kind: barAtBottom && !dockHere ? 'ground-thin' : 'ground',
    x: 0,
    y: bounds.height,
    width: bounds.width,
    visible: ground.filter(([a, b]) => b - a >= MIN_VISIBLE_WIDTH),
  });

  return surfaces;
}

/** Всё, что оверлей одного монитора должен знать об экране */
export function computeScene(
  bounds: ScreenRect,
  workArea: ScreenRect,
  snapshot: ScreenSnapshot,
  platform: string,
): SnowScene {
  return {
    surfaces: computeSurfaces(bounds, workArea, snapshot, platform),
    keep: snapshot.hidden.map((id) => `window-${id}`),
    windows: snapshot.windows
      .filter((win) => intersects(win, bounds))
      .map((win) => ({ x: win.x - bounds.x, y: win.y - bounds.y, width: win.width, height: win.height })),
    topInset: Math.max(0, workArea.y - bounds.y),
  };
}
