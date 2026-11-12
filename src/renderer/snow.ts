interface Flake {
  x: number;
  y: number;
  z: number; // глубина: 0 — далеко (мелкая, бледная, медленная), 1 — близко
  r: number;
  speed: number;
  phase: number;
  swaySpeed: number;
  lands: boolean; // ляжет в сугроб или пролетит перед окном
  star: boolean; // ближние снежинки рисуются звёздочками
  angle: number;
  spin: number;
  variant: number;
}

/**
 * Снег, отделившийся от сугроба. С area > 0 это комок: он падает и ложится
 * на кромку ниже. С area = 0 — снежная пыль, которая просто тает в воздухе.
 */
interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  area: number;
  life: number; // для пыли: 1 → 0
  sourceId: string | null; // на свою же кромку комок не возвращается
}

// Скорости в настройках заданы «на кадр при 60 FPS». Движение считаем по
// реальному времени, чтобы на 120 Гц снег не падал вдвое быстрее.
const BASE_FRAME_MS = 1000 / 60;
// После паузы (окно было скрыто) не даём снежинкам «прыгнуть»
const MAX_FRAME_MS = 100;

const MAX_PARTICLES = 500;
const PARTICLE_GRAVITY = 0.14;
const DUST_LIFETIME_FRAMES = 40;
const FLAKE_DENSITY = 0.4; // какая часть объёма снежинки остаётся в сугробе
const DEPTH_LAYERS = [0.45, 0.75, 1]; // прозрачность дальних, средних и ближних снежинок
const STAR_SCALE = 2.4; // звёздочка крупнее точки того же радиуса
const SHOVEL_PILE_SCALE = 2.2; // лопата наваливает кучу выше обычного сугроба
const SHOVEL_BLADE = 6; // лопата чуть впереди курсора, px
const SHOVEL_BACK = 15; // сколько за лопатой подбирается осыпавшегося снега, px
const SNOWBALL_MELT_PER_SECOND = 0.012; // какая доля шара тает за секунду
const SHAKE_SPEED = 9; // с какой скорости окна (px за кадр) снег начинает осыпаться
const SHAKE_TOPPLE_SPEED = 16; // а с какой — валятся и снеговики
const SHAKE_MAX_GAP_MS = 150; // между двумя сценами дольше — скорость не определить

class Snowfall {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly flakes: Flake[] = [];
  private readonly drifts = new Map<string, Drift>();
  /** Сугробы окон, которые свёрнуты или на другом рабочем столе */
  private readonly dormant = new Map<string, Drift>();
  private readonly particles: Particle[] = [];
  private readonly snowballs: Snowballs;
  private readonly stars: HTMLCanvasElement[];
  private readonly frost = new Frost();
  private readonly garland = new Garland();
  private readonly plow = new Plow();
  private settings: SnowSettings = INITIAL_SETTINGS;
  private windows: ScreenRect[] = [];
  private topInset = 0;
  private pointer: SnowPointer | null = null;
  private wind = 0;
  private frameRate = 0;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private lastTime: number | null = null;
  /** Окно сейчас ловит клики (курсор над снеговиком); иначе клики проходят сквозь снег */
  private interactive = false;
  private interactiveSentAt = 0;
  /** Время кадра, на котором пришла прошлая сцена: по нему считаем, как быстро двигают окна */
  private sceneAt: number | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly config: SnowConfig,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D недоступен');
    this.ctx = ctx;
    this.stars = Array.from({ length: STAR_VARIANTS }, (_, variant) => makeStarSprite(variant));
    this.snowballs = new Snowballs(
      config,
      (chunk, sourceId) => this.addChunk(chunk, sourceId),
      (x, y, vx, vy) => this.addDust(x, y, vx, vy),
    );

