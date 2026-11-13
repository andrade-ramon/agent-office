import { needsAttention, type SessionState, type ToolCategory } from '@agent-office/server/schema';
import { Container, Graphics, Sprite, Text, type Texture } from 'pixi.js';
import type { BalloonKind } from './art/balloons';
import { PIVOT_X, PIVOT_Y, FRAME_H, FRAME_W, spriteHeight, type ArmPose, type EyePose, type ItemPose, type LegPose, type Pose } from './art/characterDraw';
import { acquireSheet, releaseSheet, type CharacterSheet } from './art/characterSheet';
import { TILE, tileFeet, type OfficeLayout } from './layout';
import { findPath } from './pathfinding';
import type { DeskAllocator, SlotAllocator } from './slots';
import { isWorkActivity, sameTarget, targetFor, type Activity, type Target } from './targets';
import type { Dir, Point, Slot } from './types';
import { accentColor, hash32, hexToInt, variantFor, type Variant } from './variant';

/** Tempo mínimo exibindo uma atividade de ferramenta depois de chegar à estação. */
const MIN_DWELL_MS = 1500;
/** Depois que a ferramenta termina, quanto tempo ainda insistimos em mostrá-la. */
const MAX_HOLD_MS = 6000;
const ERROR_MS = 2500;
const CHEER_MS = 2600;
const WALK_SPEED = 80; // px/s
const FADE_MS = 420;

export const TAG_FONT = 'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, "Liberation Mono", monospace';

export type SpawnMode = 'target' | 'door' | 'parent';

/** O que o personagem precisa do mundo. */
export interface CharacterWorld {
  office: OfficeLayout;
  slots: SlotAllocator;
  desks: DeskAllocator;
  tex(name: string): Texture;
  layers: { floorFx: Container; objects: Container; balloons: Container; tags: Container };
  character(key: string): Character | undefined;
  confetti(x: number, y: number): void;
  resolution(): number;
}

export interface FrameView {
  zoom: number;
  showLabels: boolean;
  /** Transformação mundo → tela. */
  originX: number;
  originY: number;
}

const CATEGORY_BALLOON: Record<ToolCategory, BalloonKind> = {
  read: 'book',
  write: 'pencil',
  edit: 'pencil',
  bash: 'terminal',
  search: 'search',
  web: 'globe',
  plan: 'plan',
  other: 'gear',
};

const ACTIVITY_BALLOON: Partial<Record<Activity, BalloonKind>> = {
  read: 'book',
  type: 'pencil',
  bash: 'terminal',
  search: 'search',
  web: 'globe',
  plan: 'plan',
  meet: 'chat',
};

export class Character {
  readonly key: string;
  session: SessionState;
  readonly variant: Variant;
  readonly pipColor: number;

  x = 0;
  y = 0;
  /** Tile lógico atual. */
  tx = 0;
  ty = 0;
  facing: Dir = 'down';
  path: Point[] = [];
  slot: Slot | null = null;
  share = 0;
  settled = false;
  moving = false;
  arrivedAt = 0;
  shown: Target;

  alpha = 0;
  dim = false;
  selected = false;
  hovered = false;
  /** Saiu pela porta e está invisível, aguardando o `remove`. */
  parked = false;
  /** Removido pelo servidor: some e depois é destruído. */
  removing = false;
  dead = false;

  private readonly world: CharacterWorld;
  private readonly sheet: CharacterSheet;
  private readonly body: Sprite;
  private readonly shadow: Sprite;
  private readonly balloon: Sprite;
  private readonly ringA: Sprite;
  private readonly ringB: Sprite;
  private readonly tag: Container;
  private readonly tagBg: Graphics;
  private readonly tagText: Text;
  private tagLabel = '';
  private tagW = 0;
  private tagSpace = 0;
  /** Retângulo da etiqueta na tela neste quadro (null = oculta). */
  tagBox: { x: number; y: number; w: number; h: number } | null = null;
  private readonly height: number;

  private pendingSince = 0;
  private errorUntil = 0;
  private cheerUntil = 0;
  private lastErrorTs = 0;
  private flashKind: BalloonKind | null = null;
  private flashUntil = 0;
  private clock: number;
  private walkClock = 0;
  private lastPoseKey = '';

