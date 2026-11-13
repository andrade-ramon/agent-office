import { accentColor, bodyColor, skinColor, type Variant } from '../variant';
import { OUTLINE, Painter, makeCanvas, outlineRegion, shade } from './painter';

/**
 * Sprites procedurais dos personagens.
 *
 *  - Claude: capuz arredondado em tons quentes, rosto claro e uma crista em
 *    forma de faísca no topo.
 *  - Codex: robô de cabeça quadrada em tons frios, visor escuro com olhos
 *    luminosos e antena.
 *
 * Cada pose é desenhada sob demanda a partir de parâmetros (direção, pernas,
 * braços, olhos, objeto na mão).
 */

export type SpriteDir = 'down' | 'up' | 'side';
export type LegPose = 'stand' | 'walkA' | 'walkB' | 'sit';
export type ArmPose =
  | 'down'
  | 'swingA'
  | 'swingB'
  | 'typeA'
  | 'typeB'
  | 'workA'
  | 'workB'
  | 'chin'
  | 'waveA'
  | 'waveB'
  | 'cheerA'
  | 'cheerB'
  | 'head'
  | 'hold';
export type EyePose = 'open' | 'closed' | 'happy' | 'x';
export type ItemPose = 'none' | 'book' | 'cup';

export interface Pose {
  dir: SpriteDir;
  legs: LegPose;
  arms: ArmPose;
  eyes: EyePose;
  item: ItemPose;
}

export const FRAME_W = 22;
export const FRAME_H = 30;
/** Ponto dos pés dentro do quadro. */
export const PIVOT_X = 11;
export const PIVOT_Y = 28;

export function poseKey(p: Pose): string {
  return `${p.dir}|${p.legs}|${p.arms}|${p.eyes}|${p.item}`;
}

interface Build {
  headW: number;
  headH: number;
  torsoW: number;
  torsoH: number;
  armW: number;
  legH: number;
  legW: number;
}

const ADULT: Build = { headW: 10, headH: 8, torsoW: 6, torsoH: 6, armW: 2, legH: 4, legW: 2 };
const SMALL: Build = { headW: 8, headH: 7, torsoW: 4, torsoH: 4, armW: 1, legH: 2, legW: 1 };

/** Altura aproximada do sprite em pé (para balões, etiquetas e clique). */
export function spriteHeight(v: Variant): number {
  const b = v.small ? SMALL : ADULT;
  return b.headH + b.torsoH + b.legH + (v.small ? 3 : 4);
}

interface Colors {
  body: string;
  bodyHi: string;
  bodyLo: string;
  sleeve: string;
  hand: string;
  skin: string;
  skinLo: string;
  accent: string;
  accentHi: string;
  legs: string;
  legsFar: string;
  shoes: string;
  eye: string;
  detail: string;
}

function colorsFor(v: Variant): Colors {
  const body = bodyColor(v);
  const accent = accentColor(v);
  if (v.agent === 'claude') {
    const skin = skinColor(v);
    return {
      body,
      bodyHi: shade(body, 0.22),
      bodyLo: shade(body, -0.2),
      sleeve: shade(body, -0.1),
      hand: skin,
      skin,
      skinLo: shade(skin, -0.16),
      accent,
      accentHi: shade(accent, 0.4),
      legs: '#54465e',
      legsFar: '#43384c',
      shoes: '#2f2a38',
      eye: '#33242c',
      detail: '#fff1d2',
    };
  }
  return {
    body,
    bodyHi: shade(body, 0.28),
    bodyLo: shade(body, -0.24),
    sleeve: '#9aa5b6',
    hand: '#d3dae4',
    skin: '#141b2a',
    skinLo: '#0c111c',
    accent,
    accentHi: shade(accent, 0.45),
    legs: '#6b768a',
    legsFar: '#556072',
    shoes: '#343b4b',
    eye: accent,
    detail: '#141b2a',
  };
}

/** Desenha uma pose; a origem do pincel é o canto do quadro (22×30). */
export function drawCharacter(p: Painter, v: Variant, pose: Pose): void {
  const b = v.small ? SMALL : ADULT;
  const c = colorsFor(v);
  const cx = PIVOT_X;
  const base = PIVOT_Y;
  const sit = pose.legs === 'sit';
  const legH = sit ? Math.min(2, b.legH) : b.legH;
  const torsoTop = base - legH - b.torsoH;
  const headTop = torsoTop - b.headH;
  if (pose.dir === 'side') drawSide(p, v, b, c, pose, cx, base, legH, torsoTop, headTop);
  else drawFrontBack(p, v, b, c, pose, cx, base, legH, torsoTop, headTop);
}

