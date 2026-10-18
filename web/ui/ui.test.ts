import { describe, expect, it, vi } from 'vitest';
import { clampWidth, DEFAULT_WIDTH, loadPrefs, MAX_WIDTH, MIN_WIDTH, savePrefs } from './prefs.ts';
import { Store } from './store.ts';
import { countName, FIELD_NAMES, slotName } from './inventory-names.ts';
import { Labels } from './labels.ts';
import { isTyping } from './typing.ts';

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe('panel preferences', () => {
  const tabs = ['game', 'saves'];

  it('defaults when nothing is stored', () => {
    expect(loadPrefs(tabs, memory())).toEqual({ width: DEFAULT_WIDTH, tab: 'game', collapsed: false });
  });

  it('round-trips and clamps the width', () => {
    const store = memory();
    savePrefs({ width: 480, tab: 'saves', collapsed: true }, store);
    expect(loadPrefs(tabs, store)).toEqual({ width: 480, tab: 'saves', collapsed: true });
    expect(clampWidth(10)).toBe(MIN_WIDTH);
    expect(clampWidth(9000)).toBe(MAX_WIDTH);
  });

  it('drops an unknown tab and survives damaged or blocked storage', () => {
    const store = memory();
    store.setItem('zelda-oot-js:panel', JSON.stringify({ tab: 'gone', width: 'wide' }));
    expect(loadPrefs(tabs, store)).toEqual({ width: DEFAULT_WIDTH, tab: 'game', collapsed: false });
    store.setItem('zelda-oot-js:panel', '{not json');
    expect(loadPrefs(tabs, store).tab).toBe('game');
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(loadPrefs(tabs, blocked).tab).toBe('game');
    expect(() => savePrefs({ width: 300, tab: 'game', collapsed: false }, blocked)).not.toThrow();
  });
});

describe('Store', () => {
  it('notifies only when a field changes', () => {
    const store = new Store({ a: 1, b: 'x' });
    const listener = vi.fn();
    const off = store.subscribe(listener);
    store.set({ a: 1 });
    expect(listener).not.toHaveBeenCalled();
    store.set({ a: 2 });
    expect(store.get()).toEqual({ a: 2, b: 'x' });
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    store.set({ b: 'y' });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('isTyping', () => {
  const on = (tagName: string, extra: object = {}) => ({ target: { tagName, ...extra } as unknown as EventTarget });

  it('is true for text fields and false for the canvas, buttons and sliders', () => {
    expect(isTyping(on('INPUT', { type: 'text' }))).toBe(true);
    expect(isTyping(on('TEXTAREA'))).toBe(true);
    expect(isTyping(on('DIV', { isContentEditable: true }))).toBe(true);
    expect(isTyping(on('INPUT', { type: 'range' }))).toBe(false);
    expect(isTyping(on('BUTTON'))).toBe(false);
    expect(isTyping(on('CANVAS'))).toBe(false);
    expect(isTyping({ target: null })).toBe(false);
  });
});

describe('user labels', () => {
  it('survive a reload, and clear on an empty text', () => {
    const store = memory();
    const first = new Labels(store);
    first.set('scene', 5, '  Forest  ');
    first.set('field', 'count34', 'Money');
    expect(new Labels(store).get('scene', '5')).toBe('Forest');
    expect(new Labels(store).get('field', 'count34')).toBe('Money');
    first.set('scene', 5, '');
    expect(new Labels(store).get('scene', 5)).toBeUndefined();
  });

  it('export and import round-trip, and import merges', () => {
    const a = new Labels(memory());
    a.set('actor', 0x3c, 'Cucco');
    a.set('entrance', 7, 'Door');
    const b = new Labels(memory());
    b.set('actor', 0x3c, 'Chicken');
    b.set('scene', 1, 'Kept');
    expect(b.importJson(a.exportJson())).toBe(2);
    expect(b.get('actor', 0x3c)).toBe('Cucco');
    expect(b.get('entrance', 7)).toBe('Door');
    expect(b.get('scene', 1)).toBe('Kept');
  });

  it('refuses text that is not labels, leaving the stored ones alone', () => {
    const a = new Labels(memory());
    a.set('scene', 1, 'x');
    expect(() => a.importJson('{nope')).toThrow('not JSON');
    expect(() => a.importJson('[]')).toThrow();
    expect(() => a.importJson('{"planet":{"1":"x"}}')).toThrow(/unknown kind/);
    expect(() => a.importJson('{"scene":{"1":7}}')).toThrow(/not text/);
    expect(a.count()).toBe(1);
  });

  it('survives blocked storage and notifies subscribers', () => {
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    const a = new Labels(blocked);
    const listener = vi.fn();
    a.subscribe(listener);
    expect(() => a.set('scene', 1, 'x')).not.toThrow();
    expect(a.get('scene', 1)).toBe('x');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('inventory names', () => {
  it('leave no bare offset name', () => {
    const bare = /^(count|counts|flag|byte|bytes|bits|level|limit)[0-9A-F]+(\.\d+)?$/;
    const names = [...Object.values(FIELD_NAMES), ...Array.from({ length: 16 }, (_, i) => countName(i)), ...Array.from({ length: 24 }, (_, i) => slotName(i))];
    for (const n of names) {
      expect(n.name).not.toMatch(bare);
      expect(n.hint.length).toBeGreaterThan(10);
    }
    expect(countName(1).name).toBe('Deku Nut count');
    expect(countName(9).observed).toBe(false);
  });
});
