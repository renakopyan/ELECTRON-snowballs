// Снежки и снеговики. В режиме «Снежки» курсор не сметает снег, а скатывает его
// в шар: шар растёт, пока его толкают по сугробу. Шар поменьше, прикаченный
// к шару побольше, встаёт на него сверху — два-три шара дают снеговика.
// Если толкнуть шар резким рывком, он летит и разбивается о край окна или экрана.

const BALL_SEED_AREA = 45;     // сколько снега надо смести, чтобы появился шар, px²
const BALL_FLUFF = 1.6;        // шар рыхлее слежавшегося сугроба и потому крупнее
const BALL_PUSH_GAP = 8;       // расстояние между курсором и шаром, который он толкает
const BALL_STACK_OVERLAP = 0.75;
const MAX_STACK = 3;
const MAX_PILES_PER_DRIFT = 6; // чтобы кромка не превращалась в россыпь шаров
const MIN_BALL_AREA = 15;      // мельче — шар растаял

const BALL_GRAVITY = 0.45;     // px за кадр²
const MAX_THROW_SPEED = 28;
const MAX_FLIGHT_FRAMES = 360;
const SPLAT_LIFETIME_FRAMES = 110;

// Клик по снеговику: подпрыгивает, подбрасывает голову или бросается снежком
type PokeKind = 'hop' | 'head' | 'throw';
const POKE_FRAMES: Record<PokeKind, number> = { hop: 46, head: 40, throw: 28 };
const POKE_HEIGHT: Record<PokeKind, number> = { hop: 30, head: 46, throw: 12 };
const POKE_KINDS: PokeKind[] = ['hop', 'head', 'throw'];
const SNOWMAN_HIT_MARGIN = 5;  // на сколько пикселей вокруг снеговика курсор уже считается «на нём»
const SNOWMAN_THROW_SHARE = 0.1;
const SNOWMAN_MIN_THROW_AREA = 10;

/** Шар или стопка шаров (снизу вверх), стоящая на кромке */
interface SnowPile {
  driftId: string;
  offset: number;   // положение относительно левого края кромки — едет вместе с окном
  areas: number[];  // количество снега в каждом шаре, снизу вверх
  poke?: { kind: PokeKind; age: number }; // идёт анимация после клика
}

/** Брошенный снежок */
interface FlyingBall {
  x: number;
  y: number;
  vx: number;
  vy: number;
  area: number;
  age: number;
}

/** Снежная клякса на месте удара */
interface Splat {
  x: number;
  y: number;
  r: number;
  life: number; // 1 → 0
}

interface SnowPointer {
  x: number;
  y: number;
  dx: number;
  dy: number;
}

/** Всё, о что может удариться брошенный снежок */
interface SnowWorld {
  width: number;
  height: number;
  windows: ScreenRect[];
  drifts: ReadonlyMap<string, Drift>;
}

function drawSnowBall(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  const fill = ctx.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.1, x, y, r);
  fill.addColorStop(0, '#ffffff');
  fill.addColorStop(1, '#d9e4f2');
  ctx.fillStyle = fill;
  ctx.strokeStyle = 'rgba(130, 150, 185, 0.4)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

class Snowballs {
  private piles: SnowPile[] = [];
  private flying: FlyingBall[] = [];
  private splats: Splat[] = [];
  private seed: { driftId: string; area: number } | null = null;
  private nextPoke = Math.floor(Math.random() * POKE_KINDS.length);

  constructor(
    private readonly config: SnowConfig,
    /** Комок снега, который падает и ложится на кромку ниже */
    private readonly scatter: (chunk: SnowChunk, sourceId: string | null) => void,
    /** Снежная пыль — просто тает в воздухе */
    private readonly dust: (x: number, y: number, vx: number, vy: number) => void,
  ) {}

  private radius(area: number): number {
    return Math.min(this.config.maxBallRadius, Math.sqrt(area / Math.PI) * BALL_FLUFF);
  }

  private get maxArea(): number {
    const r = this.config.maxBallRadius / BALL_FLUFF;
    return Math.PI * r * r;
  }

  /** Сколько снега во всех шарах (для тестов и отладки), px² */
  get volume(): number {
    let sum = 0;
    for (const pile of this.piles) for (const area of pile.areas) sum += area;
    for (const ball of this.flying) sum += ball.area;
    return sum;
  }

