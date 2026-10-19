import type { CullMode } from '../renderer.ts';
import type { Hz } from '../mode.ts';
import type { InventorySnapshot } from '../inspect/inventory.ts';
import type { ActorsSnapshot } from '../inspect/actors.ts';
import type { Cheat } from '../inspect/cheats.ts';
import type { MemorySnapshot, SearchKind, ValueType } from '../inspect/memory.ts';
import type { Entrance, WarpSnapshot } from '../inspect/warp.ts';

/** What the panels show; the game loop and the controls write it. */
export interface UiState {
  smooth: boolean;
  /** Percent of the motion between game frames that is shown, and of a game frame it takes to catch up. */
  strength: number;
  span: number;
  bloom: boolean;
  bloomStrength: number;
  bloomThreshold: number;
  bloomKnee: number;
  bloomRadius: number;
  sharpen: boolean;
  sharpenStrength: number;
  bootHz: Hz;
  wantedHz: Hz;
  muted: boolean;
  native: boolean;
  cull: CullMode;
  controlsHidden: boolean;
  /** The save state slot (1-4) that keys 5 and 6 act on; null while save states are not available. */
  slot: number | null;
  /** Whether each save state slot holds a state; null until known. */
  filled: (boolean | null)[];
  overlayShown: boolean;
  /** The debug text; kept current only while `debugVisible`. */
  debugText: string;
  /** The Debug tab is on screen. */
  debugVisible: boolean;
  /** The Warp tab is on screen. */
  warpVisible: boolean;
  /** The scene, entrance and position of the running game; kept current only while `warpVisible`. */
  warp: WarpSnapshot;
  /** The Inventory tab is on screen. */
  inventoryVisible: boolean;
  /** The save context of the running game; kept current only while `inventoryVisible`. */
  inventory: InventorySnapshot;
  /** The Memory tab is on screen. */
  memoryVisible: boolean;
  /** The memory window, watches and search of the running game; kept current (about ten times a second) only while `memoryVisible`. */
  memory: MemorySnapshot;
  cheats: Cheat[];
  /** The Actors tab is on screen. */
  actorsVisible: boolean;
  /** The live actors of the running game; kept current (about ten times a second) only while `actorsVisible`. */
  actors: ActorsSnapshot;
  /** A tab another tab asks the panel to open; the panel clears it once it has. */
  tabRequest: string | null;
  /** Mobile: the menu sheet is open, and touch input is ignored. */
  sheetOpen: boolean;
}

export interface UiActions {
  setSmooth(on: boolean): void;
  setStrength(percent: number): void;
  setSpan(percent: number): void;
  setBloom(on: boolean): void;
  setBloomStrength(percent: number): void;
  setBloomThreshold(percent: number): void;
  setBloomKnee(percent: number): void;
  setBloomRadius(percent: number): void;
  setSharpen(on: boolean): void;
  setSharpenStrength(percent: number): void;
  toggleHz(): void;
  toggleMute(): void;
  toggleNative(): void;
  cycleCull(): void;
  toggleControls(): void;
  toggleFullscreen(): void;
  setOverlay(on: boolean): void;
  saveSlot(slot: number): void;
  loadSlot(slot: number): void;
  selectSlot(slot: number): void;
  refreshSlots(): void;
  loadSaveFile(): void;
  loadIntoPlay(slot: number): void;
  backToFileSelect(): void;
  /** The entrance table, or null while no game runs. */
  entrances(): Entrance[] | null;
  /** Queues a warp to table entry `entry`; the game refuses it with a message in an unsafe state. */
  warp(entry: number): void;
  /** Queues `key=value` edits of the save context (the keys of `editRecord`); refused in an unsafe state. */
  editSave(edits: readonly (readonly [string, string])[]): void;
  /** Queues holding a numeric save field at its current value, or releasing it. */
  toggleFreeze(key: string): void;
  /** Moves the hex view to an address (`0x80xxxxxx` or an offset); returns why it cannot, or undefined. */
  gotoMemory(text: string): string | undefined;
  /** Moves the hex view by `bytes`. */
  pageMemory(bytes: number): void;
  /** Queues writing a value at an address; refused in an unsafe state. */
  writeMemory(addr: number, type: ValueType, text: string): void;
  /** Pins an address; returns why it cannot, or undefined. */
  addWatch(addr: string, type: ValueType): string | undefined;
  removeWatch(id: number): void;
  holdWatch(id: number): void;
  writeWatch(id: number, text: string): void;
  searchStart(type: ValueType): void;
  searchNarrow(kind: SearchKind, value?: string): void;
  searchEnd(): void;
  /** Stores a code (enabled); returns why it is not a valid code, or undefined. */
  addCheat(name: string, code: string): string | undefined;
  toggleCheat(id: string): void;
  removeCheat(id: string): void;
  /** Queues putting Link next to the actor whose record is at `addr`; refused in an unsafe state. */
  goToActor(addr: number): void;
  /** Shows the record at `addr` in the Memory tab. */
  viewRecord(addr: number): void;
}

export interface TabProps {
  state: UiState;
  actions: UiActions;
}
