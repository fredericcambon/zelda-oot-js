import { describe, expect, it, vi } from 'vitest';
import { clampWidth, DEFAULT_WIDTH, loadPrefs, MAX_WIDTH, MIN_WIDTH, savePrefs } from './prefs.ts';
import { Store } from './store.ts';
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
