import { html } from 'htm/preact';
import { render, type ComponentType, type VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { clampWidth, loadPrefs, savePrefs, type PanelPrefs } from './prefs.ts';
import type { Store } from './store.ts';
import { DebugTab, GameTab, SavesTab } from './tabs.ts';
import { WarpTab } from './warp-tab.ts';
import type { TabProps, UiActions, UiState } from './types.ts';
import { keepFocus } from './widgets.ts';

interface TabDef {
  id: string;
  label: string;
  icon: string;
  body: ComponentType<TabProps>;
}

// Later tabs are added here.
const TABS: TabDef[] = [
  { id: 'game', label: 'Game', icon: '🎮', body: GameTab },
  { id: 'saves', label: 'Saves', icon: '💾', body: SavesTab },
  { id: 'warp', label: 'Warp', icon: '🌀', body: WarpTab },
  { id: 'debug', label: 'Debug', icon: '🐞', body: DebugTab },
];

function useStore<T extends object>(store: Store<T>): T {
  const [, tick] = useState(0);
  useEffect(() => store.subscribe(() => tick((n) => n + 1)), [store]);
  return store.get();
}

// Touch mode is decided by the touch controls, which mark the root element; the panel follows.
function useTouchMode(): boolean {
  const root = document.documentElement;
  const [touch, setTouch] = useState(root.classList.contains('touch'));
  useEffect(() => {
    const watch = new MutationObserver(() => setTouch(root.classList.contains('touch')));
    watch.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => watch.disconnect();
  }, []);
  return touch;
}

interface ShellProps {
  store: Store<UiState>;
  actions: UiActions;
}

function Shell({ store, actions }: ShellProps): VNode {
  const state = useStore(store);
  const touch = useTouchMode();
  const [prefs, setPrefs] = useState<PanelPrefs>(() => loadPrefs(TABS.map((t) => t.id)));
  const [dragging, setDragging] = useState(false);
  const sheetOpen = state.sheetOpen;
  const folded = !touch && prefs.collapsed;

  const update = (patch: Partial<PanelPrefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    savePrefs(next);
  };

  const visible = touch ? sheetOpen : !folded;
  useEffect(() => store.set({ debugVisible: visible && prefs.tab === 'debug', warpVisible: visible && prefs.tab === 'warp' }), [store, visible, prefs.tab]);
  useEffect(() => {
    document.documentElement.classList.toggle('sheet-open', touch && sheetOpen);
  }, [touch, sheetOpen]);

  const tab = TABS.find((t) => t.id === prefs.tab) ?? TABS[0]!;

  const resize = (e: PointerEvent) => {
    if (dragging) setPrefs({ ...prefs, width: clampWidth(innerWidth - e.clientX) });
  };
  const endResize = (e: PointerEvent) => {
    (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    setDragging(false);
    savePrefs(prefs);
  };
  const startResize = (e: PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    setDragging(true);
  };

  const rail = html`<nav class="rail">
    <button type="button" tabIndex=${-1} title="Open the panel" onMouseDown=${keepFocus} onClick=${() => update({ collapsed: false })}>«</button>
    ${TABS.map((t) => html`<button key=${t.id} type="button" tabIndex=${-1} title=${t.label} onMouseDown=${keepFocus} onClick=${() => update({ tab: t.id, collapsed: false })}>${t.icon}</button>`)}
  </nav>`;

  const panel = html`<div class="panel">
    <nav class="tabs" role="tablist">
      ${TABS.map((t) => html`<button key=${t.id} id=${`tab-${t.id}`} class=${t.id === tab.id ? 'active' : ''} role="tab" aria-selected=${t.id === tab.id} type="button" tabIndex=${-1} onMouseDown=${keepFocus} onClick=${() => update({ tab: t.id })}>${t.label}</button>`)}
      ${!touch && html`<button class="fold" type="button" tabIndex=${-1} title="Collapse the panel" onMouseDown=${keepFocus} onClick=${() => update({ collapsed: true })}>»</button>`}
    </nav>
    <div class="tab-body"><${tab.body} state=${state} actions=${actions} /></div>
  </div>`;

  return html`
    <button id="menu-button" type="button" tabIndex=${-1} aria-label="Menu" aria-expanded=${sheetOpen} onMouseDown=${keepFocus} onClick=${() => store.set({ sheetOpen: !sheetOpen })}>${sheetOpen ? '✕' : '☰'}</button>
    <aside id="dock" class=${`${folded ? 'folded' : ''} ${sheetOpen ? 'open' : ''}`} style=${{ '--dock-width': `${folded ? 40 : prefs.width}px` }}>
      ${!touch && !folded && html`<div id="dock-resizer" role="separator" aria-orientation="vertical" onPointerDown=${startResize} onPointerMove=${resize} onPointerUp=${endResize} onPointerCancel=${endResize} />`}
      ${folded ? rail : panel}
    </aside>` as VNode;
}

/** Draws the panel (docked on desktop, a sheet behind the menu button on touch devices) into `root`. */
export function mountUi(root: HTMLElement, store: Store<UiState>, actions: UiActions): void {
  render(html`<${Shell} store=${store} actions=${actions} />`, root);
}