  get pileCount(): number {
    return this.piles.length;
  }

  get flyingCount(): number {
    return this.flying.length;
  }

  get splatCount(): number {
    return this.splats.length;
  }

  /** Сколько снеговиков сейчас прыгают или бросаются снежками */
  get pokeCount(): number {
    return this.piles.filter((pile) => pile.poke).length;
  }

  clear(): void {
    this.piles = [];
    this.flying = [];
    this.splats = [];
    this.seed = null;
  }

  /** Окно закрыли, пока оно было на другом рабочем столе — его шары просто пропадают */
  forget(driftId: string): void {
    this.piles = this.piles.filter((pile) => pile.driftId !== driftId);
  }

  /** Кромка исчезла — её шары падают вниз */
  dropAll(drift: Drift): void {
    for (const pile of this.piles) {
      if (pile.driftId === drift.id) this.drop(pile, drift);
    }
    this.forget(drift.id);
  }

  private drop(pile: SnowPile, drift: Drift): void {
    const x = drift.left + pile.offset;
    let base = drift.top;
    for (const area of pile.areas) {
      const r = this.radius(area);
      const pieces = clamp(Math.round(area / 60), 3, 10);
      for (let i = 0; i < pieces; i++) {
        this.scatter({ x: x + rand(-r, r), y: base - rand(0, 2 * r), area: area / pieces }, drift.id);
      }
      base -= 2 * r * BALL_STACK_OVERLAP;
    }
  }

  /** Оттепель: каждый шар теряет долю fraction своего снега, растаявшие исчезают */
  melt(fraction: number): void {
    if (fraction <= 0) return;
    for (const pile of this.piles) {
      pile.areas = pile.areas.map((area) => area * (1 - fraction));
      while (pile.areas.length > 0 && pile.areas[pile.areas.length - 1] < MIN_BALL_AREA) pile.areas.pop();
    }
    this.piles = this.piles.filter((pile) => pile.areas.length > 0);
    this.seed = null;
  }

  /**
   * Курсор двигается рядом с кромкой: толкаем шар, бросаем его или скатываем новый.
   * velocityX — скорость курсора по горизонтали, px за кадр.
   */
  interact(drift: Drift, pointer: SnowPointer, velocityX: number): void {
    const { sweepRadius } = this.config;
    const top = drift.top;
    if (pointer.y > top + sweepRadius || pointer.y < top - 3 * this.config.maxBallRadius) return;
    if (!drift.isVisibleAt(pointer.x)) return;

    const direction = Math.sign(pointer.dx);
    if (direction !== 0) {
      // Шар впереди по ходу курсора. Считаем от того места, где курсор был в прошлом кадре:
      // при резком рывке курсор за кадр перескакивает через шар
      const startX = pointer.x - pointer.dx;
      const pushed = this.piles.find((pile) => {
        if (pile.driftId !== drift.id || pile.areas.length !== 1) return false;
        const r = this.radius(pile.areas[0]);
        const ballX = drift.left + pile.offset;
        return (
          (ballX - startX) * direction > 0 &&
          (ballX - pointer.x) * direction < r + BALL_PUSH_GAP + 6 &&
          pointer.y > top - 2 * r - 12
        );
      });
      if (pushed) {
        if (Math.abs(velocityX) >= this.config.throwSpeed) this.throwBall(pushed, drift, velocityX, pointer.dy);
        else this.push(pushed, drift, pointer.x, direction);
        return;
      }
    }

    // Шара под рукой нет — сметаем снег и копим его на новый шар
    const swept = drift.sweep(pointer.x, pointer.y, sweepRadius);
    if (!swept) return;
    if (this.seed?.driftId !== drift.id) this.seed = { driftId: drift.id, area: 0 };
    this.seed.area = Math.min(this.maxArea, this.seed.area + swept.area);
    if (direction === 0 || this.seed.area < BALL_SEED_AREA) return;

    // Новый шар появляется перед курсором — если там есть место на кромке
    const r = this.radius(this.seed.area);
    const x = pointer.x + direction * (r + BALL_PUSH_GAP);
    const neighbours = this.piles.filter((pile) => pile.driftId === drift.id);
    const fits =
      x >= drift.left &&
      x <= drift.right &&
      neighbours.length < MAX_PILES_PER_DRIFT &&
      neighbours.every((pile) => Math.abs(drift.left + pile.offset - x) >= r + this.radius(pile.areas[0]));
    if (!fits) return;

    this.piles.push({ driftId: drift.id, offset: x - drift.left, areas: [this.seed.area] });
    this.seed = null;
  }