  constructor(world: CharacterWorld, session: SessionState, spawn: SpawnMode, now: number) {
    this.world = world;
    this.key = session.key;
    this.session = session;
    this.variant = variantFor(session.key, session.agent, session.parentKey);
    this.sheet = acquireSheet(this.variant);
    this.height = spriteHeight(this.variant);
    this.pipColor = hexToInt(accentColor(this.variant));
    this.clock = hash32(session.key) % 5000;
    this.lastErrorTs = session.lastErrorAt ?? 0;
    this.shown = targetFor(session);

    const { layers } = world;
    this.shadow = new Sprite(world.tex('shadow'));
    this.shadow.anchor.set(0.5, 0.5);
    if (this.variant.small) this.shadow.scale.set(0.75, 0.75);
    this.ringA = new Sprite(world.tex('ring-0'));
    this.ringB = new Sprite(world.tex('ring-3'));
    for (const r of [this.ringA, this.ringB]) {
      r.anchor.set(0.5, 0.5);
      r.visible = false;
    }
    layers.floorFx.addChild(this.shadow, this.ringA, this.ringB);

    this.body = new Sprite(this.sheet.frame({ dir: 'down', legs: 'stand', arms: 'down', eyes: 'open', item: 'none' }));
    this.body.anchor.set(PIVOT_X / FRAME_W, PIVOT_Y / FRAME_H);
    layers.objects.addChild(this.body);

    this.balloon = new Sprite(world.tex('balloon-dots1'));
    this.balloon.anchor.set(0.25, 1);
    this.balloon.visible = false;
    layers.balloons.addChild(this.balloon);

    this.tag = new Container();
    this.tagBg = new Graphics();
    this.tagText = new Text({
      text: '',
      style: {
        fontFamily: TAG_FONT,
        fontSize: this.variant.small ? 9 : 10,
        fontWeight: '600',
        fill: 0xffffff,
      },
    });
    this.tagText.resolution = world.resolution();
    this.tag.addChild(this.tagBg, this.tagText);
    this.tag.visible = false;
    layers.tags.addChild(this.tag);

    this.place(spawn, now);
  }

  // ───────────────────────── estado da sessão ─────────────────────────

  setSession(next: SessionState, now: number): void {
    const prev = this.session;
    this.session = next;
    if (this.removing) return;
    if ((next.lastErrorAt ?? 0) > this.lastErrorTs) this.triggerError(next.lastErrorAt ?? now, now);
    else if (next.status === 'error' && prev.status !== 'error') this.triggerError(next.statusSince, now);
    if (next.status === 'done' && prev.status !== 'done') {
      this.cheerUntil = now + CHEER_MS;
      this.world.confetti(this.x, this.y - this.height);
    }
    if (next.status !== 'done') this.cheerUntil = Math.min(this.cheerUntil, now);
    if (next.status !== 'ended' && this.parked) {
      // Sessão voltou: reaparece na porta.
      this.parked = false;
      this.place('door', now);
    }
  }

  /** Erro transitório (evento `error` ou `lastErrorAt` avançando). */
  triggerError(ts: number, now: number): void {
    if (ts <= this.lastErrorTs) return;
    this.lastErrorTs = ts;
    this.errorUntil = now + ERROR_MS;
  }

  /** Mostra um balão por um instante (ex.: prompt recebido). */
  flash(kind: BalloonKind, now: number, ms = 1100): void {
    this.flashKind = kind;
    this.flashUntil = now + ms;
  }

  remove(): void {
    this.removing = true;
    this.releaseSlots();
  }

  get attention(): boolean {
    return needsAttention(this.session.status);
  }

  get activity(): Activity {
    return this.shown.activity;
  }

  /** Está sentado à própria mesa (para acender o monitor). */
  get atDesk(): boolean {
    return this.settled && this.slot !== null && this.slot.area === 'desk';
  }

  get visible(): boolean {
    return !this.parked && this.alpha > 0.02;
  }

  // ───────────────────────── posicionamento ─────────────────────────

