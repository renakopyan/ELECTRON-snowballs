// Сугроб на одной кромке (верх окна, Dock или низ экрана).
// Хранится как карта высот: по одному значению на столбик шириной DRIFT_COLUMN.

const DRIFT_COLUMN = 3; // ширина столбика, px
const DRIFT_MAX_SLOPE = 2.4; // максимальный перепад высот соседних столбиков, px
const DRIFT_RELAX_FRAMES = 12; // сколько кадров снег «осыпается» после изменения
const THIN_GROUND_HEIGHT = 12; // полоска под Dock на macOS
const SHAKE_STEP = 5; // на сколько столбиков приходится один комок при встряске
const COLLAPSE_STEP = 4; // на сколько столбиков приходится один комок при обрушении

/** Кусок снега, отделившийся от сугроба */
interface SnowChunk {
  x: number;
  y: number;
  area: number;
}

class Drift {
  private heights: Float32Array;
  private relaxFrames = 0;
  // Случайные фазы «волн», чтобы у каждого сугроба был свой неровный верх
  private readonly wavePhases = [rand(0, Math.PI * 2), rand(0, Math.PI * 2)];

  constructor(
    private surface: SnowSurface,
    private readonly config: SnowConfig,
  ) {
    this.heights = new Float32Array(Drift.columnCount(surface));
  }

  private static columnCount(surface: SnowSurface): number {
    return Math.max(1, Math.ceil(surface.width / DRIFT_COLUMN));
  }

  private get maxHeight(): number {
    switch (this.surface.kind) {
      case 'window':
      case 'dock':
        return this.config.windowDriftHeight;
      case 'ground':
        return this.config.groundDriftHeight;
      case 'ground-thin':
        return Math.min(THIN_GROUND_HEIGHT, this.config.groundDriftHeight);
    }
  }

  /** Предел высоты в столбике: плавно гуляет от 70 до 100 % максимума, иначе верх выйдет плоским */
  private capAt(column: number): number {
    const [a, b] = this.wavePhases;
    const wave = 0.6 * Math.sin(column * 0.07 + a) + 0.4 * Math.sin(column * 0.23 + b);
    return this.maxHeight * (0.85 + 0.15 * wave);
  }

  private columnAt(x: number): number {
    return Math.floor((x - this.surface.x) / DRIFT_COLUMN);
  }

  get id(): string {
    return this.surface.id;
  }

  /** На тонкой полоске под Dock шары не катаем: они закрыли бы его значки */
  get allowsSnowballs(): boolean {
    return this.surface.kind !== 'ground-thin';
  }

  /** Y кромки, на которой лежит снег */
  get top(): number {
    return this.surface.y;
  }

  get left(): number {
    return this.surface.x;
  }

  get right(): number {
    return this.surface.x + this.surface.width;
  }

  /** Сколько всего снега лежит на кромке, px² */
  get volume(): number {
    let sum = 0;
    for (const height of this.heights) sum += height;
    return sum * DRIFT_COLUMN;
  }

  /** Насколько заполнена видимая часть кромки: средняя высота снега от предельной, 0..1 */
  get fill(): number {
    let sum = 0;
    let count = 0;
    for (const [from, to] of this.surface.visible) {
      const first = Math.max(0, this.columnAt(from));
      const last = Math.min(this.heights.length - 1, this.columnAt(to - 0.01));
      for (let i = first; i <= last; i++, count++) sum += this.heights[i];
    }
    return count === 0 ? 0 : clamp(sum / count / this.maxHeight, 0, 1);
  }

  isVisibleAt(x: number): boolean {
    return this.surface.visible.some(([from, to]) => x >= from && x < to);
  }

  /** Кромка подвинулась или изменила размер — сугроб едет вместе с ней */
  setSurface(surface: SnowSurface): void {
    const count = Drift.columnCount(surface);
    if (count !== this.heights.length) {
      const resized = new Float32Array(count);
      resized.set(this.heights.subarray(0, Math.min(count, this.heights.length)));
      this.heights = resized;
      this.relaxFrames = DRIFT_RELAX_FRAMES;
    }
    this.surface = surface;
  }

  clear(): void {
    this.heights.fill(0);
  }

  /** Y верхушки снега в точке x; null, если сюда снег лечь не может */
  landingY(x: number): number | null {
    if (!this.isVisibleAt(x)) return null;
    const column = this.columnAt(x);
    const height = this.heights[column];
    if (height === undefined || height >= this.capAt(column)) return null;
    return this.surface.y - height;
  }

  /** Y верхушки снега в точке x, даже если сугроб полный; null — мимо кромки */
  surfaceY(x: number): number | null {
    if (!this.isVisibleAt(x)) return null;
    const height = this.heights[this.columnAt(x)];
    return height === undefined ? null : this.surface.y - height;
  }