function drawFrontBack(
  p: Painter,
  v: Variant,
  b: Build,
  c: Colors,
  pose: Pose,
  cx: number,
  base: number,
  legH: number,
  torsoTop: number,
  headTop: number,
): void {
  const back = pose.dir === 'up';
  const claude = v.agent === 'claude';
  const tw = b.torsoW;
  const th = b.torsoH;
  const tx = cx - tw / 2;
  const aw = b.armW;
  const xL = tx - aw;
  const xR = tx + tw;

  // ── pernas ──
  const legL = tx;
  const legR = tx + tw - b.legW;
  const drawLeg = (x: number, h: number): void => {
    if (h <= 0) return;
    p.rect(x, base - legH, b.legW, h, c.legs);
    p.rect(x, base - legH + h - 1, b.legW, 1, c.shoes);
  };
  if (pose.legs === 'sit') {
    if (!back) {
      drawLeg(legL, legH);
      drawLeg(legR, legH);
    } else {
      p.rect(legL, base - legH, b.legW, legH, c.legs);
      p.rect(legR, base - legH, b.legW, legH, c.legs);
    }
  } else {
    drawLeg(legL, pose.legs === 'walkA' ? legH - 1 : legH);
    drawLeg(legR, pose.legs === 'walkB' ? legH - 1 : legH);
  }

  // ── tronco ──
  p.rect(tx, torsoTop, tw, th, c.body);
  p.rect(tx + tw - 1, torsoTop, 1, th, c.bodyLo);
  p.rect(tx, torsoTop + th - 1, tw, 1, c.bodyLo);
  if (claude) {
    if (b.torsoW >= 6) {
      // faísca no peito / nas costas
      p.rect(cx - 1, torsoTop + 1, 2, 2, c.detail);
      if (!back) p.px(cx - 2, torsoTop + 2, c.bodyHi).px(cx + 1, torsoTop + 1, c.bodyHi);
    } else {
      p.rect(cx - 1, torsoTop + 1, 2, 1, c.detail);
    }
  } else if (b.torsoW >= 6) {
    if (back) {
      p.rect(cx - 2, torsoTop + 1, 4, 3, c.bodyLo).px(cx - 1, torsoTop + 2, c.sleeve).px(cx, torsoTop + 2, c.sleeve);
    } else {
      p.rect(cx - 2, torsoTop + 1, 4, 2, c.detail).px(cx - 1, torsoTop + 1, c.accent).rect(cx, torsoTop + 2, 2, 1, c.accent);
    }
  } else {
    p.rect(cx - 1, torsoTop + 1, 2, 1, back ? c.bodyLo : c.accent);
  }

  // ── cabeça ──
  drawHead(p, v, b, c, pose, cx, headTop, back ? 'up' : 'down');

  // ── braços ──
  const arm = (x: number, y0: number, len: number, handAtTop: boolean): void => {
    if (len <= 0) return;
    p.rect(x, y0, aw, len, c.sleeve);
    p.rect(x, handAtTop ? y0 : y0 + len - 1, aw, 1, c.hand);
  };
  const armsDown = (dl: number, dr: number): void => {
    arm(xL, torsoTop, th - 1 + dl, false);
    arm(xR, torsoTop, th - 1 + dr, false);
  };
  const raised = (x: number, top: number): void => arm(x, top, torsoTop + 2 - top, true);

  switch (pose.arms) {
    case 'swingA':
      armsDown(-1, 0);
      break;
    case 'swingB':
      armsDown(0, -1);
      break;
    case 'typeA':
    case 'typeB': {
      const a = pose.arms === 'typeA';
      const base3 = Math.max(2, th - 2);
      arm(xL, torsoTop, a ? base3 : base3 - 1, false);
      arm(xR, torsoTop, a ? base3 - 1 : base3, false);
      break;
    }
    case 'workA':
    case 'workB': {
      const a = pose.arms === 'workA';
      raised(xL, torsoTop - (a ? 3 : 1));
      raised(xR, torsoTop - (a ? 1 : 3));
      break;
    }
    case 'chin':
      arm(xL, torsoTop, th - 1, false);
      if (back) {
        arm(xR, torsoTop, Math.max(2, th - 3), false);
      } else {
        p.rect(xR, torsoTop + 1, aw, 2, c.sleeve);
        p.rect(xR - 1, torsoTop, aw, 1, c.sleeve);
        p.rect(xR - 2, torsoTop - 1, 2, 1, c.hand);
      }
      break;
    case 'waveA':
      arm(xL, torsoTop, th - 1, false);
      raised(xR, torsoTop - 3);
      break;
    case 'waveB':
      arm(xL, torsoTop, th - 1, false);
      p.rect(xR, torsoTop - 1, aw, 3, c.sleeve);
      p.rect(xR + 1, torsoTop - 2, aw, 1, c.sleeve);
      p.rect(xR + 2, torsoTop - 3, aw, 1, c.hand);
      break;
    case 'cheerA':
      p.rect(xL - 1, torsoTop - 3, aw, 5, c.sleeve).rect(xL - 1, torsoTop - 4, aw, 1, c.hand);
      p.rect(xR + 1, torsoTop - 3, aw, 5, c.sleeve).rect(xR + 1, torsoTop - 4, aw, 1, c.hand);
      break;
    case 'cheerB':
      p.rect(xL, torsoTop, aw, 2, c.sleeve).rect(xL - 1, torsoTop - 1, aw, 1, c.sleeve);
      p.rect(xL - 2, torsoTop - 2, aw, 1, c.sleeve).rect(xL - 3, torsoTop - 3, aw, 1, c.hand);
      p.rect(xR, torsoTop, aw, 2, c.sleeve).rect(xR + 1, torsoTop - 1, aw, 1, c.sleeve);
      p.rect(xR + 2, torsoTop - 2, aw, 1, c.sleeve).rect(xR + 3, torsoTop - 3, aw, 1, c.hand);
      break;
    case 'head':
      p.rect(xL - 1, torsoTop - 2, aw, 4, c.sleeve).rect(xL - 1, torsoTop - 4, aw + 1, 2, c.hand);
      p.rect(xR + 1, torsoTop - 2, aw, 4, c.sleeve).rect(xR, torsoTop - 4, aw + 1, 2, c.hand);
      break;
    case 'hold': {
      const len = Math.max(2, th - 3);
      p.rect(xL, torsoTop, aw, len, c.sleeve);
      p.rect(xR, torsoTop, aw, len, c.sleeve);
      if (!back) {
        p.rect(xL + 1, torsoTop + len, aw, 1, c.hand);
        p.rect(xR - 1, torsoTop + len, aw, 1, c.hand);
        drawItem(p, pose.item, cx, torsoTop + (b.torsoW >= 6 ? 1 : 0), b.torsoW >= 6);
      } else {
        p.rect(xL, torsoTop + len - 1, aw, 1, c.hand);
        p.rect(xR, torsoTop + len - 1, aw, 1, c.hand);
      }
      break;
    }
    default:
      armsDown(0, 0);
  }
}