  private place(spawn: SpawnMode, now: number): void {
    const { office } = this.world;
    this.path = [];
    this.settled = false;
    this.alpha = 0;
    if (spawn === 'parent') {
      const parent = this.session.parentKey ? this.world.character(this.session.parentKey) : undefined;
      if (parent && parent.visible) {
        this.tx = parent.tx;
        this.ty = parent.ty;
        this.x = parent.x + ((hash32(this.key) % 9) - 4);
        this.y = parent.y + 2;
        this.shown = targetFor(this.session);
        this.claim(now);
        return;
      }
      spawn = 'door';
    }
    if (spawn === 'door') {
      const doors = office.slots.door;
      const door = doors[hash32(this.key) % doors.length]!;
      const feet = tileFeet(door.x, door.y);
      this.tx = door.x;
      this.ty = door.y;
      this.x = feet.x;
      this.y = feet.y;
      this.facing = 'down';
      this.shown = targetFor(this.session);
      this.claim(now);
      return;
    }
    // Já estava em atividade: aparece direto no destino.
    const target = targetFor(this.session);
    if (target.area === 'stay') {
      // Aguardando permissão: aparece na estação da ferramenta em questão.
      this.shown = targetFor({ ...this.session, status: this.session.toolCategory ? 'working' : 'thinking' });
      this.claim(now);
      this.shown = target;
    } else {
      this.shown = target;
      this.claim(now);
    }
    if (this.slot) {
      const p = this.settlePoint(this.slot);
      this.tx = this.slot.x;
      this.ty = this.slot.y;
      this.x = p.x;
      this.y = p.y;
      this.path = [];
      this.settled = true;
      this.arrivedAt = now - 5000;
      this.facing = this.slot.facing;
    }
  }

  private settlePoint(slot: Slot): Point {
    const feet = tileFeet(slot.x, slot.y);
    let x = feet.x + slot.ox;
    let y = feet.y + slot.oy;
    if (this.share > 0) {
      x += ((this.share * 7) % 11) - 5;
      y += ((this.share * 5) % 7) - 3;
    }
    return { x, y };
  }

  private releaseSlots(): void {
    this.world.slots.release(this.key);
    this.world.desks.release(this.key);
  }

  /** Garante uma vaga para a área atual e calcula o caminho até ela. */
  private claim(_now: number): void {
    const area = this.shown.area;
    if (area === 'stay') return;
    let slot: Slot;
    let share: number;
    if (area === 'desk') {
      this.world.slots.release(this.key);
      const c = this.world.desks.assign(this.key, this.session.project);
      slot = c.slot;
      share = c.share;
    } else {
      let near: Point = { x: this.tx, y: this.ty };
      if (area === 'meeting' && this.session.parentKey) {
        const parentSlot = this.world.slots.slotOf(this.session.parentKey);
        if (parentSlot && parentSlot.area === 'meeting') near = parentSlot;
      }
      const c = this.world.slots.claim(this.key, area, near);
      slot = c.slot;
      share = c.share;
    }
    if (slot === this.slot && share === this.share) return;
    this.slot = slot;
    this.share = share;
    this.settled = false;
    this.arrivedAt = 0;
    this.routeTo(slot);
  }

  private routeTo(slot: Slot): void {
    const { office } = this.world;
    // Parte do tile mais próximo da posição atual, para andar sempre em linha reta.
    const start = this.nearestTile();
    const found = findPath(office, start.x, start.y, slot.x, slot.y);
    if (!found) {
      // Sem caminho (não deveria acontecer): teleporta.
      const p = this.settlePoint(slot);
      this.x = p.x;
      this.y = p.y;
      this.tx = slot.x;
      this.ty = slot.y;
      this.path = [];
      return;
    }
    const feet = tileFeet(start.x, start.y);
    const offCenter = Math.abs(feet.x - this.x) > 0.5 || Math.abs(feet.y - this.y) > 0.5;
    this.path = offCenter ? [start, ...found] : found;
  }