    this.resize();
    this.setSettings(INITIAL_SETTINGS);
    window.addEventListener('resize', this.resize);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mousedown', this.onMouseDown);
  }

  /** Вызвать снегоуборочную машину (пункт меню в трее) */
  callPlow(): void {
    this.plow.start(this.width);
  }

  start(): void {
    requestAnimationFrame(this.tick);
  }

  /** Настройки из меню в трее применяются на лету */
  setSettings(settings: SnowSettings): void {
    this.settings = settings;

    const { count } = INTENSITY[settings.intensity];
    while (this.flakes.length < count) this.flakes.push(this.makeFlake());
    this.flakes.length = count;

    if (!settings.drifts) {
      this.drifts.clear();
      this.dormant.clear();
      this.snowballs.clear();
    }
  }

  /** Ограничение частоты кадров (0 — без ограничения) */
  setFrameRate(fps: number): void {
    this.frameRate = fps;
  }

  /** Главный процесс сообщил, где сейчас окна, их кромки и низ экрана */
  setScene(scene: SnowScene): void {
    const gap = this.sceneAt !== null && this.lastTime !== null ? this.lastTime - this.sceneAt : 0;
    this.sceneAt = this.lastTime ?? 0;
    this.windows = scene.windows;
    this.topInset = scene.topInset;
    if (!this.settings.drifts) return;

    const keep = new Set(scene.keep);
    const alive = new Set<string>();
    for (const surface of scene.surfaces) {
      alive.add(surface.id);
      // Окно вернулось с другого рабочего стола или развернулось — вместе со своим снегом
      const drift = this.drifts.get(surface.id) ?? this.dormant.get(surface.id);
      if (drift) {
        if (surface.kind === 'window' && this.drifts.get(surface.id) === drift) this.shakeIfJerked(drift, surface, gap);
        drift.setSurface(surface);
        this.dormant.delete(surface.id);
        this.drifts.set(surface.id, drift);
        if (!drift.allowsSnowballs) this.snowballs.dropAll(drift);
      } else {
        this.drifts.set(surface.id, new Drift(surface, this.config));
      }
    }

    for (const [id, drift] of this.drifts) {
      if (alive.has(id)) continue;
      this.drifts.delete(id);
      if (keep.has(id)) {
        // Окно не закрыли, а свернули или увели на другой стол — снег ждёт его возвращения
        this.dormant.set(id, drift);
        continue;
      }
      // Окно закрыли — его сугроб и снежки обрушиваются вниз
      for (const chunk of drift.collapse()) this.addChunk(chunk, id, true);
      this.snowballs.dropAll(drift);
    }

    // Окно закрыли, пока его не было видно — снег пропадает незаметно
    for (const id of this.dormant.keys()) {
      if (keep.has(id) || alive.has(id)) continue;
      this.dormant.delete(id);
      this.snowballs.forget(id);
    }
  }

  /** Окно быстро двигают — снег не успевает за ним и сыплется вниз */
  private shakeIfJerked(drift: Drift, surface: SnowSurface, gapMs: number): void {
    if (gapMs < 8 || gapMs > SHAKE_MAX_GAP_MS) return;
    const frames = gapMs / BASE_FRAME_MS;
    const vx = (surface.x - drift.left) / frames;
    const vy = (surface.y - drift.top) / frames;
    const speed = Math.hypot(vx, vy);
    if (speed < SHAKE_SPEED) return;

    // Совсем резкий рывок — снеговики и шары тоже валятся
    if (speed >= SHAKE_TOPPLE_SPEED) this.snowballs.dropAll(drift);

    const fraction = clamp(0.25 + (speed - SHAKE_SPEED) / 30, 0.25, 0.9);
    for (const chunk of drift.shake(fraction)) {
      this.addParticle({
        x: chunk.x,
        y: chunk.y,
        vx: clamp(-vx * 0.15, -4, 4) + rand(-1, 1),
        vy: clamp(-vy * 0.15, -3, 3) - rand(0, 1.5),
        r: clamp(Math.sqrt(chunk.area / Math.PI) * 0.7, 1.2, 5),
        area: chunk.area,
        life: 1,
        sourceId: drift.id,
      });
    }
    for (let i = 0; i < 6; i++) {
      this.addDust(
        drift.left + rand(0, drift.right - drift.left),
        drift.top - rand(0, 6),
        rand(-1.5, 1.5),
        -rand(0.3, 1.5),
      );
    }
  }

  clearDrifts(): void {
    for (const drift of this.drifts.values()) drift.clear();
    this.dormant.clear();
    this.snowballs.clear();
    this.particles.length = 0;
    this.plow.stop();
  }

  /** Сугробы и снеговики подтаивают: seconds — сколько секунд таяния */
  melt(seconds: number): void {
    if (seconds <= 0) return;
    const dh = seconds * this.config.meltPerSecond;
    for (const drift of this.drifts.values()) drift.melt(dh);
    for (const drift of this.dormant.values()) drift.melt(dh);
    this.snowballs.melt(clamp(seconds * SNOWBALL_MELT_PER_SECOND, 0, 1));
  }

  private readonly resize = (): void => {
    const prevWidth = this.width;
    const prevHeight = this.height;
    this.width = window.innerWidth;
    this.height = window.innerHeight;

    // Рисуем в физических пикселях, чтобы снег был чётким на Retina
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    // При смене размера экрана равномерно растягиваем снег на новую область
    if (prevWidth > 0 && prevHeight > 0) {
      for (const f of this.flakes) {
        f.x *= this.width / prevWidth;
        f.y *= this.height / prevHeight;
      }
    }
  };

  private readonly onMouseMove = (event: MouseEvent): void => {
    const prev = this.pointer;
    this.pointer = {
      x: event.clientX,
      y: event.clientY,
      dx: (prev?.dx ?? 0) + (prev ? event.clientX - prev.x : 0),
      dy: (prev?.dy ?? 0) + (prev ? event.clientY - prev.y : 0),
    };
  };

  private readonly onMouseDown = (event: MouseEvent): void => {
    if (event.button) return; // только левая кнопка
    const pile = this.snowballs.snowmanAt(this.drifts, event.clientX, event.clientY);
    const drift = pile ? this.drifts.get(pile.driftId) : undefined;
    if (pile && drift) this.snowballs.poke(pile, drift);
  };

  /**
   * Оверлей пропускает клики сквозь себя, но над снеговиком должен их ловить.
   * Главному процессу сообщаем об этом при входе на снеговика и выходе с него;
   * пока курсор стоит на нём — повторяем сообщение, иначе сработает страховочный таймер.
   */
  private updateInteractive(now: number): void {
    const over =
      this.settings.drifts &&
      this.pointer !== null &&
      this.snowballs.snowmanAt(this.drifts, this.pointer.x, this.pointer.y) !== null;
    if (over === this.interactive && !(over && now - this.interactiveSentAt > 400)) return;

    this.interactive = over;
    this.interactiveSentAt = now;
    window.snowBridge?.setInteractive(over);
    if (document.body) document.body.style.cursor = over ? 'pointer' : '';
  }

  private makeFlake(): Flake {
    const flake: Flake = {
      x: 0,
      y: 0,
      z: 0,
      r: 0,
      speed: 0,
      phase: 0,
      swaySpeed: 0,
      lands: false,
      star: false,
      angle: 0,
      spin: 0,
      variant: 0,
    };
    this.recycle(flake);
    flake.y = rand(-this.height, this.height); // при старте снег уже идёт по всему экрану
    return flake;
  }

  /** Возвращает снежинку наверх с новыми размером и глубиной */
  private recycle(f: Flake): void {
    const { minR, maxR, landChance, starDepth } = this.config;
    f.z = Math.random();
    f.r = minR + (maxR - minR) * Math.pow(f.z, 1.5); // мелких снежинок больше, чем крупных
    f.x = rand(0, this.width);
    f.y = -f.r * STAR_SCALE;
    f.speed = rand(0.7, 1.3);
    f.phase = rand(0, Math.PI * 2);
    f.swaySpeed = rand(0.008, 0.02);
    f.lands = f.z > 0.25 && Math.random() < landChance; // самые дальние всегда пролетают мимо
    f.star = f.z > starDepth;
    f.angle = rand(0, Math.PI * 2);
    f.spin = rand(-0.03, 0.03);
    f.variant = Math.floor(rand(0, STAR_VARIANTS));
  }

  /** Ветер: постоянная часть плюс плавные порывы из нескольких наложенных волн */
  private updateWind(now: number): void {
    const { base, gust } = WIND[this.settings.wind];
    const t = now / 1000;
    const wave = 0.55 * Math.sin(t / 6.1) + 0.3 * Math.sin(t / 2.3 + 1.7) + 0.15 * Math.sin(t / 0.9 + 4);
    this.wind = (base + gust * wave) * INTENSITY[this.settings.intensity].windScale;
  }

  /** Сугроб, верхушку которого точка пересекла за этот кадр */
  private findLanding(x: number, prevY: number, y: number, skipId: string | null): Drift | null {
    for (const drift of this.drifts.values()) {
      if (drift.id === skipId) continue;
      const top = drift.landingY(x);
      if (top !== null && prevY <= top && y >= top) return drift;
    }
    return null;
  }

  private updateFlakes(frames: number): void {
    const { sway } = this.config;
    const { fallSpeed } = INTENSITY[this.settings.intensity];
    const pileRate = PILE_RATE[this.settings.pileSpeed];

    for (const f of this.flakes) {
      const prevY = f.y;
      f.phase += f.swaySpeed * frames;
      f.angle += f.spin * frames;
      // Ближние снежинки падают быстрее и сильнее сносятся ветром
      f.y += f.speed * fallSpeed * (0.5 + f.z) * frames;
      f.x += (this.wind * (0.4 + 0.8 * f.z) + Math.sin(f.phase) * sway * 0.3) * frames;

      const drift = f.lands ? this.findLanding(f.x, prevY, f.y, null) : null;
      if (drift) drift.deposit(f.x, Math.PI * f.r * f.r * FLAKE_DENSITY * pileRate);
      if (drift || f.y > this.height + f.r * STAR_SCALE) {
        this.recycle(f);
        continue;
      }
      // Ушла вбок — возвращаем с другой стороны
      const margin = f.r * STAR_SCALE;
      if (f.x > this.width + margin) f.x = -margin;
      else if (f.x < -margin) f.x = this.width + margin;
    }
  }

  private addParticle(particle: Particle): void {
    if (this.particles.length < MAX_PARTICLES) this.particles.push(particle);
  }

  private addDust(x: number, y: number, vx: number, vy: number): void {
    this.addParticle({ x, y, vx, vy, r: rand(0.8, 1.8), area: 0, life: 1, sourceId: null });
  }

  /** Комок снега: падает и ложится на кромку ниже. gentle — без разлёта (обрушение) */
  private addChunk(chunk: SnowChunk, sourceId: string | null, gentle = false): void {
    this.addParticle({
      x: chunk.x,
      y: chunk.y,
      vx: gentle ? rand(-0.4, 0.4) : rand(-1.2, 1.2),
      vy: gentle ? rand(0, 1) : rand(-1.5, 0.5),
      r: clamp(Math.sqrt(chunk.area / Math.PI) * 0.7, 1.2, 5),
      area: chunk.area,
      life: 1,
      sourceId,
    });
  }

  /** Варежка: несколько комков летят по ходу курсора, вокруг — снежная пыль */
  private throwSnow(swept: SnowChunk, pointer: SnowPointer, sourceId: string): void {
    const pieces = clamp(Math.ceil(swept.area / 30), 1, 8);
    const vx = clamp(pointer.dx * 0.25, -6, 6);
    const vy = clamp(pointer.dy * 0.15, -4, 2);

    for (let i = 0; i < pieces; i++) {
      const area = swept.area / pieces;
      this.addParticle({
        x: swept.x + rand(-8, 8),
        y: swept.y + rand(-2, 4),
        vx: vx + rand(-1.2, 1.2),
        vy: vy - rand(0.5, 2.5),
        r: clamp(Math.sqrt(area / Math.PI) * 0.7, 1.2, 5),
        area,
        life: 1,
        sourceId,
      });
    }
    for (let i = 0; i < 3; i++) {
      this.addDust(swept.x + rand(-10, 10), swept.y + rand(-4, 4), vx * 0.5 + rand(-1.5, 1.5), -rand(0.5, 2));
    }
  }

  /** Лопата: снег, через который прошла лопата, едет перед ней и копится кучей */
  private shovel(drift: Drift, pointer: SnowPointer): void {
    const direction = Math.sign(pointer.dx);
    if (direction === 0) return;
    // Лопата работает, только если курсор у самой кромки — не выше кучи и не глубоко в окне
    const reachAbove = this.config.windowDriftHeight * SHOVEL_PILE_SCALE + 15;
    if (pointer.y < drift.top - reachAbove || pointer.y > drift.top + this.config.shovelRadius) return;

    const blade = pointer.x + direction * SHOVEL_BLADE;
    // Забираем и то, что осыпалось с кучи за спину лопаты
    const scooped = drift.scoop(blade - pointer.dx - direction * SHOVEL_BACK, blade);
    if (!scooped) return;

    const overflow = drift.pushAhead(blade + direction * DRIFT_COLUMN, scooped.area, direction, SHOVEL_PILE_SCALE);
    if (overflow > 1) {
      // Куча не помещается (или лопата дошла до края окна) — лишний снег ссыпается вниз
      const x = clamp(blade + direction * 8, drift.left - 6, drift.right + 6);
      this.addChunk({ x, y: scooped.y, area: overflow }, drift.id);
    }
    if (Math.random() < 0.4) this.addDust(blade, scooped.y, direction * rand(0.5, 2), -rand(0.3, 1.2));
  }

  /** Курсор: варежка сметает, лопата сгребает, в режиме снежков — катаем шары */
  private handlePointer(frames: number): void {
    const pointer = this.pointer;
    if (!pointer || (pointer.dx === 0 && pointer.dy === 0)) return;
    const velocityX = pointer.dx / Math.max(frames, 0.5);

    for (const drift of this.drifts.values()) {
      const tool = this.settings.tool;
      if (tool === 'snowball' && drift.allowsSnowballs) {
        this.snowballs.interact(drift, pointer, velocityX);
      } else if (tool === 'shovel') {
        this.shovel(drift, pointer);
      } else {
        const swept = drift.sweep(pointer.x, pointer.y, this.config.sweepRadius);
        if (swept) this.throwSnow(swept, pointer, drift.id);
      }
    }
    pointer.dx = 0;
    pointer.dy = 0;
  }

  private updatePlow(frames: number): void {
    const ground = this.drifts.get('ground') ?? null;
    this.plow.update(
      frames,
      {
        width: this.width,
        drift: ground,
        crush: (from, to) => {
          if (ground) this.snowballs.crush(ground, from, to);
        },
        spray: (x, y, area, direction) =>
          this.addParticle({
            x,
            y,
            vx: direction * rand(1.5, 3.5),
            vy: -rand(2, 5),
            r: clamp(Math.sqrt(area / Math.PI) * 0.7, 1.2, 5),
            area,
            life: 1,
            sourceId: 'ground',
          }),
        dust: (x, y, vx, vy) => this.addDust(x, y, vx, vy),
      },
      this.settings.plow && this.settings.drifts,
    );
  }

  /** В метель ветер сдувает верхушки сугробов */
  private erodeDrifts(frames: number): void {
    const strength = Math.abs(this.wind) - EROSION_WIND;
    if (strength <= 0 || this.settings.intensity === 'thaw') return;

    for (const drift of this.drifts.values()) {
      if (Math.random() > 0.15 * strength * frames) continue;
      const chunk = drift.erode();
      if (!chunk) continue;
      this.addParticle({
        x: chunk.x,
        y: chunk.y,
        vx: this.wind * rand(1.5, 2.5),
        vy: -rand(0.2, 1),
        r: rand(1, 2),
        area: chunk.area,
        life: 1,
        sourceId: drift.id,
      });
    }
  }

  private updateParticles(frames: number): void {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      const prevY = p.y;
      p.vy += PARTICLE_GRAVITY * frames;
      p.x += (p.vx + this.wind * 0.3) * frames;
      p.y += p.vy * frames;

      let gone = p.y > this.height + 10 || p.x < -20 || p.x > this.width + 20;
      if (p.area === 0) {
        p.life -= frames / DUST_LIFETIME_FRAMES;
        gone = gone || p.life <= 0;
      } else if (p.vy > 0) {
        const drift = this.findLanding(p.x, prevY, p.y, p.sourceId);
        if (drift) {
          drift.deposit(p.x, p.area);
          gone = true;
        }
      }
      if (gone) this.particles.splice(i, 1);
    }
  }

  private drawFlakes(): void {
    const { ctx, dpr } = this;

    // Дальние снежинки — точки тремя слоями глубины; каждый слой — один путь и один fill
    DEPTH_LAYERS.forEach((alpha, layer) => {
      ctx.fillStyle = `rgba(255, 255, 255, ${this.config.opacity * alpha})`;
      ctx.beginPath();
      for (const f of this.flakes) {
        if (f.star) continue;
        if (Math.min(DEPTH_LAYERS.length - 1, Math.floor(f.z * DEPTH_LAYERS.length)) !== layer) continue;
        ctx.moveTo(f.x + f.r, f.y);
        ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
      }
      ctx.fill();
    });

    // Ближние — вращающиеся звёздочки, готовые картинки копируются с поворотом
    ctx.globalAlpha = this.config.opacity;
    for (const f of this.flakes) {
      if (!f.star) continue;
      const size = f.r * STAR_SCALE;
      const cos = Math.cos(f.angle) * dpr;
      const sin = Math.sin(f.angle) * dpr;
      ctx.setTransform(cos, sin, -sin, cos, f.x * dpr, f.y * dpr);
      ctx.drawImage(this.stars[f.variant], -size, -size, size * 2, size * 2);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
  }

  private draw(time: number): void {
    const { ctx } = this;
    ctx.clearRect(0, 0, this.width, this.height);

    for (const drift of this.drifts.values()) drift.draw(ctx);
    if (this.settings.garland) this.garland.draw(ctx, this.width, this.topInset, time);
    this.snowballs.draw(ctx, this.drifts);
    this.plow.draw(ctx, this.height, time);
    this.drawFlakes();

    ctx.fillStyle = `rgba(255, 255, 255, ${this.config.opacity})`;
    ctx.beginPath();
    for (const p of this.particles) {
      const r = p.r * p.life;
      ctx.moveTo(p.x + r, p.y);
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    }
    ctx.fill();

    this.frost.draw(ctx, this.width, this.height);
  }

  /** Иней нарастает в метель и тает в штиль и оттепель */
  private frostTarget(): number {
    if (!this.settings.frost) return 0;
    const base = INTENSITY[this.settings.intensity].frost;
    return base === 0 ? 0 : clamp(base + Math.max(0, Math.abs(this.wind) - 1) * 0.15, 0, 1);
  }

  private readonly tick = (now: number): void => {
    requestAnimationFrame(this.tick);

    // Экономия батареи: пропускаем кадры, пришедшие раньше положенного
    if (this.frameRate > 0 && this.lastTime !== null && now - this.lastTime < 1000 / this.frameRate - 2) {
      return;
    }
    const elapsed = Math.min(this.lastTime === null ? BASE_FRAME_MS : now - this.lastTime, MAX_FRAME_MS);
    this.lastTime = now;
    const frames = elapsed / BASE_FRAME_MS;

    this.updateWind(now);
    this.updateFlakes(frames);
    this.handlePointer(frames);
    this.erodeDrifts(frames);
    if (this.settings.intensity === 'thaw') this.melt(elapsed / 1000);
    for (const drift of this.drifts.values()) drift.update();
    this.updateParticles(frames);
    this.snowballs.update(frames, {
      width: this.width,
      height: this.height,
      windows: this.windows,
      drifts: this.drifts,
    });
    this.updatePlow(frames);
    this.updateInteractive(now);
    this.frost.update(frames, this.frostTarget());
    this.draw(now / 1000);
  };
}

const snowCanvas = document.getElementById('snow');
if (!(snowCanvas instanceof HTMLCanvasElement)) {
  throw new Error('Не найден <canvas id="snow">');
}
const snowfall = new Snowfall(snowCanvas, CONFIG);
window.snowBridge?.onSettings((settings) => snowfall.setSettings(settings));
window.snowBridge?.onFrameRate((fps) => snowfall.setFrameRate(fps));
window.snowBridge?.onScene((scene) => snowfall.setScene(scene));
window.snowBridge?.onClearDrifts(() => snowfall.clearDrifts());
window.snowBridge?.onMelt((seconds) => snowfall.melt(seconds));
window.snowBridge?.onPlow(() => snowfall.callPlow());
snowfall.start();