function drawItem(p: Painter, item: ItemPose, cx: number, y: number, big: boolean): void {
  if (item === 'book') {
    const w = big ? 8 : 6;
    const x = cx - w / 2;
    p.rect(x, y, w, big ? 4 : 3, '#3f6fb0');
    p.rect(x + 1, y, w - 2, big ? 3 : 2, '#f6f2e6');
    p.rect(cx - 1, y, 1, big ? 3 : 2, '#b8b2a2');
    p.px(x + 2, y + 1, '#b8b2a2').px(cx + 1, y + 1, '#b8b2a2');
  } else if (item === 'cup') {
    p.rect(cx - 2, y + 1, 3, 3, '#f4f1e8');
    p.rect(cx - 2, y + 1, 3, 1, '#6a4028');
    p.px(cx + 1, y + 2, '#f4f1e8');
  }
}

function drawHead(
  p: Painter,
  v: Variant,
  b: Build,
  c: Colors,
  pose: Pose,
  cx: number,
  headTop: number,
  dir: SpriteDir,
): void {
  const hw = b.headW;
  const hh = b.headH;
  const x0 = cx - hw / 2;
  const big = hw >= 10;

  if (v.agent === 'claude') {
    // capuz arredondado
    p.rect(x0 + 2, headTop, hw - 4, 1, c.bodyHi);
    p.rect(x0 + 1, headTop + 1, hw - 2, 1, c.body);
    p.rect(x0, headTop + 2, hw, hh - 3, c.body);
    p.rect(x0 + 1, headTop + hh - 1, hw - 2, 1, c.bodyLo);
    p.rect(x0 + hw - 1, headTop + 2, 1, hh - 3, c.bodyLo);
    p.rect(x0 + 2, headTop + 1, 2, 1, c.bodyHi);

    if (dir === 'down') {
      p.rect(x0 + 1, headTop + 3, hw - 2, hh - 4, c.skin);
      p.rect(x0 + 2, headTop + hh - 1, hw - 4, 1, c.skinLo);
      const ey = headTop + 4;
      const eL = x0 + 2;
      const eR = x0 + hw - 3;
      drawEyes(p, pose.eyes, eL, eR, ey, big, c.eye, false);
      // bochechas e boca
      if (big) p.px(x0 + 1, ey + 2, shade(c.skin, -0.12)).px(x0 + hw - 2, ey + 2, shade(c.skin, -0.12));
      if (pose.eyes === 'happy') p.rect(cx - 1, ey + 2, 2, 1, c.eye);
      else if (pose.eyes === 'x') p.rect(cx - 1, ey + 2, 2, 1, '#8a3038');
    } else if (dir === 'side') {
      const fw = Math.floor(hw / 2) + 1;
      p.rect(x0, headTop + 3, fw, hh - 4, c.skin);
      p.rect(x0 + 1, headTop + hh - 1, fw - 1, 1, c.skinLo);
      const ey = headTop + 4;
      if (pose.eyes === 'closed' || pose.eyes === 'happy') p.rect(x0 + 1, ey + 1, 2, 1, c.eye);
      else if (pose.eyes === 'x') p.rect(x0 + 1, ey, 2, 2, c.eye);
      else p.rect(x0 + 2, ey, 1, big ? 2 : 1, c.eye);
      if (big) p.px(x0 + 3, ey + 2, shade(c.skin, -0.12));
    } else {
      // costas: costura do capuz
      p.rect(cx - 1, headTop + 2, 1, hh - 3, c.bodyLo);
    }

    // crista em forma de faísca
    const top = headTop;
    const a = c.accent;
    const ah = c.accentHi;
    if (v.style === 0) {
      p.rect(cx - 3, top - 1, 6, 1, a);
      p.px(cx - 3, top - 2, a).rect(cx - 1, top - 2, 2, 1, ah).px(cx + 2, top - 2, a);
      if (big) p.rect(cx - 1, top - 3, 2, 1, a);
    } else if (v.style === 1) {
      p.rect(cx - 2, top - 1, 5, 1, a);
      p.rect(cx, top - 2, 3, 1, ah);
      if (big) p.rect(cx + 1, top - 3, 2, 1, a);
    } else {
      p.rect(cx - 2, top - 1, 4, 1, a);
      p.rect(cx - 1, top - 2, 2, 1, ah);
      if (big) p.px(cx - 3, top - 2, a).px(cx + 2, top - 2, a).rect(cx - 1, top - 3, 2, 1, a);
    }
    return;
  }

  // ── Codex: cabeça quadrada de robô ──
  p.rect(x0, headTop, hw, hh, c.body);
  p.rect(x0, headTop, hw, 1, c.bodyHi);
  p.rect(x0, headTop + hh - 1, hw, 1, c.bodyLo);
  p.rect(x0 + hw - 1, headTop + 1, 1, hh - 1, c.bodyLo);
  const vy = headTop + 2;
  const vh = hh - 4;
  if (dir === 'down') {
    p.rect(x0 + 1, vy, hw - 2, vh, c.skin);
    p.rect(x0 + 1, vy, hw - 2, 1, c.skinLo);
    drawEyes(p, pose.eyes, x0 + 2, x0 + hw - (big ? 4 : 3), vy + 1, big, c.eye, true);
    p.rect(x0 - 1, vy + 1, 1, 2, c.sleeve).rect(x0 + hw, vy + 1, 1, 2, c.sleeve);
  } else if (dir === 'side') {
    const fw = Math.floor(hw / 2) + 1;
    p.rect(x0, vy, fw, vh, c.skin);
    const col = pose.eyes === 'x' ? '#ff5a5a' : c.eye;
    if (pose.eyes === 'closed' || pose.eyes === 'happy') p.rect(x0 + 1, vy + 2, 2, 1, shade(col, -0.25));
    else p.rect(x0 + 1, vy + 1, big ? 2 : 1, 2, col);
    p.rect(x0 + hw - 4, vy + 1, 2, 2, c.sleeve).px(x0 + hw - 4, vy + 1, c.hand);
  } else {
    p.rect(x0 + 2, vy, hw - 4, 1, c.bodyLo).rect(x0 + 2, vy + 2, hw - 4, 1, c.bodyLo);
    p.rect(x0 - 1, vy + 1, 1, 2, c.sleeve).rect(x0 + hw, vy + 1, 1, 2, c.sleeve);
  }
  // antena
  const top = headTop;
  if (v.style === 0) {
    p.rect(cx - 1, top - (big ? 2 : 1), 2, big ? 2 : 1, c.sleeve);
    p.rect(cx - 1, top - (big ? 4 : 3), 2, 2, c.accent).px(cx - 1, top - (big ? 4 : 3), c.accentHi);
  } else if (v.style === 1) {
    p.rect(x0 + 1, top - 2, 1, 2, c.sleeve).px(x0 + 1, top - 3, c.accent);
    p.rect(x0 + hw - 2, top - 2, 1, 2, c.sleeve).px(x0 + hw - 2, top - 3, c.accent);
  } else {
    p.rect(cx + 1, top - (big ? 3 : 2), 1, big ? 3 : 2, c.sleeve);
    p.rect(cx, top - (big ? 5 : 4), 3, 2, c.accent).px(cx, top - (big ? 5 : 4), c.accentHi);
  }
}

