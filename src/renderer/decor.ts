// Украшения: снежинки-звёздочки, иней по краям экрана и гирлянда.
// Всё сложное рисуется один раз на вспомогательных холстах, а в каждом кадре
// только копируется — так украшения почти ничего не стоят.

const STAR_SPRITE_SIZE = 64;
const STAR_VARIANTS = 3;

/** Шестилучевая снежинка; variant меняет рисунок веточек */
function makeStarSprite(variant: number): HTMLCanvasElement {
  const canvas = createCanvas(STAR_SPRITE_SIZE, STAR_SPRITE_SIZE);
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  const half = STAR_SPRITE_SIZE / 2;
  const arm = half - 4;
  ctx.translate(half, half);
  ctx.strokeStyle = '#ffffff';
  ctx.fillStyle = '#ffffff';
  ctx.lineCap = 'round';
  ctx.lineWidth = 3.4;

  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    ctx.moveTo(0, 0);
    ctx.lineTo(cos * arm, sin * arm);

    // Веточки: [где на луче, длина]
    const branches: Array<[number, number]> =
      variant === 0 ? [[0.45, 10], [0.72, 7]] : variant === 1 ? [[0.6, 12]] : [[0.35, 6], [0.55, 9], [0.78, 6]];
    for (const [at, length] of branches) {
      const bx = cos * arm * at;
      const by = sin * arm * at;
      for (const turn of [-Math.PI / 3, Math.PI / 3]) {
        ctx.moveTo(bx, by);
        ctx.lineTo(bx + Math.cos(angle + turn) * length, by + Math.sin(angle + turn) * length);
      }
    }
  }
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(0, 0, variant === 2 ? 6 : 3.5, 0, Math.PI * 2);
  ctx.fill();
  return canvas;
}

/** Иней: дымка и ледяные веточки по краям экрана. Нарастает в метель, тает в штиль */
class Frost {
  private image: HTMLCanvasElement | null = null;
  private level = 0;

  /** Насколько сейчас заметен иней (0..1) */
  get value(): number {
    return this.level;
  }

  /** target — к какому уровню стремиться; растёт примерно за 30 с, тает за 20 с */
  update(frames: number, target: number): void {
    const step = (target > this.level ? 1 / 1800 : 1 / 1200) * frames;
    this.level = clamp(target, this.level - step, this.level + step);
  }

  draw(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    if (this.level < 0.01) return;
    if (!this.image || this.image.width !== Math.round(width) || this.image.height !== Math.round(height)) {
      this.image = Frost.render(width, height);
    }
    ctx.globalAlpha = this.level;
    ctx.drawImage(this.image, 0, 0, width, height);
    ctx.globalAlpha = 1;
  }

  private static render(width: number, height: number): HTMLCanvasElement {
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return canvas;

    // Дымка вдоль краёв; сверху тоньше, чтобы не мешать меню-бару
    const haze = 'rgba(232, 242, 255, 0.5)';
    const clear = 'rgba(232, 242, 255, 0)';
    const edges: Array<[number, number, number, number, number, number, number, number]> = [
      // x0, y0, x1, y1 градиента и прямоугольник x, y, w, h
      [0, 0, 70, 0, 0, 0, 70, height],
      [width, 0, width - 70, 0, width - 70, 0, 70, height],
      [0, height, 0, height - 70, 0, height - 70, width, 70],
      [0, 0, 0, 30, 0, 0, width, 30],
    ];
    for (const [x0, y0, x1, y1, x, y, w, h] of edges) {
      const gradient = ctx.createLinearGradient(x0, y0, x1, y1);
      gradient.addColorStop(0, haze);
      gradient.addColorStop(1, clear);
      ctx.fillStyle = gradient;
      ctx.fillRect(x, y, w, h);
    }

    // В углах инея больше всего
    const cornerRadius = Math.min(width, height) * 0.3;
    for (const [cx, cy] of [[0, 0], [width, 0], [0, height], [width, height]]) {
      const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, cornerRadius);
      gradient.addColorStop(0, 'rgba(235, 244, 255, 0.55)');
      gradient.addColorStop(1, clear);
      ctx.fillStyle = gradient;
      ctx.fillRect(cx - cornerRadius, cy - cornerRadius, cornerRadius * 2, cornerRadius * 2);
    }