  private push(ball: SnowPile, drift: Drift, pointerX: number, direction: number): void {
    const r = this.radius(ball.areas[0]);
    const x = drift.left + ball.offset;
    let target = pointerX + direction * (r + BALL_PUSH_GAP);
    if ((target - x) * direction <= 0) return; // толкаем только вперёд

    // На пути другой шар или снеговик?
    for (const other of this.piles) {
      if (other === ball || other.driftId !== drift.id) continue;
      const otherX = drift.left + other.offset;
      const reach = r + this.radius(other.areas[0]);
      const ahead = (otherX - x) * direction > 0;
      if (!ahead || Math.abs(otherX - target) >= reach) continue;

      const topArea = other.areas[other.areas.length - 1];
      if (other.areas.length < MAX_STACK && ball.areas[0] < topArea * 0.9) {
        // Шар меньше верхнего — встаёт на стопку
        other.areas.push(ball.areas[0]);
        this.piles = this.piles.filter((pile) => pile !== ball);
        return;
      }
      target = otherX - direction * reach; // упёрся
      if ((target - x) * direction <= 0) return;
    }

    ball.offset = target - drift.left;

    // Скатился с края окна
    if (target < drift.left - r * 0.3 || target > drift.right + r * 0.3) {
      this.drop(ball, drift);
      this.piles = this.piles.filter((pile) => pile !== ball);
      return;
    }

    // Катясь, шар собирает снег под собой и растёт
    if (ball.areas[0] < this.maxArea) {
      const swept = drift.sweep(target, drift.top - r * 0.6, r);
      if (swept) ball.areas[0] = Math.min(this.maxArea, ball.areas[0] + swept.area);
    }
  }

  /** Резкий рывок курсором: шар срывается с кромки и летит по дуге */
  private throwBall(ball: SnowPile, drift: Drift, velocityX: number, pointerDy: number): void {
    const area = ball.areas[0];
    const r = this.radius(area);
    const vx = clamp(velocityX * 0.9, -MAX_THROW_SPEED, MAX_THROW_SPEED);
    this.flying.push({
      x: drift.left + ball.offset,
      y: drift.top - r - 1,
      vx,
      vy: -clamp(Math.abs(vx) * 0.35 - pointerDy * 0.2, 3, 12),
      area,
      age: 0,
    });
    this.piles = this.piles.filter((pile) => pile !== ball);
  }

  /** Полёт брошенных снежков и таяние клякс */
  update(frames: number, world: SnowWorld): void {
    this.updatePokes(frames, world.drifts);
    for (let i = this.flying.length - 1; i >= 0; i--) {
      const ball = this.flying[i];
      const r = this.radius(ball.area);
      const prevY = ball.y;
      ball.vy += BALL_GRAVITY * frames;
      ball.x += ball.vx * frames;
      ball.y += ball.vy * frames;
      ball.age += frames;

      const hit =
        ball.age > MAX_FLIGHT_FRAMES ||
        ball.x - r < 0 ||
        ball.x + r > world.width ||
        ball.y + r > world.height ||
        world.windows.some(
          (win) => ball.x >= win.x && ball.x <= win.x + win.width && ball.y >= win.y && ball.y <= win.y + win.height,
        ) ||
        (ball.vy > 0 &&
          Array.from(world.drifts.values()).some((drift) => {
            const top = drift.surfaceY(ball.x);
            return top !== null && prevY + r <= top && ball.y + r >= top;
          }));

      if (hit) {
        ball.x = clamp(ball.x, r, world.width - r);
        ball.y = Math.min(ball.y, world.height - r);
        this.smash(ball, r);
        this.flying.splice(i, 1);
      }
    }

    for (let i = this.splats.length - 1; i >= 0; i--) {
      this.splats[i].life -= frames / SPLAT_LIFETIME_FRAMES;
      if (this.splats[i].life <= 0) this.splats.splice(i, 1);
    }
  }

