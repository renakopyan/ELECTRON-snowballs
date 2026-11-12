// Разбор строк, которые печатают помощники слежения за окнами. Без Electron — покрыт тестами.

export const identity = (rect: ScreenRect): ScreenRect => rect;

function isNumberRow(row: unknown, length: number): row is number[] {
  return Array.isArray(row) && row.length === length && row.every(Number.isFinite);
}

/**
 * Строка вида {"w":[[id,x,y,width,height],...],"d":[x,y,width,height]|null,"h":[id,...],"s":1}; s — набор окон сейчас меняется.
 * Битые строки и строки неизвестного формата дают null.
 */
export function parseSnapshot(line: string, toDip: (rect: ScreenRect) => ScreenRect = identity): ScreenSnapshot | null {
  try {
    const data: unknown = JSON.parse(line);
    if (typeof data !== 'object' || data === null) return null;
    const { w, d, h, s } = data as { w?: unknown; d?: unknown; h?: unknown; s?: unknown };
    if (!Array.isArray(w)) return null;

    const windows = w
      .filter((row): row is number[] => isNumberRow(row, 5))
      .map(([id, x, y, width, height]) => ({ id, ...toDip({ x, y, width, height }) }));
    const dock = isNumberRow(d, 4) ? toDip({ x: d[0], y: d[1], width: d[2], height: d[3] }) : null;
    const hidden = Array.isArray(h) ? h.filter((id): id is number => Number.isFinite(id)) : [];
    return s === 1 ? { windows, dock, hidden, settling: true } : { windows, dock, hidden };
  } catch {
    return null;
  }
}
