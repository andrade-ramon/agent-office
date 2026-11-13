import type { NormalizedEvent, SessionState } from '@agent-office/server/schema';
import {
  Application,
  CanvasSource,
  Container,
  Graphics,
  Rectangle,
  Sprite,
  Text,
  Texture,
  TilingSprite,
  UPDATE_PRIORITY,
  type Ticker,
} from 'pixi.js';
import { addBalloons } from './art/balloons';
import { destroyAllSheets } from './art/characterSheet';
import { SKY_H, SKY_W, buildWorldArt, type Anchor, type WorldArt } from './art/world';
import { Character, TAG_FONT, type CharacterWorld, type FrameView, type SpawnMode } from './character';
import { ambientAt, hourFor, type TimeMode } from './daynight';
import { MAP_H, MAP_W, OFFICE, TILE } from './layout';
import { isWalkable } from './pathfinding';
import { DeskAllocator, SlotAllocator } from './slots';
import { AREA_IDS } from './types';
import { ACCENTS, hexToInt } from './variant';

export type CameraMode = 'fit' | 'free' | 'follow';

export interface CameraInfo {
  x: number;
  y: number;
  zoom: number;
  mode: CameraMode;
  followKey: string | null;
  viewW: number;
  viewH: number;
  canZoomIn: boolean;
  canZoomOut: boolean;
}

export interface Insets {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface SceneCallbacks {
  onSelect(key: string | null): void;
  /** Duplo clique em um personagem. */
  onActivate(key: string): void;
  onCamera(info: CameraInfo): void;
}

interface Particle {
  sprite: Sprite;
  vx: number;
  vy: number;
  life: number;
}

const WORLD_W = MAP_W * TILE;
const WORLD_H = MAP_H * TILE;
const MAX_ZOOM = 6;
/** Recém-criada no servidor: entra pela porta em vez de aparecer no lugar. */
const FRESH_MS = 20_000;

export class OfficeScene {
  private readonly app: Application;
  private readonly host: HTMLElement;
  private readonly cb: SceneCallbacks;
  private readonly art: WorldArt;
  private readonly textures = new Map<string, Texture>();
  private readonly disposables: (() => void)[] = [];

  // camadas
  private readonly world = new Container();
  private readonly wallLayer = new Container();
  private readonly floorFx = new Container();
  private readonly objects = new Container();
  private readonly fanLayer = new Container();
  private readonly lightLayer = new Container();
  private readonly topFx = new Container();
  private readonly balloons = new Container();
  private readonly overlay = new Container();
  private readonly tags = new Container();
  private readonly areaLabels = new Container();

  // personagens
  private readonly chars = new Map<string, Character>();
  private readonly slots = new SlotAllocator(OFFICE.slots);
  private readonly desks = new DeskAllocator(OFFICE.desks);
  private readonly charWorld: CharacterWorld;
  private filter: ((s: SessionState) => boolean) | null = null;
  private selectedKey: string | null = null;
  private hoverKey: string | null = null;
  private showLabels = true;

  // câmera
  private cam = { x: WORLD_W / 2, y: WORLD_H / 2, zoom: 1 };
  private mode: CameraMode = 'fit';
  private followKey: string | null = null;
  private viewW = 1;
  private viewH = 1;
  private originX = 0;
  private originY = 0;
  private insets: Insets = { left: 0, right: 0, top: 0, bottom: 0 };
  private zoomStep = 0.5;
  private wheelAcc = 0;
  private lastCameraSig = '';

  // ambiente
  private timeMode: TimeMode = 'auto';
  private fastStart = 0;
  private clockMs = 0;
  private hiddenAt = 0;
  private lastSecond = -1;
  private ledTick = 0;
  private doorFrame = 0;
  private doorTimer = 0;
  private boardFrame = 0;
  private boardTimer = 0;
  private boardIdle = 0;
  private screenTimer = 0;
  private frames = 0;
  private lastFrameAt = 0;
  private frameStart = 0;
  private frameCost = 0;
  private readonly profile = { sim: 0, draw: 0, world: 0, steps: 1 };
  private readonly tagScratch: Character[] = [];
  private readonly keptScratch: { x: number; y: number; w: number; h: number }[] = [];
  private readonly tetherDots: Sprite[] = [];
  private tetherUsed = 0;
  private fpsMark = { t: 0, frames: 0, value: 0 };

  // sprites dinâmicos
  private night!: Sprite;
  private readonly skies: { top: Sprite; grad: Sprite; stars: Sprite; clouds: TilingSprite; beam: Sprite }[] = [];
  private readonly lights: { sprite: Sprite; base: number; always: number }[] = [];
  private readonly deskGlows = new Map<number, Sprite>();
  private readonly screens = new Map<number, Sprite>();
  private readonly deskLeds = new Map<number, Sprite>();
  private readonly ledGfx = new Map<number, Graphics>();
  private readonly fans: Sprite[] = [];
  private readonly steam: Sprite[] = [];
  private clockHands!: Graphics;
  private doorSprite!: Sprite;
  private boardSprite!: Sprite;
  private tvSprite!: Sprite;
  private arcadeSprite: Sprite | null = null;
  private globeSprite!: Sprite;
  private globeAnchor: Anchor = { x: 0, y: 0, z: 0 };
  private towerLight!: Sprite;
  private waveSprite!: Sprite;
  private selection!: Sprite;
  private readonly particles: Particle[] = [];
  private cloudTexture: Texture | null = null;
  private destroyed = false;

  static async create(host: HTMLElement, cb: SceneCallbacks): Promise<OfficeScene> {
    const app = new Application();
    await app.init({
      preference: 'webgl',
      background: 0x11131b,
      antialias: false,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
      width: Math.max(1, host.clientWidth),
      height: Math.max(1, host.clientHeight),
      roundPixels: true,
      powerPreference: 'low-power',
      // Mantém o último quadro no canvas: permite capturas de tela confiáveis
      // mesmo quando o navegador reduz a taxa de quadros.
      preserveDrawingBuffer: true,
    });
    return new OfficeScene(app, host, cb);
  }

