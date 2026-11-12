// Снегоуборочная машина. Время от времени выезжает по низу экрана, сгребает отвалом
// снег с нижнего сугроба, разбивает снеговиков на своём пути и уезжает за край.
// Выезжает сама, когда внизу намело (если включено в меню), или по команде из трея.

const PLOW_SPEED = 2.6; // px за кадр при 60 FPS
const PLOW_LENGTH = 104; // от кончика отвала до заднего борта, px
const PLOW_BACK = 14; // сколько снега за отвалом подбирается заново, px
const PLOW_PILE_SCALE = 0.5; // куча перед отвалом — не выше самого отвала
const PLOW_AUTO_FILL = 0.4; // с какой заполненности нижнего сугроба машина выезжает сама (0..1)
const PLOW_COOLDOWN_SECONDS = 90; // не чаще, чем раз в столько секунд
const PLOW_CHECK_SECONDS = 2; // как часто смотрим, не пора ли выезжать
const PLOW_WHEEL_RADIUS = 10;
const PLOW_SPRAY_AREA = 120; // сколько снега уходит в один летящий комок, px²

/** Всё, с чем машина взаимодействует */
interface PlowWorld {
  width: number;
  /** Нижний сугроб; null — снег не копится */
  drift: Drift | null;
  /** Снеговики и шары между from и to рассыпаются */
  crush: (from: number, to: number) => void;
  /** Комок снега, который отвал выбросил вперёд и вверх */
  spray: (x: number, y: number, area: number, direction: number) => void;
  dust: (x: number, y: number, vx: number, vy: number) => void;
}

class Plow {
  private active = false;
  private bladeX = 0; // кончик отвала
  private direction = 1; // 1 — едет вправо, -1 — влево
  private wheel = 0; // угол поворота колёс
  private cooldown = 0; // секунд до следующего автоматического выезда
  private checkTimer = 0;

  get running(): boolean {
    return this.active;
  }

  get x(): number {
    return this.bladeX;
  }

  /** Выезжает из-за края экрана. Ничего не делает, если уже едет. */
  start(width: number, direction: number = Math.random() < 0.5 ? 1 : -1): boolean {
    if (this.active) return false;
    this.active = true;
    this.direction = direction >= 0 ? 1 : -1;
    // Машина целиком за краем: при движении вправо тянется налево от отвала, при движении влево — направо
    this.bladeX = this.direction > 0 ? -8 : width + 8;
    this.cooldown = PLOW_COOLDOWN_SECONDS;
    this.checkTimer = 0;
    return true;
  }

  stop(): void {
    this.active = false;
  }

  update(frames: number, world: PlowWorld, auto: boolean): void {
    if (!this.active) {
      const seconds = frames / 60;
      this.cooldown -= seconds;
      this.checkTimer -= seconds;
      if (auto && this.cooldown <= 0 && this.checkTimer <= 0) {
        this.checkTimer = PLOW_CHECK_SECONDS;
        if (world.drift && world.drift.fill >= PLOW_AUTO_FILL) this.start(world.width);
      }
      return;
    }

    const dir = this.direction;
    const previous = this.bladeX;
    this.bladeX += dir * PLOW_SPEED * frames;
    this.wheel += (dir * PLOW_SPEED * frames) / PLOW_WHEEL_RADIUS;

    const { drift } = world;
    if (drift) {
      const from = previous - dir * PLOW_BACK;
      world.crush(from, this.bladeX);

      const scooped = drift.scoop(from, this.bladeX);
      if (scooped) {
        const overflow = drift.pushAhead(this.bladeX + dir * 3, scooped.area, dir, PLOW_PILE_SCALE);
        // Куча перед отвалом небольшая — всё лишнее летит вперёд и вверх
        if (overflow > 1 && this.bladeX > 0 && this.bladeX < world.width) {
          const pieces = clamp(Math.ceil(overflow / PLOW_SPRAY_AREA), 1, 3);
          for (let i = 0; i < pieces; i++) {
            world.spray(this.bladeX + dir * rand(4, 14), scooped.y + rand(-4, 2), overflow / pieces, dir);
          }
        }
        if (Math.random() < 0.5) {
          world.dust(this.bladeX + dir * 6, scooped.y, dir * rand(0.8, 2.4), -rand(0.4, 1.6));
        }
      }
    }

    // Выхлоп из задней части машины
    if (Math.random() < 0.2 * frames) {
      world.dust(
        this.bladeX - dir * (PLOW_LENGTH - 4),
        world.drift ? world.drift.top - 12 : 0,
        -dir * rand(0.3, 1.1),
        -rand(0.4, 1.0),
      );
    }

    const gone = dir > 0 ? this.bladeX - PLOW_LENGTH > world.width + 10 : this.bladeX + PLOW_LENGTH < -10;
    if (gone) this.active = false;
  }

