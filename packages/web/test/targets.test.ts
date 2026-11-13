import { describe, expect, it } from 'vitest';
import type { SessionStatus, ToolCategory } from '../../server/src/schema';
import { OFFICE } from '../src/game/layout';
import { DeskAllocator, SlotAllocator } from '../src/game/slots';
import { isWorkActivity, targetFor, type TargetInput } from '../src/game/targets';
import { hash32, variantFor } from '../src/game/variant';
import { ambientAt, hourFor } from '../src/game/daynight';

function input(over: Partial<TargetInput> & { status: SessionStatus }): TargetInput {
  return { toolCategory: null, toolName: null, subagents: 0, ...over };
}

describe('targetFor (status → área)', () => {
  it('leva cada categoria de ferramenta para a estação certa', () => {
    const expected: Record<ToolCategory, string> = {
      write: 'desk',
      edit: 'desk',
      other: 'desk',
      read: 'shelf',
      search: 'archive',
      bash: 'server',
      plan: 'board',
      web: 'web',
    };
    for (const [cat, area] of Object.entries(expected)) {
      const t = targetFor(input({ status: 'working', toolCategory: cat as ToolCategory, toolName: 'X' }));
      expect(t.area, cat).toBe(area);
      expect(isWorkActivity(t.activity), cat).toBe(true);
    }
  });

  it('mapeia os status sem ferramenta', () => {
    expect(targetFor(input({ status: 'starting' }))).toEqual({ area: 'desk', activity: 'arrive' });
    expect(targetFor(input({ status: 'thinking' }))).toEqual({ area: 'desk', activity: 'think' });
    expect(targetFor(input({ status: 'waiting_input' }))).toEqual({ area: 'desk', activity: 'wait' });
    expect(targetFor(input({ status: 'permission_wait', toolCategory: 'bash', toolName: 'Bash' }))).toEqual({
      area: 'stay',
      activity: 'permission',
    });
    expect(targetFor(input({ status: 'done' }))).toEqual({ area: 'desk', activity: 'done' });
    expect(targetFor(input({ status: 'error' }))).toEqual({ area: 'desk', activity: 'error' });
    expect(targetFor(input({ status: 'idle' }))).toEqual({ area: 'copa', activity: 'idle' });
    expect(targetFor(input({ status: 'ended' }))).toEqual({ area: 'door', activity: 'leave' });
  });

  it('working sem categoria conhecida vai para a própria mesa', () => {
    expect(targetFor(input({ status: 'working' }))).toEqual({ area: 'desk', activity: 'type' });
  });

  it('subagentes se reúnem na sala de reunião enquanto pensam ou iniciam', () => {
    const child = { parentKey: 'claude:pai' };
    expect(targetFor(input({ status: 'thinking', ...child })).area).toBe('meeting');
    expect(targetFor(input({ status: 'starting', ...child })).area).toBe('meeting');
    expect(targetFor(input({ status: 'working', toolCategory: 'edit', toolName: 'Edit', ...child })).area).toBe(
      'meeting',
    );
    // usando ferramentas, vão para a estação como todo mundo
    expect(targetFor(input({ status: 'working', toolCategory: 'bash', toolName: 'Bash', ...child })).area).toBe(
      'server',
    );
    expect(targetFor(input({ status: 'working', toolCategory: 'read', toolName: 'Read', ...child })).area).toBe(
      'shelf',
    );
    expect(targetFor(input({ status: 'ended', ...child })).area).toBe('door');
  });

  it('o pai vai para a reunião quando delega ou pensa com subagentes ativos', () => {
    expect(targetFor(input({ status: 'thinking', subagents: 2 }))).toEqual({ area: 'meeting', activity: 'think' });
    for (const toolName of ['Agent', 'Task', 'spawn_agent']) {
      const t = targetFor(input({ status: 'working', toolCategory: 'plan', toolName, subagents: 1 }));
      expect(t).toEqual({ area: 'meeting', activity: 'meet' });
    }
    // outra ferramenta de planejamento continua indo para o quadro
    expect(targetFor(input({ status: 'working', toolCategory: 'plan', toolName: 'TodoWrite', subagents: 1 })).area).toBe(
      'board',
    );
  });
});