  private constructor(app: Application, host: HTMLElement, cb: SceneCallbacks) {
    this.app = app;
    this.host = host;
    this.cb = cb;
    this.art = buildWorldArt(OFFICE);
    addBalloons(this.art.atlas);

    const atlasSource = new CanvasSource({ resource: this.art.atlas.canvas, scaleMode: 'nearest' });
    for (const [name, f] of this.art.atlas.frames) {
      this.textures.set(name, new Texture({ source: atlasSource, frame: new Rectangle(f.x, f.y, f.w, f.h) }));
    }

    this.objects.sortableChildren = true;
    this.balloons.sortableChildren = true;
    this.tags.sortableChildren = true;
    this.world.addChild(
      new Sprite(new Texture({ source: new CanvasSource({ resource: this.art.base, scaleMode: 'nearest' }) })),
      this.wallLayer,
      this.floorFx,
      this.objects,
      this.fanLayer,
    );
    this.buildStatic();
    this.world.addChild(this.lightLayer, this.topFx, this.balloons);
    this.overlay.addChild(this.areaLabels, this.tags);
    app.stage.addChild(this.world, this.overlay);
    this.buildAreaLabels();
    this.areaLabels.visible = false;

    this.charWorld = {
      office: OFFICE,
      slots: this.slots,
      desks: this.desks,
      tex: (name) => this.tex(name),
      layers: { floorFx: this.floorFx, objects: this.objects, balloons: this.balloons, tags: this.tags },
      character: (key) => this.chars.get(key),
      confetti: (x, y) => this.confetti(x, y),
      resolution: () => this.app.renderer.resolution,
    };

    const canvas = app.canvas;
    canvas.style.display = 'block';
    canvas.style.touchAction = 'none';
    canvas.style.imageRendering = 'pixelated';
    host.appendChild(canvas);
    this.bindInput(canvas);
    this.bindResize();
    this.resize();
    this.fit();

    app.ticker.maxFPS = 60;
    app.ticker.add(this.tick);
    // Medição do custo de cada quadro (simulação + render), para depuração.
    app.ticker.add(() => (this.frameStart = performance.now()), undefined, UPDATE_PRIORITY.INTERACTION);
    app.ticker.add(
      () => {
        const cost = performance.now() - this.frameStart;
        this.frameCost = this.frameCost === 0 ? cost : this.frameCost * 0.9 + cost * 0.1;
      },
      undefined,
      UPDATE_PRIORITY.UTILITY,
    );
    this.applyAmbient(true);
  }

  // ───────────────────────── texturas ─────────────────────────

  private tex(name: string): Texture {
    const t = this.textures.get(name);
    if (!t) throw new Error(`textura ausente: ${name}`);
    return t;
  }

  private sprite(name: string, x: number, y: number, parent: Container, z = 0): Sprite {
    const s = new Sprite(this.tex(name));
    s.position.set(x, y);
    s.zIndex = z;
    parent.addChild(s);
    return s;
  }

  // ───────────────────────── cenário ─────────────────────────