function drawEyes(
  p: Painter,
  eyes: EyePose,
  eL: number,
  eR: number,
  ey: number,
  big: boolean,
  color: string,
  robot: boolean,
): void {
  const w = robot && big ? 2 : 1;
  switch (eyes) {
    case 'closed':
      p.rect(eL, ey + 1, robot ? w : 2, 1, robot ? shade(color, -0.3) : color);
      p.rect(robot ? eR : eR - 1, ey + 1, robot ? w : 2, 1, robot ? shade(color, -0.3) : color);
      break;
    case 'happy':
      p.rect(eL, ey, robot ? w : 2, 1, color);
      p.rect(robot ? eR : eR - 1, ey, robot ? w : 2, 1, color);
      break;
    case 'x': {
      const col = robot ? '#ff5a5a' : color;
      p.rect(eL, ey, w + (robot ? 0 : 1), 2, col);
      p.rect(robot ? eR : eR - 1, ey, w + (robot ? 0 : 1), 2, col);
      break;
    }
    default:
      p.rect(eL, ey, w, big ? 2 : 1, color);
      p.rect(eR, ey, w, big ? 2 : 1, color);
      if (robot && big) p.px(eL, ey, shade(color, 0.5)).px(eR, ey, shade(color, 0.5));
  }
}