  /** baseline — Y земли, на которой стоят колёса */
  draw(ctx: CanvasRenderingContext2D, baseline: number, time: number): void {
    if (!this.active) return;

    ctx.save();
    ctx.translate(this.bladeX, baseline - 2);
    ctx.scale(this.direction, 1); // дальше рисуем так, будто машина едет вправо, кончик отвала в x = 0

    // Свет фар впереди
    ctx.fillStyle = 'rgba(255, 240, 170, 0.14)';
    ctx.beginPath();
    ctx.moveTo(-8, -23);
    ctx.lineTo(80, -38);
    ctx.lineTo(80, -2);
    ctx.closePath();
    ctx.fill();

    // Шасси и колёса
    ctx.fillStyle = '#3a4049';
    ctx.fillRect(-100, -16, 92, 8);
    for (const x of [-30, -82]) this.drawWheel(ctx, x, -PLOW_WHEEL_RADIUS);

    // Кузов-бункер сзади
    ctx.fillStyle = '#f2a01c';
    ctx.fillRect(-100, -32, 48, 16);
    ctx.fillStyle = '#c97d0a';
    ctx.fillRect(-100, -20, 48, 4);
    ctx.fillStyle = '#ffc04d';
    ctx.fillRect(-100, -34, 48, 3);

    // Кабина с наклонным лобовым стеклом
    ctx.fillStyle = '#f2a01c';
    ctx.beginPath();
    ctx.moveTo(-52, -16);
    ctx.lineTo(-52, -44);
    ctx.lineTo(-28, -44);
    ctx.lineTo(-16, -28);
    ctx.lineTo(-12, -28);
    ctx.lineTo(-12, -16);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#bfe3f7';
    ctx.beginPath();
    ctx.moveTo(-47, -40);
    ctx.lineTo(-30, -40);
    ctx.lineTo(-21, -29);
    ctx.lineTo(-47, -29);
    ctx.closePath();
    ctx.fill();

    // Бампер и фара
    ctx.fillStyle = '#555e69';
    ctx.fillRect(-14, -20, 6, 8);
    ctx.fillStyle = '#ffe9a3';
    ctx.beginPath();
    ctx.arc(-9, -23, 2.5, 0, Math.PI * 2);
    ctx.fill();

    // Стойки отвала
    ctx.strokeStyle = '#4a525c';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-14, -14);
    ctx.lineTo(-3, -9);
    ctx.moveTo(-14, -20);
    ctx.lineTo(-3, -22);
    ctx.stroke();

    // Сам отвал — стальной, чуть вынесен вперёд
    const steel = ctx.createLinearGradient(-6, 0, 7, 0);
    steel.addColorStop(0, '#e3e9f1');
    steel.addColorStop(1, '#8e9bab');
    ctx.fillStyle = steel;
    ctx.strokeStyle = '#5c6672';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-6, -31);
    ctx.lineTo(2, -31);
    ctx.lineTo(7, -2);
    ctx.lineTo(-4, -2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Маячок на крыше: мигает и подсвечивает всё вокруг
    ctx.fillStyle = '#4a525c';
    ctx.fillRect(-42, -47, 12, 3);
    const on = Math.sin(time * 9) > 0;
    if (on) {
      const glow = ctx.createRadialGradient(-36, -50, 0, -36, -50, 16);
      glow.addColorStop(0, 'rgba(255, 176, 0, 0.75)');
      glow.addColorStop(1, 'rgba(255, 176, 0, 0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(-36, -50, 16, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = on ? '#ffd24d' : '#c98a00';
    ctx.beginPath();
    ctx.arc(-36, -50, 3.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  private drawWheel(ctx: CanvasRenderingContext2D, x: number, y: number): void {
    ctx.fillStyle = '#23272d';
    ctx.beginPath();
    ctx.arc(x, y, PLOW_WHEEL_RADIUS, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(this.wheel);
    ctx.strokeStyle = '#9aa4b2';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-6, 0);
    ctx.lineTo(6, 0);
    ctx.moveTo(0, -6);
    ctx.lineTo(0, 6);
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = '#c9d1dc';
    ctx.beginPath();
    ctx.arc(x, y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
}