  /**
   * Добавляет снег площадью area (px²) вокруг точки x; чем больше снега, тем шире он ложится.
   * limitScale поднимает предел высоты (лопата наваливает кучу выше обычного сугроба).
   * Возвращает площадь снега, который не поместился или упал мимо края.
   */
  deposit(x: number, area: number, limitScale = 1): number {
    const center = this.columnAt(x);
    const reach = clamp(Math.round(Math.sqrt(area) / DRIFT_COLUMN), 2, 14);
    const weightSum = (reach + 1) * (reach + 1); // сумма «треугольных» весов
    const max = this.maxHeight * limitScale;
    let overflow = 0;

    for (let offset = -reach; offset <= reach; offset++) {
      const i = center + offset;
      const added = (area * (reach + 1 - Math.abs(offset))) / weightSum / DRIFT_COLUMN;
      if (i < 0 || i >= this.heights.length) {
        overflow += added * DRIFT_COLUMN; // мимо края — снег упал вниз
        continue;
      }
      const next = Math.min(Math.max(max, this.heights[i]), this.heights[i] + added);
      overflow += (this.heights[i] + added - next) * DRIFT_COLUMN;
      this.heights[i] = next;
    }
    this.relaxFrames = DRIFT_RELAX_FRAMES;
    return overflow;
  }

  /** Лопата: забирает весь снег со столбиков между from и to (по X) */
  scoop(from: number, to: number): SnowChunk | null {
    const first = Math.max(0, this.columnAt(Math.min(from, to)));
    const last = Math.min(this.heights.length - 1, this.columnAt(Math.max(from, to)));
    let area = 0;
    let top = this.surface.y;
    for (let i = first; i <= last; i++) {
      if (!this.isVisibleAt(this.surface.x + (i + 0.5) * DRIFT_COLUMN)) continue;
      top = Math.min(top, this.surface.y - this.heights[i]);
      area += this.heights[i] * DRIFT_COLUMN;
      this.heights[i] = 0;
    }
    if (area === 0) return null;
    this.relaxFrames = DRIFT_RELAX_FRAMES;
    return { area, x: (from + to) / 2, y: top };
  }

  /**
   * Лопата: снег ложится кучей прямо перед лопатой. Куча — конус с вершиной
   * maxHeight × limitScale у лопаты и склоном вперёд по ходу.
   * Возвращает площадь снега, которая в кучу не поместилась (ссыпается вниз).
   */
  pushAhead(x: number, area: number, direction: number, limitScale: number): number {
    const peak = this.maxHeight * limitScale;
    const start = this.columnAt(x);
    let left = area;
    for (let k = 0; left > 0; k++) {
      const i = start + k * direction;
      const cap = peak - k * DRIFT_MAX_SLOPE * 0.9;
      if (cap <= 0 || i < 0 || i >= this.heights.length) break;
      const taken = Math.min(Math.max(0, cap - this.heights[i]) * DRIFT_COLUMN, left);
      this.heights[i] += taken / DRIFT_COLUMN;
      left -= taken;
    }
    this.relaxFrames = DRIFT_RELAX_FRAMES;
    return left;
  }

  /** Сильный ветер срывает немного снега со случайной верхушки */
  erode(): SnowChunk | null {
    const [from, to] = this.surface.visible[Math.floor(Math.random() * this.surface.visible.length)] ?? [0, 0];
    const x = rand(from, to);
    const i = this.columnAt(x);
    const height = this.heights[i];
    if (height === undefined || height < 4) return null;

    const taken = Math.min(1.2, height * 0.2);
    this.heights[i] = height - taken;
    this.relaxFrames = DRIFT_RELAX_FRAMES;
    return { x, y: this.surface.y - height, area: taken * DRIFT_COLUMN };
  }

  /** Тает: каждый столбик оседает на dh пикселей */
  melt(dh: number): void {
    if (dh <= 0) return;
    for (let i = 0; i < this.heights.length; i++) {
      if (this.heights[i] > 0) this.heights[i] = Math.max(0, this.heights[i] - dh);
    }
    this.relaxFrames = DRIFT_RELAX_FRAMES;
  }

  /**
   * Окно резко дёрнули: с него слетает доля fraction снега (0..1).
   * Возвращает комки, которые теперь падают.
   */
  shake(fraction: number): SnowChunk[] {
    const chunks: SnowChunk[] = [];
    const keep = 1 - clamp(fraction, 0, 1);
    for (const [from, to] of this.surface.visible) {
      const first = Math.max(0, this.columnAt(from));
      const last = Math.min(this.heights.length - 1, this.columnAt(to - 0.01));
      for (let i = first; i <= last; i += SHAKE_STEP) {
        let sum = 0;
        let count = 0;
        for (let j = i; j < i + SHAKE_STEP && j <= last; j++, count++) {
          sum += this.heights[j];
          this.heights[j] *= keep;
        }
        const area = sum * (1 - keep) * DRIFT_COLUMN;
        if (area < 2) continue;
        chunks.push({
          x: this.surface.x + (i + count / 2) * DRIFT_COLUMN,
          y: this.surface.y - sum / count,
          area,
        });
      }
    }
    this.relaxFrames = DRIFT_RELAX_FRAMES;
    return chunks;
  }