  private nearestTile(): Point {
    const { office } = this.world;
    const cx = Math.floor(this.x / TILE);
    const cy = Math.floor((this.y - 2) / TILE);
    let best: Point = { x: this.tx, y: this.ty };
    let bestD = Infinity;
    for (const [dx, dy] of [[0, 0], [0, -1], [0, 1], [-1, 0], [1, 0]] as const) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= office.w || y >= office.h) continue;
      if (office.cost[y * office.w + x] === 0) continue;
      const f = tileFeet(x, y);
      const d = Math.abs(f.x - this.x) + Math.abs(f.y - this.y);
      if (d < bestD) {
        bestD = d;
        best = { x, y };
      }
    }
    return best;
  }

  /** Teleporta para o destino atual (usado ao voltar de uma aba oculta). */
  snapToTarget(now: number): void {
    if (this.removing || this.parked) return;
    this.updateTarget(now + MAX_HOLD_MS * 2);
    if (this.shown.area === 'stay' || !this.slot) return;
    const p = this.settlePoint(this.slot);
    this.x = p.x;
    this.y = p.y;
    this.tx = this.slot.x;
    this.ty = this.slot.y;
    this.path = [];
    this.settled = true;
    this.arrivedAt = now - 5000;
    this.facing = this.slot.facing;
  }

  // ───────────────────────── atualização ─────────────────────────

  private updateTarget(now: number): void {
    const want = targetFor(this.session);
    if (sameTarget(want, this.shown)) {
      this.pendingSince = 0;
      this.claim(now);
      return;
    }
    if (isWorkActivity(this.shown.activity) && this.session.status === 'thinking') {
      // A ferramenta já terminou, mas mostramos a atividade por um tempo
      // mínimo — senão ferramentas rápidas nunca apareceriam.
      if (!this.pendingSince) this.pendingSince = now;
      const dwelled = this.settled && now - this.arrivedAt >= MIN_DWELL_MS;
      const timedOut = now - this.pendingSince >= MAX_HOLD_MS;
      if (!dwelled && !timedOut) {
        this.claim(now);
        return;
      }
    }
    this.pendingSince = 0;
    this.shown = want;
    this.claim(now);
  }

  /** Avança a simulação (pode ser chamado várias vezes por quadro). */
  update(dtMs: number, now: number): void {
    this.clock += dtMs;

    // ── fade ──
    const frozenByFx = now < this.errorUntil || now < this.cheerUntil;
    let fadeTo = 1;
    if (this.removing) fadeTo = 0;
    else if (this.session.status === 'ended' && this.settled && this.slot?.area === 'door') fadeTo = 0;
    const step = dtMs / FADE_MS;
    if (this.alpha < fadeTo) this.alpha = Math.min(fadeTo, this.alpha + step);
    else if (this.alpha > fadeTo) this.alpha = Math.max(fadeTo, this.alpha - step);
    if (this.alpha <= 0 && fadeTo === 0) {
      if (this.removing) {
        this.dead = true;
      } else if (!this.parked) {
        this.parked = true;
        this.releaseSlots();
        this.slot = null;
      }
    }

    if (this.parked || this.dead) return;

    // ── destino e movimento ──
    if (!this.removing) {
      if (!frozenByFx) this.updateTarget(now);
      const frozen = frozenByFx || this.shown.area === 'stay';
      this.moving = false;
      if (!frozen) this.advance(dtMs, now);
    } else {
      this.moving = false;
    }
  }

  /** Atualiza os sprites (uma vez por quadro). */
  draw(now: number, view: FrameView): void {
    if (this.parked || this.dead) this.hideAll();
    else this.render(now, view);
  }

  private advance(dtMs: number, now: number): void {
    if (!this.slot) return;
    let speed = WALK_SPEED;
    if (this.path.length > 12) speed *= 1.45;
    else if (this.path.length > 6) speed *= 1.2;
    let remaining = (speed * dtMs) / 1000;
    let guard = 8;
    while (remaining > 0 && guard-- > 0) {
      const next = this.path[0];
      let target: Point;
      if (next) target = tileFeet(next.x, next.y);
      else if (!this.settled) target = this.settlePoint(this.slot);
      else break;
      const dx = target.x - this.x;
      const dy = target.y - this.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 0.01) {
        this.moving = true;
        if (Math.abs(dx) > Math.abs(dy)) this.facing = dx < 0 ? 'left' : 'right';
        else this.facing = dy < 0 ? 'up' : 'down';
      }
      if (dist <= remaining) {
        this.x = target.x;
        this.y = target.y;
        remaining -= dist;
        if (next) {
          this.tx = next.x;
          this.ty = next.y;
          this.path.shift();
        } else {
          this.settled = true;
          this.arrivedAt = now;
          this.facing = this.slot.facing;
          this.moving = false;
        }
      } else {
        this.x += (dx / dist) * remaining;
        this.y += (dy / dist) * remaining;
        remaining = 0;
      }
    }
    if (this.moving) this.walkClock += dtMs * (speed / WALK_SPEED);
  }

  // ───────────────────────── desenho ─────────────────────────

  /** Prioridade da etiqueta quando há sobreposição (maior = fica). */
  get tagPriority(): number {
    if (this.selected || this.hovered) return 4;
    if (this.attention) return 3;
    return this.variant.small ? 1 : 2;
  }

  /** Esconde a etiqueta neste quadro (outra, mais importante, ocupa o lugar). */
  hideTag(): void {
    if (!this.tag.visible) return;
    this.tag.visible = false;
    this.tagBox = null;
    if (this.balloon.visible) this.balloon.y += Math.round(this.tagSpace);
  }

  private hideAll(): void {
    this.tagBox = null;
    this.body.visible = false;
    this.shadow.visible = false;
    this.balloon.visible = false;
    this.ringA.visible = false;
    this.ringB.visible = false;
    this.tag.visible = false;
  }

  private render(now: number, view: FrameView): void {
    const t = this.clock;
    const slot = this.slot;
    const seated = this.settled && slot !== null && slot.seat !== 'stand';
    const since = this.settled ? now - this.arrivedAt : 0;
    const blink = t % 3400 < 130;

    let dir: Dir = this.facing;
    let legs: LegPose = seated ? 'sit' : 'stand';
    let arms: ArmPose = 'down';
    let eyes: EyePose = blink ? 'closed' : 'open';
    let item: ItemPose = 'none';
    let balloon: BalloonKind | null = null;
    let bounce = false;
    let ring = 0;
    let dx = 0;
    let dy = 0;
    let tint = 0xffffff;
    const flip2 = (ms: number): boolean => Math.floor(t / ms) % 2 === 0;

    const activity = this.shown.activity;
    const status = this.session.status;

    if (now < this.errorUntil) {
      dir = 'down';
      arms = 'head';
      eyes = 'x';
      dx = Math.floor(t / 45) % 2 === 0 ? -1 : 1;
      tint = Math.floor(t / 160) % 2 === 0 ? 0xff8a8a : 0xffffff;
      balloon = 'cross';
    } else if (now < this.cheerUntil) {
      dir = 'down';
      legs = 'stand';
      arms = flip2(170) ? 'cheerA' : 'cheerB';
      eyes = 'happy';
      dy = -Math.round(Math.abs(Math.sin(t / 150)) * 5);
    } else if (this.moving) {
      const phase = Math.floor(this.walkClock / 105) % 4;
      legs = phase === 1 ? 'walkA' : phase === 3 ? 'walkB' : 'stand';
      arms = phase === 1 ? 'swingA' : phase === 3 ? 'swingB' : 'down';
      dy = phase % 2 === 1 ? -1 : 0;
      if (status === 'working' && this.session.toolCategory) balloon = CATEGORY_BALLOON[this.session.toolCategory];
      else if (isWorkActivity(activity)) balloon = ACTIVITY_BALLOON[activity] ?? null;
      else if (activity === 'idle') balloon = 'cup';
      else if (activity === 'wait') balloon = 'question';
      if (activity === 'meet') balloon = 'chat';
    } else if (activity === 'permission') {
      dir = 'down';
      arms = flip2(260) ? 'waveA' : 'waveB';
      balloon = 'exclaim';
      bounce = true;
      ring = 0xff7a4a;
    } else if (!this.settled) {
      // parado no meio do caminho (não deveria durar)
      arms = 'down';
    } else {
      const tag = slot?.tag ?? '';
      switch (activity) {
        case 'think':
          arms = 'chin';
          balloon = (['dots1', 'dots2', 'dots3'] as const)[Math.floor(t / 420) % 3]!;
          break;
        case 'type':
          arms = flip2(130) ? 'typeA' : 'typeB';
          break;
        case 'read':
          if (!seated && since < 800) {
            dir = 'up';
            arms = flip2(220) ? 'workA' : 'workB';
          } else {
            if (!seated) dir = 'down';
            arms = dir === 'up' ? 'typeA' : 'hold';
            item = 'book';
            if (t % 2600 < 220) eyes = 'closed';
          }
          break;
        case 'search':
          arms = flip2(200) ? 'workA' : 'workB';
          balloon = 'search';
          break;
        case 'bash':
          arms = tag === 'terminal' ? (flip2(130) ? 'typeA' : 'typeB') : flip2(240) ? 'workA' : 'workB';
          break;
        case 'plan':
          if (tag === 'write') arms = flip2(300) ? 'workA' : 'workB';
          else arms = 'chin';
          break;
        case 'web':
          if (tag === 'watch') arms = 'chin';
          else arms = flip2(140) ? 'typeA' : 'typeB';
          break;
        case 'meet':
          arms = Math.floor(t / 520) % 3 === 0 ? 'waveB' : Math.floor(t / 520) % 3 === 1 ? 'down' : 'chin';
          balloon = 'chat';
          break;
        case 'wait':
          dir = 'down';
          arms = flip2(260) ? 'waveA' : 'waveB';
          balloon = 'question';
          bounce = true;
          ring = 0xffd84a;
          break;
        case 'done':
          eyes = 'happy';
          balloon = 'check';
          break;
        case 'error':
          eyes = 'closed';
          balloon = 'cross';
          break;
        case 'idle':
          if (tag === 'coffee' || tag === 'water') {
            if (since < 2600 || tag === 'water') {
              dir = 'up';
              arms = flip2(280) ? 'workA' : 'workB';
            } else {
              dir = 'down';
              arms = 'hold';
              item = 'cup';
            }
          } else if (tag === 'cup' || tag === 'table') {
            arms = dir === 'up' ? 'down' : 'hold';
            item = 'cup';
          } else if (since > 9000) {
            eyes = 'closed';
            balloon = flip2(700) ? 'zzz1' : 'zzz2';
          }
          break;
        default:
          break;
      }
    }

    if (now < this.flashUntil && this.flashKind && !balloon) balloon = this.flashKind;

    // ── sprite ──
    const spriteDir = dir === 'left' || dir === 'right' ? 'side' : dir;
    const pose: Pose = { dir: spriteDir, legs, arms, eyes, item };
    const key = `${spriteDir}|${legs}|${arms}|${eyes}|${item}`;
    if (key !== this.lastPoseKey) {
      this.lastPoseKey = key;
      this.body.texture = this.sheet.frame(pose);
    }
    const a = this.alpha * (this.dim ? 0.22 : 1);
    const px = Math.round(this.x) + dx;
    const py = Math.round(this.y) + dy;
    this.body.visible = true;
    this.body.position.set(px, py);
    this.body.scale.x = dir === 'right' ? -1 : 1;
    this.body.zIndex = this.y;
    this.body.alpha = a;
    this.body.tint = tint;

    this.shadow.visible = true;
    this.shadow.position.set(Math.round(this.x), Math.round(this.y) - 1);
    this.shadow.alpha = a * (seated ? 0.45 : 0.9);

    // ── anel de atenção ──
    if (ring && !this.dim) {
      const period = 1000;
      const draw = (sprite: Sprite, offset: number): void => {
        const ph = ((t + offset) % period) / period;
        sprite.visible = true;
        sprite.texture = this.world.tex(`ring-${Math.min(5, Math.floor(ph * 6))}`);
        sprite.position.set(Math.round(this.x), Math.round(this.y) - 2);
        sprite.tint = ring;
        sprite.alpha = this.alpha * (1 - ph) * 0.95;
      };
      draw(this.ringA, 0);
      draw(this.ringB, period / 2);
    } else {
      this.ringA.visible = false;
      this.ringB.visible = false;
    }

    // ── etiqueta ──
    const sitDrop = seated && !this.variant.small ? 2 : 0;
    const headY = this.y - this.height + sitDrop + dy;
    const showTag = (view.showLabels || this.hovered || this.selected) && !this.dim && this.alpha > 0.5;
    let tagSpace = 0;
    if (showTag) {
      const detailed = view.zoom >= 3 || this.hovered || this.selected;
      this.updateTag(detailed);
      const sx = view.originX + this.x * view.zoom;
      const sy = view.originY + headY * view.zoom;
      const tx = Math.round(sx - this.tagW / 2);
      const ty = Math.round(sy - 16);
      this.tag.visible = true;
      this.tag.position.set(tx, ty);
      this.tag.alpha = this.alpha * (this.variant.small && !this.hovered && !this.selected ? 0.82 : 1);
      this.tag.zIndex = this.selected || this.hovered ? 100000 : this.y;
      tagSpace = 16 / view.zoom;
      const box = this.tagBox ?? { x: 0, y: 0, w: 0, h: 0 };
      box.x = tx;
      box.y = ty;
      box.w = this.tagW;
      box.h = 13;
      this.tagBox = box;
    } else {
      this.tag.visible = false;
      this.tagBox = null;
    }
    this.tagSpace = tagSpace;

    // ── balão ──
    if (balloon && !this.dim) {
      const jump = bounce ? Math.round(Math.abs(Math.sin(t / 240)) * 3) : 0;
      this.balloon.visible = true;
      this.balloon.texture = this.world.tex(`balloon-${balloon}`);
      this.balloon.position.set(Math.round(this.x) + 2, Math.round(headY - tagSpace) - jump);
      this.balloon.alpha = this.alpha;
      this.balloon.zIndex = this.attention ? this.y + 10000 : this.y;
    } else {
      this.balloon.visible = false;
    }
  }

  private updateTag(detailed: boolean): void {
    const s = this.session;
    const label = detailed && s.project ? `${s.label} · ${s.project}` : s.label;
    const attention = this.attention;
    const id = `${label}|${attention ? 1 : 0}|${this.selected ? 1 : 0}`;
    if (id === this.tagLabel) return;
    this.tagLabel = id;
    this.tagText.text = label;
    this.tagText.style.fill = attention ? 0xffe27a : 0xffffff;
    const tw = Math.ceil(this.tagText.width);
    const w = tw + 15;
    const h = 13;
    this.tagW = w;
    this.tagText.position.set(11, Math.round((h - this.tagText.height) / 2));
    this.tagBg.clear();
    this.tagBg.rect(1, 0, w - 2, h).rect(0, 1, w, h - 2).fill({ color: this.selected ? 0x2c3a5e : 0x141722, alpha: 0.86 });
    if (this.selected) this.tagBg.rect(1, h - 1, w - 2, 1).fill({ color: 0xffffff, alpha: 0.9 });
    this.tagBg.rect(4, 4, 5, 5).fill({ color: this.pipColor });
    this.tagBg.rect(4, 4, 5, 1).fill({ color: 0xffffff, alpha: 0.35 });
  }

  setResolution(resolution: number): void {
    this.tagText.resolution = resolution;
    this.tagLabel = '';
  }

  /** O ponto (em pixels do mundo) está sobre o personagem? */
  hit(wx: number, wy: number): boolean {
    if (!this.visible || this.removing) return false;
    const half = this.variant.small ? 6 : 8;
    return wx >= this.x - half && wx <= this.x + half && wy >= this.y - this.height - 2 && wy <= this.y + 2;
  }

  get headY(): number {
    return this.y - this.height;
  }

  destroy(): void {
    this.releaseSlots();
    releaseSheet(this.sheet);
    this.body.destroy();
    this.shadow.destroy();
    this.balloon.destroy();
    this.ringA.destroy();
    this.ringB.destroy();
    this.tag.destroy({ children: true });
  }

  debug(): Record<string, unknown> {
    return {
      key: this.key,
      label: this.session.label,
      agent: this.session.agent,
      status: this.session.status,
      toolCategory: this.session.toolCategory,
      parentKey: this.session.parentKey ?? null,
      activity: this.shown.activity,
      area: this.shown.area,
      slot: this.slot?.id ?? null,
      slotArea: this.slot?.area ?? null,
      tile: { x: this.tx, y: this.ty },
      target: this.slot ? { x: this.slot.x, y: this.slot.y } : null,
      px: { x: Math.round(this.x), y: Math.round(this.y) },
      moving: this.moving,
      settled: this.settled,
      pathLength: this.path.length,
      alpha: Number(this.alpha.toFixed(2)),
      parked: this.parked,
      dim: this.dim,
      small: this.variant.small,
    };
  }
}