describe('alocação de vagas', () => {
  it('não empilha personagens enquanto houver vaga livre', () => {
    const alloc = new SlotAllocator(OFFICE.slots);
    const total = OFFICE.slots.server.length;
    const used = new Set<string>();
    for (let i = 0; i < total; i++) {
      const c = alloc.claim(`k${i}`, 'server', { x: 5, y: 5 });
      expect(c.share).toBe(0);
      expect(used.has(c.slot.id)).toBe(false);
      used.add(c.slot.id);
    }
    // lotou: passa a compartilhar, sem falhar
    const extra = alloc.claim('extra', 'server', { x: 5, y: 5 });
    expect(extra.share).toBe(1);
    expect(alloc.countIn('server')).toBe(total + 1);
  });

  it('mantém a vaga na mesma área e libera ao trocar de área', () => {
    const alloc = new SlotAllocator(OFFICE.slots);
    const a = alloc.claim('a', 'shelf', { x: 5, y: 14 });
    expect(alloc.claim('a', 'shelf', { x: 30, y: 20 }).slot.id).toBe(a.slot.id);
    const b = alloc.claim('a', 'web', { x: 5, y: 14 });
    expect(b.slot.area).toBe('web');
    expect(alloc.occupantsOf(a.slot.id)).toHaveLength(0);
    alloc.release('a');
    expect(alloc.slotOf('a')).toBeUndefined();
  });

  it('escolhe a vaga livre mais próxima entre as de mesma preferência', () => {
    const alloc = new SlotAllocator(OFFICE.slots);
    const c = alloc.claim('a', 'server', { x: 1, y: 5 });
    expect(c.slot.x).toBeLessThanOrEqual(2);
    expect(c.slot.y).toBe(4);
  });

  it('dá uma mesa por sessão, agrupa por projeto e degrada quando lota', () => {
    const desks = new DeskAllocator(OFFICE.desks);
    const a = desks.assign('a', 'loja');
    const b = desks.assign('b', 'loja');
    const c = desks.assign('c', 'api');
    expect(a.slot.index).not.toBe(b.slot.index);
    expect(a.slot.group).toBe(b.slot.group);
    expect(c.slot.group).not.toBe(a.slot.group);
    expect(desks.assign('a', 'loja').slot.index).toBe(a.slot.index);

    const seen = new Set<number>([a.slot.index, b.slot.index, c.slot.index]);
    for (let i = 0; i < OFFICE.desks.length - 3; i++) {
      const d = desks.assign(`x${i}`, `p${i % 5}`);
      expect(d.share).toBe(0);
      expect(seen.has(d.slot.index)).toBe(false);
      seen.add(d.slot.index);
    }
    expect(seen.size).toBe(OFFICE.desks.length);
    const over = desks.assign('over', 'loja');
    expect(over.share).toBe(1);
    desks.release('a');
    expect(desks.deskOf('a')).toBeUndefined();
    expect(desks.assign('novo', 'zzz').slot.index).toBe(a.slot.index);
  });
});

describe('aparência e ambiente', () => {
  it('é determinística e liga subagentes ao pai pelas cores', () => {
    expect(hash32('claude:abc')).toBe(hash32('claude:abc'));
    const parent = variantFor('claude:pai', 'claude');
    const child = variantFor('claude:filho', 'claude', 'claude:pai');
    expect(child.small).toBe(true);
    expect(parent.small).toBe(false);
    expect(child.body).toBe(parent.body);
    expect(child.accent).toBe(parent.accent);
    expect(variantFor('claude:pai', 'claude')).toEqual(parent);
  });

  it('escurece à noite e clareia de dia', () => {
    expect(ambientAt(12).night).toBe(0);
    expect(ambientAt(23).night).toBe(1);
    expect(ambientAt(12).tint).toBe(0xffffff);
    expect(ambientAt(18.5).night).toBeGreaterThan(0);
    expect(ambientAt(18.5).night).toBeLessThan(1);
    expect(hourFor('day', new Date())).toBe(12);
    expect(hourFor('night', new Date())).toBe(23);
    expect(hourFor('auto', new Date(2026, 0, 1, 6, 30, 0))).toBeCloseTo(6.5);
  });
});