  /** Снежок разбился: снег падает комками, вокруг — пыль, на месте удара — клякса */
  private smash(ball: FlyingBall, r: number): void {
    const pieces = clamp(Math.round(ball.area / 40), 4, 12);
    for (let i = 0; i < pieces; i++) {
      this.scatter({ x: ball.x + rand(-r, r) * 0.6, y: ball.y + rand(-r, r) * 0.6, area: ball.area / pieces }, null);
    }
    for (let i = 0; i < 10; i++) {
      const angle = rand(0, Math.PI * 2);
      const speed = rand(1, 4);
      this.dust(ball.x, ball.y, Math.cos(angle) * speed - ball.vx * 0.15, Math.sin(angle) * speed - 1);
    }
    this.splats.push({ x: ball.x, y: ball.y, r: r * 1.5, life: 1 });
  }

  /** Центры шаров стопки снизу вверх с учётом прыжка после клика */
  private layout(pile: SnowPile, drift: Drift): Array<{ y: number; r: number }> {
    const centers: Array<{ y: number; r: number }> = [];
    let base = drift.top;
    pile.areas.forEach((area, index) => {
      const r = this.radius(area);
      centers.push({ y: base - r + this.lift(pile, index), r });
      base -= 2 * r * BALL_STACK_OVERLAP;
    });
    return centers;
  }

  /** На сколько пикселей шар поднят над своим местом (отрицательное число — вверх) */
  private lift(pile: SnowPile, index: number): number {
    const poke = pile.poke;
    if (!poke) return 0;
    if (poke.kind === 'head' && index !== pile.areas.length - 1) return 0;
    const t = clamp(poke.age / POKE_FRAMES[poke.kind], 0, 1);
    const height = POKE_HEIGHT[poke.kind];
    // Два затухающих прыжка; голова и бросок — один
    const wave = poke.kind === 'hop' ? Math.abs(Math.sin(Math.PI * 2 * t)) * (1 - 0.5 * t) : Math.sin(Math.PI * t);
    return -height * wave;
  }

  /** Снеговик (два шара и больше) под точкой (x, y); null — там пусто */
  snowmanAt(drifts: ReadonlyMap<string, Drift>, x: number, y: number): SnowPile | null {
    for (const pile of this.piles) {
      if (pile.areas.length < 2) continue;
      const drift = drifts.get(pile.driftId);
      if (!drift) continue;
      const px = drift.left + pile.offset;
      if (!drift.isVisibleAt(clamp(px, drift.left, drift.right - 1))) continue;
      const hit = this.layout(pile, drift).some(
        ({ y: cy, r }) => Math.hypot(x - px, y - cy) <= r + SNOWMAN_HIT_MARGIN,
      );
      if (hit) return pile;
    }
    return null;
  }

  /** Клик по снеговику. Возвращает false, если это не снеговик или он уже занят. */
  poke(pile: SnowPile, drift: Drift): boolean {
    if (pile.areas.length < 2 || pile.poke) return false;
    let kind = POKE_KINDS[this.nextPoke % POKE_KINDS.length];
    this.nextPoke++;

    const x = drift.left + pile.offset;
    if (kind === 'throw') {
      const head = pile.areas.length - 1;
      const give = Math.max(SNOWMAN_MIN_THROW_AREA, pile.areas[head] * SNOWMAN_THROW_SHARE);
      if (pile.areas[head] - give < 2 * MIN_BALL_AREA) {
        kind = 'hop'; // голове нечем делиться
      } else {
        pile.areas[head] -= give;
        const { y, r } = this.layout(pile, drift)[head];
        const side = Math.random() < 0.5 ? -1 : 1;
        this.flying.push({
          x: x + side * r,
          y: y - r * 0.3,
          vx: side * rand(6, 11),
          vy: -rand(4, 8),
          area: give,
          age: 0,
        });
      }
    }

    pile.poke = { kind, age: 0 };
    this.puff(x, drift.top, 4);
    return true;
  }

  /** Машина или что-то ещё проехало между from и to: шары и снеговики рассыпаются */
  crush(drift: Drift, from: number, to: number): void {
    const low = Math.min(from, to);
    const high = Math.max(from, to);
    for (const pile of this.piles.filter((p) => p.driftId === drift.id)) {
      const x = drift.left + pile.offset;
      const r = this.radius(pile.areas[0]);
      if (x + r < low || x - r > high) continue;
      this.drop(pile, drift);
      this.puff(x, drift.top - r, 8);
      this.piles = this.piles.filter((other) => other !== pile);
    }
  }