  private buildStatic(): void {
    const art = this.art;

    // janelas: céu atrás da moldura
    const cloudCanvas = art.atlas.canvas;
    const cf = art.atlas.frames.get('cloud')!;
    const own = document.createElement('canvas');
    own.width = cf.w;
    own.height = cf.h;
    own.getContext('2d')!.drawImage(cloudCanvas, cf.x, cf.y, cf.w, cf.h, 0, 0, cf.w, cf.h);
    this.cloudTexture = new Texture({
      source: new CanvasSource({ resource: own, scaleMode: 'nearest', addressMode: 'repeat' }),
    });
    art.windows.forEach((w, i) => {
      const sx = w.x + 3;
      const sy = w.y + 3;
      const top = this.sprite('white', sx, sy, this.wallLayer);
      top.scale.set(SKY_W / 4, SKY_H / 4);
      const grad = this.sprite('skygrad', sx, sy, this.wallLayer);
      grad.scale.set(SKY_W / 2, 1);
      const stars = this.sprite('stars', sx, sy, this.wallLayer);
      if (i % 2 === 1) {
        stars.scale.x = -1;
        stars.x = sx + SKY_W;
      }
      const clouds = new TilingSprite({ texture: this.cloudTexture!, width: SKY_W, height: SKY_H });
      clouds.position.set(sx, sy);
      clouds.tilePosition.x = i * 37;
      this.wallLayer.addChild(clouds);
      this.sprite('window', w.x, w.y, this.wallLayer);
      const beam = this.sprite('beam', w.x - 4, 46, this.floorFx);
      beam.blendMode = 'add';
      this.skies.push({ top, grad, stars, clouds, beam });
    });

    for (const p of art.wall) this.sprite(p.frame, p.x, p.y, this.wallLayer);
    this.boardSprite = this.sprite('whiteboard-0', art.whiteboard.x, art.whiteboard.y, this.wallLayer);
    this.doorSprite = this.sprite('door-0', art.door.x, art.door.y, this.wallLayer);
    this.tvSprite = this.sprite('tv-0', art.tv.x, art.tv.y, this.wallLayer);
    this.clockHands = new Graphics();
    this.clockHands.position.set(art.clock.x + 7, art.clock.y + 7);
    this.wallLayer.addChild(this.clockHands);

    // seleção (no chão)
    this.selection = this.sprite('selection', 0, 0, this.floorFx);
    this.selection.anchor.set(0.5, 0.5);
    this.selection.visible = false;

    // móveis
    for (const p of art.placements) {
      const s = this.sprite(p.frame, p.x, p.y, this.objects, p.z);
      if (p.frame === 'arcade-0') this.arcadeSprite = s;
    }
    for (const [index, a] of art.screens) {
      this.screens.set(index, this.sprite('screen-0', a.x, a.y, this.objects, a.z));
    }
    for (const [index, a] of art.deskLeds) {
      const led = this.sprite('white', a.x, a.y, this.objects, a.z);
      led.scale.set(0.5, 0.25);
      led.visible = false;
      this.deskLeds.set(index, led);
    }
    for (const led of art.rackLeds) {
      if (!this.ledGfx.has(led.z)) {
        const g = new Graphics();
        g.zIndex = led.z;
        this.objects.addChild(g);
        this.ledGfx.set(led.z, g);
      }
    }
    for (const a of art.steam) {
      const s = this.sprite('steam-0', a.x, a.y, this.objects, a.z);
      s.alpha = 0.8;
      this.steam.push(s);
    }
    this.globeAnchor = art.globe;
    this.globeSprite = this.sprite('globe-0', art.globe.x, art.globe.y, this.objects, art.globe.z);
    this.towerLight = this.sprite('white', art.towerLight.x, art.towerLight.y + 1, this.objects, art.towerLight.z);
    this.towerLight.scale.set(0.5, 0.5);
    this.towerLight.tint = 0xff4a4a;
    this.waveSprite = this.sprite('wave-0', art.dishWave.x, art.dishWave.y, this.objects, art.dishWave.z);
    this.waveSprite.visible = false;

    // ventiladores de teto
    for (const f of OFFICE.fans) {
      // sombra no chão (deslocada) dá a sensação de altura
      const shadow = this.sprite('fan-0', f.x * TILE + 3, f.y * TILE + 12, this.floorFx);
      shadow.anchor.set(0.5, 0.5);
      shadow.tint = 0x000000;
      shadow.alpha = 0.13;
      this.fans.push(shadow);
      const s = this.sprite('fan-0', f.x * TILE, f.y * TILE, this.fanLayer);
      s.anchor.set(0.5, 0.5);
      s.alpha = 0.86;
      this.fans.push(s);
    }

    // noite: multiplica a cena e depois soma as luzes
    this.night = this.sprite('white', 0, 0, this.world);
    this.night.scale.set(WORLD_W / 4, WORLD_H / 4);
    this.night.blendMode = 'multiply';

    const glow = (x: number, y: number, radius: number, color: number, base: number, always = 0): Sprite => {
      const s = this.sprite('glow', x, y, this.lightLayer);
      s.anchor.set(0.5, 0.5);
      s.scale.set((radius * TILE) / 32);
      s.tint = color;
      s.blendMode = 'add';
      s.alpha = 0;
      this.lights.push({ sprite: s, base, always });
      return s;
    };
    for (const l of OFFICE.lights) glow(l.x * TILE, l.y * TILE, l.radius, l.color, 0.95);
    for (const l of art.lamps) glow(l.x, l.y + 6, 2.6, 0xffd58a, 1);
    glow(art.globe.x + 7, art.globe.y + 7, 1.6, 0x8fe8ff, 0.8, 0.35);
    glow(art.arcade.x + 8, art.arcade.y + 12, 1.4, 0x9a7aff, 0.8);
    for (const [index, a] of art.screens) {
      const s = this.sprite('glow', a.x + 5, a.y + 4, this.lightLayer);
      s.anchor.set(0.5, 0.5);
      s.scale.set(0.7);
      s.tint = 0x9fc8ff;
      s.blendMode = 'add';
      s.alpha = 0;
      this.deskGlows.set(index, s);
    }
    for (const [index, a] of art.deskLeds) {
      const s = this.sprite('glow', a.x - 4, a.y - 9, this.lightLayer);
      s.anchor.set(0.5, 0.5);
      s.scale.set(0.6);
      s.tint = 0x9fc8ff;
      s.blendMode = 'add';
      s.alpha = 0;
      this.deskGlows.set(index, s);
    }

  }

  private buildAreaLabels(): void {
    const res = this.app.renderer.resolution;
    for (const l of OFFICE.labels) {
      const c = new Container();
      const name = new Text({
        text: l.text.toUpperCase(),
        style: { fontFamily: TAG_FONT, fontSize: 10, fontWeight: '700', fill: 0xffe27a, letterSpacing: 0.5 },
      });
      const hint = new Text({
        text: l.hint,
        style: { fontFamily: TAG_FONT, fontSize: 9, fontWeight: '400', fill: 0xd5d9e6 },
      });
      name.resolution = res;
      hint.resolution = res;
      const w = Math.ceil(Math.max(name.width, hint.width)) + 12;
      const bg = new Graphics();
      bg.rect(1, 0, w - 2, 27).rect(0, 1, w, 25).fill({ color: 0x141722, alpha: 0.86 });
      bg.rect(1, 26, w - 2, 1).fill({ color: 0xffd84a, alpha: 0.95 });
      name.position.set(Math.round((w - name.width) / 2), 1);
      hint.position.set(Math.round((w - hint.width) / 2), 13);
      c.addChild(bg, name, hint);
      c.label = `${l.x},${l.y},${w}`;
      this.areaLabels.addChild(c);
    }
  }

  // ───────────────────────── sessões ─────────────────────────

  /** Estado completo (mensagem `hello`): sem desfile pela porta. */
  reset(sessions: Iterable<SessionState>): void {
    const now = Date.now();
    const seen = new Set<string>();
    const list = [...sessions].sort((a, b) => Number(Boolean(a.parentKey)) - Number(Boolean(b.parentKey)));
    for (const s of list) {
      seen.add(s.key);
      const existing = this.chars.get(s.key);
      if (existing && !existing.removing) existing.setSession(s, now);
      else this.spawn(s, 'target', now);
    }
    for (const [key, c] of this.chars) if (!seen.has(key)) c.remove();
  }

  upsert(session: SessionState): void {
    const now = Date.now();
    const existing = this.chars.get(session.key);
    if (existing && !existing.removing) {
      existing.setSession(session, now);
      this.applyFilterTo(existing);
      return;
    }
    let mode: SpawnMode = 'target';
    if (session.parentKey && this.chars.get(session.parentKey)?.visible) mode = 'parent';
    else if (session.status === 'starting' || now - session.startedAt < FRESH_MS) mode = 'door';
    this.spawn(session, mode, now);
  }

  private spawn(session: SessionState, mode: SpawnMode, now: number): void {
    if (session.status === 'ended') return;
    const old = this.chars.get(session.key);
    if (old) {
      old.destroy();
      this.chars.delete(session.key);
    }
    const c = new Character(this.charWorld, session, mode, now);
    c.selected = session.key === this.selectedKey;
    this.chars.set(session.key, c);
    this.applyFilterTo(c);
  }

  remove(key: string): void {
    this.chars.get(key)?.remove();
  }