  /** Кромка исчезла (окно закрыли) — весь видимый снег превращается в падающие комки */
  collapse(): SnowChunk[] {
    const chunks: SnowChunk[] = [];
    for (const [from, to] of this.surface.visible) {
      const first = Math.max(0, this.columnAt(from));
      const last = Math.min(this.heights.length - 1, this.columnAt(to - 0.01));
      for (let i = first; i <= last; i += COLLAPSE_STEP) {
        let sum = 0;
        let count = 0;
        for (let j = i; j < i + COLLAPSE_STEP && j <= last; j++, count++) sum += this.heights[j];
        if (sum < 1) continue;
        chunks.push({
          x: this.surface.x + (i + count / 2) * DRIFT_COLUMN,
          y: this.surface.y - sum / count / 2,
          area: sum * DRIFT_COLUMN,
        });
      }
    }
    this.heights.fill(0);
    return chunks;
  }

  /**
   * Сметает снег кругом радиуса radius с центром в (cx, cy).
   * Возвращает площадь убранного снега и точку, откуда он слетел.
   */
  sweep(cx: number, cy: number, radius: number): SnowChunk | null {
    const { y } = this.surface;
    if (cy - radius > y || !this.isVisibleAt(cx)) return null;

    const first = Math.max(0, this.columnAt(cx - radius));
    const last = Math.min(this.heights.length - 1, this.columnAt(cx + radius));
    let area = 0;
    let top = y;

    for (let i = first; i <= last; i++) {
      const dx = this.surface.x + (i + 0.5) * DRIFT_COLUMN - cx;
      if (Math.abs(dx) >= radius) continue;
      // Всё, что выше нижней границы круга, считаем сметённым
      const keep = Math.max(0, y - cy - Math.sqrt(radius * radius - dx * dx));
      const height = this.heights[i];
      if (height <= keep) continue;
      top = Math.min(top, y - height);
      area += (height - keep) * DRIFT_COLUMN;
      this.heights[i] = keep;
    }

    if (area === 0) return null;
    this.relaxFrames = DRIFT_RELAX_FRAMES;
    return { area, x: cx, y: top };
  }

  /** Осыпание: слишком крутые склоны сглаживаются, с краёв кромки снег падает */
  update(): void {
    if (this.relaxFrames <= 0) return;
    this.relaxFrames--;

    const h = this.heights;
    const last = h.length - 1;
    const settle = (i: number, j: number): void => {
      const excess = h[i] - h[j] - DRIFT_MAX_SLOPE;
      if (excess > 0) {
        h[i] -= excess / 2;
        h[j] += excess / 2;
      }
    };
    for (let i = 0; i < last; i++) {
      settle(i, i + 1);
      settle(i + 1, i);
    }
    for (let i = last; i > 0; i--) {
      settle(i, i - 1);
      settle(i - 1, i);
    }

    if (h[0] > DRIFT_MAX_SLOPE) h[0] -= (h[0] - DRIFT_MAX_SLOPE) / 2;
    if (h[last] > DRIFT_MAX_SLOPE) h[last] -= (h[last] - DRIFT_MAX_SLOPE) / 2;
  }

  draw(ctx: CanvasRenderingContext2D): void {
    const { x, y, visible } = this.surface;
    const h = this.heights;

    for (const [from, to] of visible) {
      const first = Math.max(0, this.columnAt(from));
      const last = Math.min(h.length - 1, this.columnAt(to - 0.01));
      if (last < first) continue;

      let tallest = 0;
      for (let i = first; i <= last; i++) tallest = Math.max(tallest, h[i]);
      if (tallest < 0.5) continue;

      // Лёгкая голубая тень у основания придаёт сугробу объём
      const fill = ctx.createLinearGradient(0, y - tallest, 0, y);
      fill.addColorStop(0, 'rgba(255, 255, 255, 0.97)');
      fill.addColorStop(1, 'rgba(222, 232, 245, 0.97)');
      ctx.fillStyle = fill;

      ctx.beginPath();
      ctx.moveTo(from, y);
      ctx.lineTo(from, y - h[first]);
      for (let i = first; i < last; i++) {
        const px = x + (i + 0.5) * DRIFT_COLUMN;
        const py = y - h[i];
        const nextX = px + DRIFT_COLUMN;
        const nextY = y - h[i + 1];
        ctx.quadraticCurveTo(px, py, (px + nextX) / 2, (py + nextY) / 2);
      }
      ctx.lineTo(to, y - h[last]);
      ctx.lineTo(to, y);
      ctx.closePath();
      ctx.fill();
    }
  }
}