  private puff(x: number, y: number, count: number): void {
    for (let i = 0; i < count; i++) {
      this.dust(x + rand(-10, 10), y - rand(0, 6), rand(-1.6, 1.6), -rand(0.4, 2));
    }
  }

  /** Анимация клика: двигаем время, на приземлении поднимаем снежную пыль */
  private updatePokes(frames: number, drifts: ReadonlyMap<string, Drift>): void {
    for (const pile of this.piles) {
      const poke = pile.poke;
      if (!poke) continue;
      const total = POKE_FRAMES[poke.kind];
      const before = poke.age / total;
      poke.age += frames;
      const after = poke.age / total;

      const drift = drifts.get(pile.driftId);
      const landed = poke.kind === 'hop' ? (before < 0.5 && after >= 0.5) || (before < 1 && after >= 1) : before < 1 && after >= 1;
      if (landed && drift) this.puff(drift.left + pile.offset, drift.top, 3);
      if (after >= 1) pile.poke = undefined;
    }
  }

  draw(ctx: CanvasRenderingContext2D, drifts: Map<string, Drift>): void {
    for (const pile of this.piles) {
      const drift = drifts.get(pile.driftId);
      if (!drift) continue;
      const x = drift.left + pile.offset;
      if (!drift.isVisibleAt(clamp(x, drift.left, drift.right - 1))) continue;

      const centers = this.layout(pile, drift);
      if (pile.areas.length === MAX_STACK) this.drawArms(ctx, x, centers[1], pile);
      for (const { y, r } of centers) drawSnowBall(ctx, x, y, r);
      if (pile.areas.length >= 2) {
        this.drawButtons(ctx, x, centers[centers.length - 2]);
        this.drawFace(ctx, x, centers[centers.length - 1]);
      }
    }

    for (const ball of this.flying) drawSnowBall(ctx, ball.x, ball.y, this.radius(ball.area));

    for (const splat of this.splats) {
      const fill = ctx.createRadialGradient(splat.x, splat.y, 0, splat.x, splat.y, splat.r);
      fill.addColorStop(0, `rgba(255, 255, 255, ${0.85 * splat.life})`);
      fill.addColorStop(0.6, `rgba(240, 246, 255, ${0.5 * splat.life})`);
      fill.addColorStop(1, 'rgba(240, 246, 255, 0)');
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.arc(splat.x, splat.y, splat.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawFace(ctx: CanvasRenderingContext2D, x: number, { y, r }: { y: number; r: number }): void {
    ctx.fillStyle = '#2b2f3a';
    ctx.beginPath();
    for (const side of [-1, 1]) {
      const eyeR = Math.max(1, r * 0.11);
      ctx.moveTo(x + side * r * 0.35 + eyeR, y - r * 0.25);
      ctx.arc(x + side * r * 0.35, y - r * 0.25, eyeR, 0, Math.PI * 2);
    }
    ctx.fill();

    // Морковка
    ctx.fillStyle = '#f08a24';
    ctx.beginPath();
    ctx.moveTo(x, y - r * 0.05);
    ctx.lineTo(x + r * 0.85, y + r * 0.12);
    ctx.lineTo(x, y + r * 0.25);
    ctx.closePath();
    ctx.fill();
  }

  private drawButtons(ctx: CanvasRenderingContext2D, x: number, { y, r }: { y: number; r: number }): void {
    ctx.fillStyle = '#2b2f3a';
    ctx.beginPath();
    for (const shift of [-0.3, 0.2]) {
      const buttonR = Math.max(1, r * 0.08);
      ctx.moveTo(x + buttonR, y + r * shift);
      ctx.arc(x, y + r * shift, buttonR, 0, Math.PI * 2);
    }
    ctx.fill();
  }

  private drawArms(ctx: CanvasRenderingContext2D, x: number, { y, r }: { y: number; r: number }, pile: SnowPile): void {
    // После клика снеговик машет руками
    const wave = pile.poke ? Math.sin(pile.poke.age * 0.5) * r * 0.5 : 0;
    ctx.strokeStyle = '#6b4a2f';
    ctx.lineWidth = Math.max(1.5, r * 0.1);
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (const side of [-1, 1]) {
      ctx.moveTo(x + side * r * 0.8, y - r * 0.1);
      ctx.lineTo(x + side * r * 1.9, y - r * 0.9 - side * wave);
    }
    ctx.stroke();
  }
}