  event(key: string, ev: NormalizedEvent): void {
    const c = this.chars.get(key);
    if (!c) return;
    const now = Date.now();
    if (ev.event === 'error') c.triggerError(ev.ts, now);
    else if (ev.event === 'prompt') c.flash('chat', now);
  }

  // ───────────────────────── opções de exibição ─────────────────────────

  setSelected(key: string | null): void {
    this.selectedKey = key;
    for (const c of this.chars.values()) c.selected = c.key === key;
    if (this.mode === 'follow' && this.followKey !== key) {
      if (key) this.followKey = key;
      else this.setMode('free');
    }
  }

  /** Personagens para os quais `visible` retorna false ficam esmaecidos. */
  setFilter(visible: ((s: SessionState) => boolean) | null): void {
    this.filter = visible;
    for (const c of this.chars.values()) this.applyFilterTo(c);
  }

  private applyFilterTo(c: Character): void {
    c.dim = this.filter ? !this.filter(c.session) : false;
  }

  setShowLabels(on: boolean): void {
    this.showLabels = on;
  }

  setShowAreas(on: boolean): void {
    this.areaLabels.visible = on;
  }

  setTimeMode(mode: TimeMode): void {
    if (mode === this.timeMode) return;
    this.timeMode = mode;
    this.fastStart = Date.now();
    this.applyAmbient(true);
  }

  setInsets(insets: Partial<Insets>): void {
    this.insets = { ...this.insets, ...insets };
  }

  // ───────────────────────── câmera ─────────────────────────

  private zoomLevels(): { min: number; max: number } {
    return { min: Math.max(this.zoomStep, 0.5), max: MAX_ZOOM };
  }

  private snapZoom(z: number): number {
    const { min, max } = this.zoomLevels();
    const snapped = Math.round(z / this.zoomStep) * this.zoomStep;
    return Math.min(max, Math.max(min, Number(snapped.toFixed(4))));
  }

  private fitZoom(): number {
    const { min } = this.zoomLevels();
    // Tolera cortar meio tile da parede externa de cada lado.
    const zx = this.viewW / (WORLD_W - TILE);
    const zy = this.viewH / (WORLD_H - TILE);
    const z = Math.floor(Math.min(zx, zy) / this.zoomStep + 1e-6) * this.zoomStep;
    return Math.max(min, Math.min(MAX_ZOOM, Number(z.toFixed(4))));
  }

  fit(): void {
    this.cam.zoom = this.fitZoom();
    this.cam.x = WORLD_W / 2;
    this.cam.y = WORLD_H / 2;
    this.setMode('fit');
    this.applyCamera();
  }

  focusOn(key: string): void {
    const c = this.chars.get(key);
    if (!c) return;
    this.followKey = key;
    const wanted = Math.min(3, this.fitZoom() + 1);
    if (this.cam.zoom < wanted) this.cam.zoom = this.snapZoom(wanted);
    this.setMode('follow');
  }

  zoomBy(steps: number, sx?: number, sy?: number): void {
    this.setZoom(this.cam.zoom + steps * this.zoomStep, sx, sy);
  }

  setZoom(zoom: number, sx?: number, sy?: number): void {
    const next = this.snapZoom(zoom);
    if (next === this.cam.zoom) return;
    const center = this.screenCenter();
    const px = sx ?? center.x;
    const py = sy ?? center.y;
    if (this.mode !== 'follow') {
      // mantém fixo o ponto do mundo sob o cursor
      const wx = this.cam.x + (px - center.x) / this.cam.zoom;
      const wy = this.cam.y + (py - center.y) / this.cam.zoom;
      this.cam.x = wx - (px - center.x) / next;
      this.cam.y = wy - (py - center.y) / next;
      this.setMode('free');
    }
    this.cam.zoom = next;
    this.clampCamera();
    this.applyCamera();
  }

  private setMode(mode: CameraMode): void {
    this.mode = mode;
    if (mode !== 'follow') this.followKey = null;
  }

  private screenCenter(): { x: number; y: number } {
    if (this.mode !== 'follow') return { x: this.viewW / 2, y: this.viewH / 2 };
    return {
      x: this.insets.left + (this.viewW - this.insets.left - this.insets.right) / 2,
      y: this.insets.top + (this.viewH - this.insets.top - this.insets.bottom) / 2,
    };
  }

  private clampCamera(): void {
    const halfW = this.viewW / this.cam.zoom / 2;
    const halfH = this.viewH / this.cam.zoom / 2;
    const slack = 64;
    const clampAxis = (v: number, half: number, size: number): number => {
      if (half * 2 >= size) {
        const range = half - size / 2 + slack;
        return Math.min(size / 2 + range, Math.max(size / 2 - range, v));
      }
      return Math.min(size - half + slack, Math.max(half - slack, v));
    };
    this.cam.x = clampAxis(this.cam.x, halfW, WORLD_W);
    this.cam.y = clampAxis(this.cam.y, halfH, WORLD_H);
  }

  private applyCamera(): void {
    const res = this.app.renderer.resolution;
    const z = this.cam.zoom;
    const c = this.screenCenter();
    this.originX = Math.round((c.x - this.cam.x * z) * res) / res;
    this.originY = Math.round((c.y - this.cam.y * z) * res) / res;
    this.world.scale.set(z);
    this.world.position.set(this.originX, this.originY);
    const info = this.cameraInfo();
    const sig = `${info.zoom}|${info.mode}|${info.followKey}|${info.canZoomIn}|${info.canZoomOut}`;
    if (sig !== this.lastCameraSig) {
      this.lastCameraSig = sig;
      this.cb.onCamera(info);
    }
  }

  cameraInfo(): CameraInfo {
    const { min, max } = this.zoomLevels();
    return {
      x: Math.round(this.cam.x),
      y: Math.round(this.cam.y),
      zoom: this.cam.zoom,
      mode: this.mode,
      followKey: this.followKey,
      viewW: this.viewW,
      viewH: this.viewH,
      canZoomIn: this.cam.zoom < max,
      canZoomOut: this.cam.zoom > min,
    };
  }