    // Ледяные веточки растут от краёв внутрь
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.lineWidth = 1;
    ctx.lineCap = 'round';
    ctx.beginPath();
    const count = Math.round((width + height) / 10);
    for (let i = 0; i < count; i++) {
      const [x, y, angle, length] = Frost.pickStart(width, height);
      Frost.branch(ctx, x, y, angle, length, 0);
    }
    ctx.stroke();
    return canvas;
  }

  /** Точка на краю экрана (чаще у углов) и направление внутрь */
  private static pickStart(width: number, height: number): [number, number, number, number] {
    if (Math.random() < 0.55) {
      const corner = Math.floor(rand(0, 4));
      const right = corner % 2 === 1;
      const bottom = corner >= 2;
      const spread = Math.min(width, height) * 0.22;
      const alongX = Math.random() < 0.5;
      const x = right ? width - (alongX ? rand(0, spread) : 0) : alongX ? rand(0, spread) : 0;
      const y = bottom ? height - (alongX ? 0 : rand(0, spread)) : alongX ? 0 : rand(0, spread);
      const angle = Math.atan2(bottom ? -1 : 1, right ? -1 : 1) + rand(-0.6, 0.6);
      return [x, y, angle, rand(24, 70)];
    }
    switch (Math.floor(rand(0, 4))) {
      case 0: return [0, rand(0, height), rand(-0.6, 0.6), rand(12, 40)];
      case 1: return [width, rand(0, height), Math.PI + rand(-0.6, 0.6), rand(12, 40)];
      case 2: return [rand(0, width), height, -Math.PI / 2 + rand(-0.6, 0.6), rand(12, 40)];
      default: return [rand(0, width), 0, Math.PI / 2 + rand(-0.6, 0.6), rand(6, 18)];
    }
  }

  private static branch(
    ctx: CanvasRenderingContext2D,
    x: number, y: number, angle: number, length: number, depth: number,
  ): void {
    const endX = x + Math.cos(angle) * length;
    const endY = y + Math.sin(angle) * length;
    ctx.moveTo(x, y);
    ctx.lineTo(endX, endY);
    if (depth >= 3) return;
    for (const at of [0.4, 0.7]) {
      const bx = x + (endX - x) * at;
      const by = y + (endY - y) * at;
      const side = Math.random() < 0.5 ? -1 : 1;
      Frost.branch(ctx, bx, by, angle + side * rand(0.5, 0.9), length * rand(0.4, 0.6), depth + 1);
    }
  }
}

const GARLAND_SPAN = 150;     // расстояние между точками крепления, px
const GARLAND_SAG = 16;       // насколько провисает провод
const GARLAND_STEP = 30;      // расстояние между лампочками
const GARLAND_PATTERN_SECONDS = 10;

/** Цвет с прозрачностью из #rrggbb */
function withAlpha(hex: string, alpha: number): string {
  const value = parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

/** Гирлянда под меню-баром; мигает тремя узорами по очереди */
class Garland {
  private glows: HTMLCanvasElement[] | null = null;

  private glowSprites(): HTMLCanvasElement[] {
    if (!this.glows) {
      this.glows = GARLAND_COLORS.map((color) => {
        const canvas = createCanvas(32, 32);
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const gradient = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
          gradient.addColorStop(0, withAlpha(color, 0.9));
          gradient.addColorStop(0.4, withAlpha(color, 0.35));
          gradient.addColorStop(1, withAlpha(color, 0));
          ctx.fillStyle = gradient;
          ctx.fillRect(0, 0, 32, 32);
        }
        return canvas;
      });
    }
    return this.glows;
  }

  /** Яркость лампочки index в момент time (секунды), 0..1 */
  static brightness(index: number, time: number): number {
    const pattern = Math.floor(time / GARLAND_PATTERN_SECONDS) % 3;
    let value: number;
    if (pattern === 0) value = 0.5 + 0.5 * Math.sin(time * 3 - index * 0.6);         // бегущая волна
    else if (pattern === 1) value = (Math.floor(time * 1.5) + index) % 2 ? 1 : 0;   // через одну
    else value = 0.5 + 0.5 * Math.sin(time * (1.3 + ((index * 7919) % 13) / 7) + index); // мерцание
    return 0.25 + 0.75 * value;
  }

  private static sagAt(x: number): number {
    const u = (((x % GARLAND_SPAN) + GARLAND_SPAN) % GARLAND_SPAN) / GARLAND_SPAN;
    return 4 * GARLAND_SAG * u * (1 - u);
  }

  draw(ctx: CanvasRenderingContext2D, width: number, topInset: number, time: number): void {
    const y0 = topInset + 2;

    // Провод
    ctx.strokeStyle = 'rgba(28, 58, 38, 0.9)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, y0);
    for (let x = 0; x < width; x += GARLAND_SPAN) {
      ctx.quadraticCurveTo(x + GARLAND_SPAN / 2, y0 + 2 * GARLAND_SAG, x + GARLAND_SPAN, y0);
    }
    ctx.stroke();

    const glows = this.glowSprites();
    let index = 0;
    for (let x = GARLAND_STEP / 2; x < width; x += GARLAND_STEP, index++) {
      const color = GARLAND_COLORS[index % GARLAND_COLORS.length];
      const y = y0 + Garland.sagAt(x);
      const light = Garland.brightness(index, time);

      // Цоколь, свечение и сама лампочка
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#2a3a2e';
      ctx.fillRect(x - 1.5, y, 3, 4);

      ctx.globalAlpha = light * 0.9;
      ctx.drawImage(glows[index % glows.length], x - 14, y + 9 - 14, 28, 28);

      ctx.globalAlpha = 0.5 + 0.5 * light;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.ellipse(x, y + 9, 3.2, 5, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}