function drawSide(
  p: Painter,
  v: Variant,
  b: Build,
  c: Colors,
  pose: Pose,
  cx: number,
  base: number,
  legH: number,
  torsoTop: number,
  headTop: number,
): void {
  const tw = Math.max(3, b.torsoW - 1);
  const th = b.torsoH;
  const sx = cx - Math.ceil(tw / 2);
  const aw = b.armW;
  const lw = b.legW + 1;

  // ── pernas ──
  const legTop = base - legH;
  if (pose.legs === 'sit') {
    p.rect(sx - 3, legTop, tw + 2, 1, c.legs);
    p.rect(sx - 3, legTop + 1, b.legW, Math.max(1, legH - 1), c.shoes);
  } else if (pose.legs === 'walkA' || pose.legs === 'walkB') {
    const nearFront = pose.legs === 'walkA';
    const fx = sx - 1;
    const bx = sx + tw - b.legW;
    // perna de trás (mais escura, levantada)
    const farX = nearFront ? bx : fx;
    p.rect(farX, legTop, b.legW, legH - 1, c.legsFar);
    p.rect(farX, legTop + Math.max(0, legH - 2), b.legW, 1, c.shoes);
    const nearX = nearFront ? fx : bx;
    p.rect(nearX, legTop, b.legW, legH, c.legs);
    p.rect(nearX - (nearFront ? 1 : 0), base - 1, b.legW + (nearFront ? 1 : 0), 1, c.shoes);
  } else {
    const lx = sx + Math.floor((tw - lw) / 2);
    p.rect(lx, legTop, lw, legH, c.legs);
    p.rect(lx - 1, base - 1, lw + 1, 1, c.shoes);
  }

  // ── tronco ──
  p.rect(sx, torsoTop, tw, th, c.body);
  p.rect(sx + tw - 1, torsoTop, 1, th, c.bodyLo);
  p.rect(sx, torsoTop + th - 1, tw, 1, c.bodyLo);

  // ── cabeça ──
  drawHead(p, v, b, c, pose, cx, headTop, 'side');

  // ── braço visível ──
  const ax = sx + Math.floor((tw - aw) / 2);
  const hand = (x: number, y: number): void => {
    p.rect(x, y, aw, 1, c.hand);
  };
  switch (pose.arms) {
    case 'swingA':
      p.rect(ax, torsoTop + 1, aw, 2, c.sleeve).rect(ax - 1, torsoTop + 3, aw, Math.max(1, th - 4), c.sleeve);
      hand(ax - 2, torsoTop + th - 2);
      break;
    case 'swingB':
      p.rect(ax, torsoTop + 1, aw, 2, c.sleeve).rect(ax + 1, torsoTop + 3, aw, Math.max(1, th - 4), c.sleeve);
      hand(ax + 2, torsoTop + th - 2);
      break;
    case 'typeA':
    case 'typeB':
    case 'hold': {
      const row = torsoTop + (pose.arms === 'typeB' ? 3 : 2) - (th < 6 ? 1 : 0);
      p.rect(ax, torsoTop + 1, aw, row - torsoTop, c.sleeve);
      p.rect(ax - 3, row, 3, 1, c.sleeve);
      p.px(ax - 4, row, c.hand);
      if (pose.arms === 'hold') {
        if (pose.item === 'book') {
          p.rect(ax - 8, row - 3, 4, 4, '#3f6fb0').rect(ax - 7, row - 3, 3, 3, '#f6f2e6');
        } else if (pose.item === 'cup') {
          p.rect(ax - 6, row - 2, 2, 3, '#f4f1e8').px(ax - 6, row - 2, '#6a4028').px(ax - 5, row - 2, '#6a4028');
        }
      }
      break;
    }
    case 'workA':
    case 'workB': {
      const up = pose.arms === 'workA' ? 3 : 2;
      p.rect(ax, torsoTop + 1, aw, 1, c.sleeve).rect(ax - 1, torsoTop, aw, 1, c.sleeve);
      p.rect(ax - 2, torsoTop - up + 1, aw, up - 1, c.sleeve);
      hand(ax - 3, torsoTop - up);
      break;
    }
    case 'chin':
      p.rect(ax, torsoTop + 1, aw, 2, c.sleeve).rect(ax - 2, torsoTop, 2, 1, c.sleeve);
      p.px(ax - 3, torsoTop - 1, c.hand);
      break;
    case 'waveA':
    case 'cheerA':
      p.rect(ax, torsoTop - 2, aw, 4, c.sleeve);
      hand(ax, torsoTop - 3);
      break;
    case 'waveB':
    case 'cheerB':
      p.rect(ax, torsoTop, aw, 2, c.sleeve).rect(ax - 1, torsoTop - 2, aw, 2, c.sleeve);
      hand(ax - 2, torsoTop - 3);
      break;
    case 'head':
      p.rect(ax, torsoTop - 2, aw, 4, c.sleeve);
      p.rect(ax - 1, torsoTop - 4, 2, 2, c.hand);
      break;
    default:
      p.rect(ax, torsoTop + 1, aw, Math.max(1, th - 2), c.sleeve);
      hand(ax, torsoTop + th - 1);
  }
}

/** Retrato (cabeça e ombros) como data URL, para a interface. */
const portraits = new Map<string, string>();

export function portraitFor(v: Variant): string {
  const cached = portraits.get(v.id);
  if (cached) return cached;
  const { canvas, ctx } = makeCanvas(FRAME_W, FRAME_H);
  drawCharacter(new Painter(ctx), v, { dir: 'down', legs: 'stand', arms: 'down', eyes: 'open', item: 'none' });
  outlineRegion(ctx, 0, 0, FRAME_W, FRAME_H, OUTLINE);
  const size = 16;
  const top = v.small ? 9 : 3;
  const out = makeCanvas(size, size);
  out.ctx.drawImage(canvas, 3, top, size, size, 0, 0, size, size);
  const url = out.canvas.toDataURL('image/png');
  portraits.set(v.id, url);
  return url;
}