  private updateCamera(dtMs: number): void {
    if (this.mode === 'follow') {
      const c = this.followKey ? this.chars.get(this.followKey) : undefined;
      if (!c || c.dead) {
        this.setMode('free');
      } else if (c.visible) {
        const k = 1 - Math.exp(-dtMs / 140);
        this.cam.x += (c.x - this.cam.x) * k;
        this.cam.y += (c.y - 12 - this.cam.y) * k;
      }
    }
    this.applyCamera();
  }

  // ───────────────────────── entrada ─────────────────────────

  private toWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: (sx - this.originX) / this.cam.zoom, y: (sy - this.originY) / this.cam.zoom };
  }

  private pick(sx: number, sy: number): Character | null {
    const w = this.toWorld(sx, sy);
    let best: Character | null = null;
    for (const c of this.chars.values()) {
      if (!c.hit(w.x, w.y)) continue;
      if (!best || c.y > best.y || (best.dim && !c.dim)) best = c;
    }
    return best;
  }

  private bindInput(canvas: HTMLCanvasElement): void {
    let down: { x: number; y: number; camX: number; camY: number; id: number } | null = null;
    let dragging = false;
    const local = (e: MouseEvent): { x: number; y: number } => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const setHover = (key: string | null): void => {
      if (key === this.hoverKey) return;
      const prev = this.hoverKey ? this.chars.get(this.hoverKey) : undefined;
      if (prev) prev.hovered = false;
      this.hoverKey = key;
      const next = key ? this.chars.get(key) : undefined;
      if (next) next.hovered = true;
    };

    const onDown = (e: PointerEvent): void => {
      if (e.button !== 0) return;
      const p = local(e);
      down = { x: p.x, y: p.y, camX: this.cam.x, camY: this.cam.y, id: e.pointerId };
      dragging = false;
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* ponteiro sintético ou já liberado */
      }
    };
    const onMove = (e: PointerEvent): void => {
      const p = local(e);
      if (down && e.pointerId === down.id) {
        const dx = p.x - down.x;
        const dy = p.y - down.y;
        if (!dragging && Math.hypot(dx, dy) > 4) {
          dragging = true;
          this.setMode('free');
          canvas.style.cursor = 'grabbing';
        }
        if (dragging) {
          this.cam.x = down.camX - dx / this.cam.zoom;
          this.cam.y = down.camY - dy / this.cam.zoom;
          this.clampCamera();
          this.applyCamera();
        }
        return;
      }
      const c = this.pick(p.x, p.y);
      setHover(c ? c.key : null);
      canvas.style.cursor = c ? 'pointer' : 'grab';
    };
    const onUp = (e: PointerEvent): void => {
      if (!down || e.pointerId !== down.id) return;
      const wasDragging = dragging;
      down = null;
      dragging = false;
      try {
        if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* nada a liberar */
      }
      canvas.style.cursor = 'grab';
      if (wasDragging || e.type === 'pointercancel') return;
      const p = local(e);
      const c = this.pick(p.x, p.y);
      this.cb.onSelect(c ? c.key : null);
    };
    const onLeave = (): void => {
      if (!down) setHover(null);
    };
    const onDouble = (e: MouseEvent): void => {
      const p = local(e);
      const c = this.pick(p.x, p.y);
      if (c) this.cb.onActivate(c.key);
      else this.fit();
    };
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
      this.wheelAcc += e.deltaY * unit;
      const threshold = e.ctrlKey ? 12 : 60;
      const p = local(e);
      let steps = 0;
      while (this.wheelAcc <= -threshold) {
        this.wheelAcc += threshold;
        steps++;
      }
      while (this.wheelAcc >= threshold) {
        this.wheelAcc -= threshold;
        steps--;
      }
      if (steps !== 0) this.zoomBy(Math.max(-3, Math.min(3, steps)), p.x, p.y);
    };

    canvas.style.cursor = 'grab';
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('dblclick', onDouble);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    this.disposables.push(() => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('dblclick', onDouble);
      canvas.removeEventListener('wheel', onWheel);
    });
  }

  private bindResize(): void {
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(this.host);
    this.disposables.push(() => ro.disconnect());

    // Mudança de devicePixelRatio (trocar de monitor, zoom do navegador).
    let mq: MediaQueryList | null = null;
    const onDpr = (): void => {
      mq?.removeEventListener('change', onDpr);
      mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      mq.addEventListener('change', onDpr);
      this.resize();
    };
    onDpr();
    this.disposables.push(() => mq?.removeEventListener('change', onDpr));

    const onVisibility = (): void => {
      if (document.hidden) {
        this.hiddenAt = Date.now();
        this.app.ticker.stop();
      } else {
        const away = this.hiddenAt ? Date.now() - this.hiddenAt : 0;
        this.hiddenAt = 0;
        if (away > 1500) this.catchUp();
        this.app.ticker.start();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    this.disposables.push(() => document.removeEventListener('visibilitychange', onVisibility));
    if (document.hidden) onVisibility();

    // Rede de segurança: alguns navegadores embutidos reduzem muito o
    // requestAnimationFrame / ResizeObserver sem marcar a página como oculta.
    // Nesse caso um temporizador mantém a cena viva (poucos quadros por segundo).
    const watchdog = window.setInterval(() => {
      if (this.destroyed || document.hidden) return;
      this.resize();
      if (performance.now() - this.lastFrameAt > 300) this.app.ticker.update();
    }, 220);
    this.disposables.push(() => window.clearInterval(watchdog));
  }

  /** Depois de um tempo com a aba oculta: todo mundo aparece onde deveria estar. */
  private catchUp(): void {
    const now = Date.now();
    for (const c of this.chars.values()) c.snapToTarget(now);
  }

  private resize(): void {
    if (this.destroyed) return;
    const w = Math.max(1, Math.floor(this.host.clientWidth));
    const h = Math.max(1, Math.floor(this.host.clientHeight));
    const dpr = window.devicePixelRatio || 1;
    const sizeChanged = w !== this.viewW || h !== this.viewH;
    const resChanged = dpr !== this.app.renderer.resolution;
    if (!sizeChanged && !resChanged) return;
    this.viewW = w;
    this.viewH = h;
    this.app.renderer.resize(w, h, dpr);
    this.zoomStep = dpr >= 1.5 ? 1 / Math.round(dpr) : 0.5;
    if (resChanged) {
      for (const c of this.chars.values()) c.setResolution(dpr);
      for (const child of this.areaLabels.children) {
        for (const part of (child as Container).children) {
          if (part instanceof Text) part.resolution = dpr;
        }
      }
    }
    if (this.mode === 'fit') this.fit();
    else {
      this.cam.zoom = this.snapZoom(this.cam.zoom);
      this.clampCamera();
      this.applyCamera();
    }
  }

  // ───────────────────────── laço principal ─────────────────────────

  private readonly tick = (ticker: Ticker): void => {
    if (this.destroyed) return;
    // Tempo real decorrido: se o navegador reduzir os quadros (aba em segundo
    // plano), a simulação continua no ritmo certo, em passos pequenos.
    const dt = Math.min(1500, Math.max(0, ticker.elapsedMS));
    const now = Date.now();
    this.clockMs += dt;
    this.frames++;
    this.lastFrameAt = performance.now();

    const steps = Math.max(1, Math.ceil(dt / 48));
    const stepMs = dt / steps;
    for (let i = 1; i <= steps; i++) {
      const stepNow = now - (steps - i) * stepMs;
      for (const c of this.chars.values()) c.update(stepMs, stepNow);
    }

    this.updateCamera(dt);
    const view: FrameView = {
      zoom: this.cam.zoom,
      showLabels: this.showLabels,
      originX: this.originX,
      originY: this.originY,
    };

    const t1 = performance.now();
    for (const [key, c] of this.chars) {
      if (c.dead) {
        c.destroy();
        this.chars.delete(key);
        if (this.hoverKey === key) this.hoverKey = null;
        continue;
      }
      c.draw(now, view);
    }
    this.declutterTags();

    const t2 = performance.now();
    this.updateSelection();
    this.updateTethers();
    this.updateParticles(dt);
    this.updateAmbient(dt, now);
    if (this.areaLabels.visible) this.updateAreaLabels();
    const t3 = performance.now();
    const p = this.profile;
    p.sim = p.sim * 0.9 + (t1 - this.lastFrameAt) * 0.1;
    p.draw = p.draw * 0.9 + (t2 - t1) * 0.1;
    p.world = p.world * 0.9 + (t3 - t2) * 0.1;
    p.steps = steps;
  };

  /**
   * Evita etiquetas sobrepostas: quando duas colidem, fica a de maior
   * prioridade (selecionado > pedindo atenção > sessão principal > subagente).
   */
  private declutterTags(): void {
    const list = this.tagScratch;
    list.length = 0;
    for (const c of this.chars.values()) if (c.tagBox) list.push(c);
    if (list.length < 2) return;
    list.sort((a, b) => b.tagPriority - a.tagPriority);
    const kept = this.keptScratch;
    kept.length = 0;
    for (const c of list) {
      const box = c.tagBox!;
      let hidden = false;
      if (c.tagPriority < 4) {
        for (const k of kept) {
          if (box.x < k.x + k.w + 1 && box.x + box.w + 1 > k.x && box.y < k.y + k.h + 1 && box.y + box.h + 1 > k.y) {
            hidden = true;
            break;
          }
        }
      }
      if (hidden) c.hideTag();
      else kept.push(box);
    }
  }

  private updateSelection(): void {
    const c = this.selectedKey ? this.chars.get(this.selectedKey) : undefined;
    if (!c || !c.visible) {
      this.selection.visible = false;
      return;
    }
    this.selection.visible = true;
    this.selection.position.set(Math.round(c.x), Math.round(c.y) - 2);
    this.selection.alpha = 0.75 + Math.sin(this.clockMs / 260) * 0.25;
  }

  private updateTethers(): void {
    let used = 0;
    const dots = this.tetherDots;
    for (const c of this.chars.values()) {
      const parentKey = c.session.parentKey;
      if (!parentKey || !c.visible || c.dim) continue;
      const p = this.chars.get(parentKey);
      if (!p || !p.visible) continue;
      const strong =
        c.selected || p.selected || c.hovered || p.hovered || this.selectedKey === parentKey || this.hoverKey === parentKey;
      const x0 = c.x;
      const y0 = c.y - 7;
      const x1 = p.x;
      const y1 = p.y - 10;
      const len = Math.hypot(x1 - x0, y1 - y0);
      if (len < 12) continue;
      // Pontilhado que "anda" do subagente para o pai; no máximo ~48 pontos por linha.
      const gap = Math.max(strong ? 3 : 4, len / 48);
      const offset = (this.clockMs / 90) % gap;
      const alpha = (strong ? 0.95 : 0.5) * Math.min(c.alpha, p.alpha);
      for (let d = 6 + offset; d < len - 6; d += gap) {
        const t = d / len;
        let dot = dots[used];
        if (!dot) {
          dot = new Sprite(this.tex('white'));
          dot.scale.set(0.25);
          this.topFx.addChild(dot);
          dots.push(dot);
        }
        used++;
        dot.visible = true;
        dot.position.set(Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t));
        dot.tint = c.pipColor;
        dot.alpha = alpha;
      }
    }
    for (let i = used; i < this.tetherUsed; i++) dots[i]!.visible = false;
    this.tetherUsed = used;
  }

  private confetti(x: number, y: number): void {
    for (let i = 0; i < 14; i++) {
      const sprite = new Sprite(this.tex('white'));
      sprite.scale.set(i % 3 === 0 ? 0.5 : 0.25);
      sprite.tint = hexToInt(ACCENTS[(i * 3) % ACCENTS.length]!);
      sprite.position.set(x, y);
      this.topFx.addChild(sprite);
      const a = (i / 14) * Math.PI * 2;
      this.particles.push({
        sprite,
        vx: Math.cos(a) * (18 + (i % 4) * 7),
        vy: -38 - (i % 5) * 9,
        life: 900 + (i % 3) * 160,
      });
    }
  }

  private updateParticles(dt: number): void {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]!;
      p.life -= dt;
      if (p.life <= 0) {
        p.sprite.destroy();
        this.particles.splice(i, 1);
        continue;
      }
      p.vy += 130 * (dt / 1000);
      p.sprite.x += p.vx * (dt / 1000);
      p.sprite.y += p.vy * (dt / 1000);
      p.sprite.alpha = Math.min(1, p.life / 300);
    }
  }

  private updateAreaLabels(): void {
    const z = this.cam.zoom;
    for (const child of this.areaLabels.children) {
      const [x, y, w] = child.label.split(',').map(Number) as [number, number, number];
      child.position.set(
        Math.round(this.originX + x * TILE * z - w / 2),
        Math.round(this.originY + y * TILE * z - 13),
      );
    }
  }

  // ───────────────────────── ambiente ─────────────────────────

  private currentHour(): number {
    return hourFor(this.timeMode, new Date(), Date.now() - this.fastStart);
  }

  private lastAmbientSig = '';

  private applyAmbient(force = false): number {
    const amb = ambientAt(this.currentHour());
    const sig = `${amb.tint}|${amb.skyTop}|${amb.skyBottom}|${amb.night.toFixed(2)}`;
    if (!force && sig === this.lastAmbientSig) return amb.night;
    this.lastAmbientSig = sig;
    this.night.tint = amb.tint;
    this.night.visible = amb.tint !== 0xffffff;
    const day = 1 - amb.night;
    for (const s of this.skies) {
      s.top.tint = amb.skyTop;
      s.grad.tint = amb.skyBottom;
      s.stars.alpha = Math.max(0, amb.night * 1.2 - 0.2);
      s.clouds.alpha = 0.25 + day * 0.65;
      s.clouds.tint = amb.night > 0.5 ? 0x8f9ac8 : 0xffffff;
      s.beam.alpha = day * 0.42;
    }
    for (const l of this.lights) l.sprite.alpha = Math.min(1, l.always + amb.night * l.base);
    return amb.night;
  }

  private updateAmbient(dt: number, now: number): void {
    const t = this.clockMs;
    const night = this.applyAmbient();

    // nuvens passando
    for (const s of this.skies) s.clouds.tilePosition.x = Math.floor((t / 900 + s.clouds.x) % 96);

    // relógio de parede (hora real)
    const date = new Date(now);
    const sec = date.getSeconds();
    if (sec !== this.lastSecond) {
      this.lastSecond = sec;
      this.drawClock(date);
    }

    // ventiladores
    const fanFrame = Math.floor(t / 70) % 6;
    for (const f of this.fans) f.texture = this.tex(`fan-${fanFrame}`);

    // vapor do café
    const steamFrame = Math.floor(t / 260) % 3;
    this.steam.forEach((s, i) => {
      s.texture = this.tex(`steam-${(steamFrame + i) % 3}`);
    });

    // estação web
    let webBusy = false;
    let planning = false;
    let bashing = false;
    let doorNear = false;
    const doorX = this.art.door.x + 16;
    for (const c of this.chars.values()) {
      if (!c.visible) continue;
      if (c.settled && c.activity === 'web') webBusy = true;
      if (c.settled && c.activity === 'plan') planning = true;
      if (c.settled && c.activity === 'bash') bashing = true;
      if (Math.abs(c.x - doorX) < 30 && c.y < 5 * TILE && (c.moving || c.ty <= 2)) doorNear = true;
    }
    this.globeSprite.texture = this.tex(`globe-${Math.floor(t / (webBusy ? 180 : 420)) % 4}`);
    this.globeSprite.y = this.globeAnchor.y + (Math.floor(t / 500) % 2);
    this.towerLight.visible = Math.floor(t / 600) % 2 === 0;
    this.waveSprite.visible = webBusy;
    if (webBusy) this.waveSprite.texture = this.tex(`wave-${Math.floor(t / 200) % 3}`);
    if (this.arcadeSprite) this.arcadeSprite.texture = this.tex(`arcade-${Math.floor(t / 600) % 2}`);
    this.tvSprite.texture = this.tex(`tv-${Math.floor(t / 2800) % 3}`);

    // quadro branco: vai enchendo enquanto alguém planeja
    if (planning) {
      this.boardIdle = 0;
      this.boardTimer += dt;
      if (this.boardTimer > 2200) {
        this.boardTimer = 0;
        this.boardFrame = this.boardFrame >= 3 ? 1 : this.boardFrame + 1;
      }
      if (this.boardFrame === 0) this.boardFrame = 1;
    } else {
      this.boardIdle += dt;
      if (this.boardIdle > 45_000) this.boardFrame = 0;
    }
    this.boardSprite.texture = this.tex(`whiteboard-${this.boardFrame}`);

    // porta automática
    this.doorTimer += dt;
    if (this.doorTimer > 110) {
      this.doorTimer = 0;
      const target = doorNear ? 2 : 0;
      if (this.doorFrame < target) this.doorFrame++;
      else if (this.doorFrame > target) this.doorFrame--;
      this.doorSprite.texture = this.tex(`door-${this.doorFrame}`);
    }

    // LEDs dos servidores
    const ledPeriod = bashing ? 110 : 230;
    const tick = Math.floor(t / ledPeriod);
    if (tick !== this.ledTick) {
      this.ledTick = tick;
      this.drawLeds(tick, t);
    }

    // monitores das mesas
    this.screenTimer += dt;
    if (this.screenTimer > 160) {
      this.screenTimer = 0;
      this.updateScreens(t, night);
    }
  }

  private drawClock(date: Date): void {
    const g = this.clockHands;
    g.clear();
    const plot = (angle: number, len: number, color: number): void => {
      const dx = Math.sin(angle);
      const dy = -Math.cos(angle);
      let last = '';
      for (let i = 0; i <= len * 2; i++) {
        const x = Math.round((dx * i) / 2 - 0.5);
        const y = Math.round((dy * i) / 2 - 0.5);
        const id = `${x},${y}`;
        if (id === last) continue;
        last = id;
        g.rect(x, y, 1, 1);
      }
      g.fill({ color });
    };
    const h = date.getHours() % 12;
    const m = date.getMinutes();
    const s = date.getSeconds();
    plot(((h + m / 60) / 12) * Math.PI * 2, 3, 0x2a2233);
    plot(((m + s / 60) / 60) * Math.PI * 2, 5, 0x2a2233);
    plot((s / 60) * Math.PI * 2, 5, 0xe0504a);
    g.rect(-1, -1, 2, 2).fill({ color: 0x2a2233 });
  }

  private drawLeds(tick: number, t: number): void {
    for (const g of this.ledGfx.values()) g.clear();
    const groups = new Map<number, { x: number; y: number }[][]>();
    this.art.rackLeds.forEach((led, i) => {
      let h = (i * 2654435761 + tick * 40503) >>> 0;
      h ^= h >>> 13;
      h = Math.imul(h, 0x5bd1e995) >>> 0;
      const r = h % 16;
      if (r < 5) return; // apagado
      const color = r < 12 ? 0 : r < 15 ? 1 : 2;
      let lists = groups.get(led.z);
      if (!lists) {
        lists = [[], [], []];
        groups.set(led.z, lists);
      }
      lists[color]!.push(led);
    });
    const colors = [0x5fe08a, 0xffc44a, 0xff5a5a];
    for (const [z, lists] of groups) {
      const g = this.ledGfx.get(z);
      if (!g) continue;
      lists.forEach((list, ci) => {
        if (list.length === 0) return;
        for (const led of list) g.rect(led.x, led.y, 1, 1);
        g.fill({ color: colors[ci]! });
      });
    }
    // cursor do terminal
    const crt = this.art.crt;
    const g = this.ledGfx.get(crt.z) ?? this.ledGfx.values().next().value;
    if (g && Math.floor(t / 450) % 2 === 0) g.rect(crt.x, crt.y, 2, 1).fill({ color: 0x4be07a });
  }

  private updateScreens(t: number, night: number): void {
    for (const desk of OFFICE.desks) {
      const owners = this.desks.ownersOf(desk.index);
      let state = 0; // 0 sem dono, 1 dono ausente, 2 presente, 3 digitando
      for (const key of owners) {
        const c = this.chars.get(key);
        if (!c || !c.visible) continue;
        let s = 1;
        if (c.atDesk) s = c.activity === 'type' ? 3 : 2;
        state = Math.max(state, s);
      }
      const screen = this.screens.get(desk.index);
      if (screen) {
        const frame = state === 0 ? 0 : state === 1 ? 1 : state === 2 ? 2 : 2 + (Math.floor(t / 320 + desk.index) % 3);
        screen.texture = this.tex(`screen-${frame}`);
      }
      const led = this.deskLeds.get(desk.index);
      if (led) {
        led.visible = state > 0;
        led.tint = state >= 2 ? 0x5fe08a : 0xffc44a;
      }
      const glow = this.deskGlows.get(desk.index);
      if (glow) glow.alpha = state >= 2 ? night * 0.75 : state === 1 ? night * 0.3 : 0;
    }
  }

  // ───────────────────────── depuração ─────────────────────────

  /** Posição na página (pixels CSS) do personagem — útil para automação. */
  screenOf(key: string): { x: number; y: number } | null {
    const c = this.chars.get(key);
    if (!c) return null;
    const r = this.app.canvas.getBoundingClientRect();
    return {
      x: Math.round(r.left + this.originX + c.x * this.cam.zoom),
      y: Math.round(r.top + this.originY + (c.y - 9) * this.cam.zoom),
    };
  }

  /** Quadros por segundo desde a última consulta. */
  private measureFps(): number {
    const t = performance.now();
    const m = this.fpsMark;
    const span = t - m.t;
    if (m.t > 0 && span > 200) m.value = Math.round(((this.frames - m.frames) * 1000) / span);
    if (m.t === 0 || span > 200) {
      m.t = t;
      m.frames = this.frames;
    }
    return m.value;
  }

  debugHandle(): Record<string, unknown> {
    return {
      characters: () => [...this.chars.values()].map((c) => c.debug()),
      character: (key: string) => this.chars.get(key)?.debug() ?? null,
      camera: () => this.cameraInfo(),
      screenOf: (key: string) => this.screenOf(key),
      map: {
        w: MAP_W,
        h: MAP_H,
        tile: TILE,
        areas: Object.fromEntries(
          AREA_IDS.map((a) => [a, OFFICE.slots[a].map((s) => ({ id: s.id, x: s.x, y: s.y, tag: s.tag }))]),
        ),
      },
      walkable: (x: number, y: number) => isWalkable(OFFICE, x, y),
      ambient: () => {
        const amb = ambientAt(this.currentHour());
        return { mode: this.timeMode, hour: Number(amb.hour.toFixed(2)), night: Number(amb.night.toFixed(2)) };
      },
      fps: () => this.measureFps(),
      /** Custo médio de um quadro (simulação + render), em ms. */
      frameMs: () => Number(this.frameCost.toFixed(2)),
      profile: () => ({
        simMs: Number(this.profile.sim.toFixed(2)),
        drawMs: Number(this.profile.draw.toFixed(2)),
        worldMs: Number(this.profile.world.toFixed(2)),
        frameMs: Number(this.frameCost.toFixed(2)),
        simSteps: this.profile.steps,
        tetherDots: this.tetherUsed,
      }),
      lookAt: (tileX: number, tileY: number, zoom?: number) => {
        if (zoom) this.cam.zoom = this.snapZoom(zoom);
        this.cam.x = tileX * TILE;
        this.cam.y = tileY * TILE;
        this.setMode('free');
        this.clampCamera();
        this.applyCamera();
      },
      renderer: () => this.app.renderer.name,
      resolution: () => this.app.renderer.resolution,
      fit: () => this.fit(),
      focus: (key: string) => this.focusOn(key),
      setZoom: (z: number) => this.setZoom(z),
      setTimeMode: (m: TimeMode) => this.setTimeMode(m),
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const d of this.disposables) d();
    this.app.ticker.remove(this.tick);
    for (const c of this.chars.values()) c.destroy();
    this.chars.clear();
    destroyAllSheets();
    this.cloudTexture?.destroy(true);
    const canvas = this.app.canvas;
    this.app.destroy(true, { children: true, texture: true, textureSource: true });
    canvas.remove();
  }
}
