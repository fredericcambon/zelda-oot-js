// The "Fraidoux Edition" line under the title logo, drawn by the page over the 3D picture. docs/re/title-logo.md has the evidence
// for how the title is recognised and how the logo fades.
import type { Batch } from '../tools/gfx/types.ts';
import fontUrl from './fonts/Cinzel-Bold-latin.woff2?url';

export const EDITION_TEXT = 'FRAIDOUX EDITION';

/** The word of the main code's bss that is 1 in the title's demo scene, 2 from Start (the logo's fade-out) and in the file select, 0 in play (docs/re/title-logo.md). */
export const GAME_MODE = 0x8011972c;

/** Prim alpha the logo's draws hold once faded in; the layer's opacity is the logo's alpha over this. */
export const LOGO_ALPHA = 210;

/** The subtitle's fill pass: a 96x8 8-bit intensity texture drawn with this prim colour (its shadow pass is black). */
const SUBTITLE = { width: 96, height: 8, fmt: 4, siz: 1, r: 200, g: 200, b: 150 } as const;

/** The prim alpha of the title logo's subtitle draw in a display list, or 0 when the list does not draw it. */
export function logoAlpha(batches: readonly Batch[]): number {
  let alpha = 0;
  for (const b of batches) {
    if (b.kind !== 'texrect') continue;
    const tex = b.state.textures[0];
    const c = b.state.primColor;
    if (tex?.width === SUBTITLE.width && tex.height === SUBTITLE.height && tex.fmt === SUBTITLE.fmt && tex.siz === SUBTITLE.siz
      && c.r === SUBTITLE.r && c.g === SUBTITLE.g && c.b === SUBTITLE.b) alpha = Math.max(alpha, c.a);
  }
  return alpha;
}

/** How visible the edition line is, 0 to 1: it follows the logo's alpha, and never shows in play (mode 0). */
export function titleFade(alpha: number, mode: number): number {
  if (mode === 0 || alpha <= 0) return 0;
  return Math.min(1, alpha / LOGO_ALPHA);
}

/** Layout in the game's 320x240 picture: the line is right-aligned under the subtitle, which spans x 151 to 247 and y 126 to 134 (docs/re/title-logo.md). */
export const WIDTH = 320;
export const HEIGHT = 240;
const RIGHT = 246;
const MIDDLE_Y = 147.5;
const FONT_PX = 8.1;
const SPACING_PX = 1.4;

function drawLine(g: CanvasRenderingContext2D): void {
  g.clearRect(0, 0, WIDTH, HEIGHT);
  g.font = `700 ${FONT_PX}px EditionCinzel`;
  g.letterSpacing = `${SPACING_PX}px`;
  g.textAlign = 'right';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  // The letter spacing is also added after the last letter.
  const x = RIGHT + SPACING_PX;
  g.save();
  g.shadowColor = 'rgba(0, 0, 0, 0.85)';
  g.shadowOffsetX = 0.9;
  g.shadowOffsetY = 1.25;
  g.shadowBlur = 1.25;
  g.strokeStyle = '#2a1203';
  g.lineWidth = 2;
  g.strokeText(EDITION_TEXT, x, MIDDLE_Y);
  g.restore();
  const top = MIDDLE_Y - 3.6;
  const gold = g.createLinearGradient(0, top, 0, top + 7.2);
  for (const [at, colour] of [[0, '#fff3b0'], [0.45, '#e8b948'], [0.55, '#b9791f'], [1, '#f0c960']] as const) gold.addColorStop(at, colour);
  g.fillStyle = gold;
  g.fillText(EDITION_TEXT, x, MIDDLE_Y);
}

/** A canvas over the game's picture, in the picture's own 320x240 pixels so that the page scales it with the picture. */
export class TitleEdition {
  readonly canvas = document.createElement('canvas');
  private fade = 0;

  constructor(parent: HTMLElement, before: Element | null) {
    this.canvas.id = 'title-edition';
    this.canvas.width = WIDTH;
    this.canvas.height = HEIGHT;
    this.canvas.hidden = true;
    parent.insertBefore(this.canvas, before);
    const face = new FontFace('EditionCinzel', `url(${fontUrl})`, { weight: '700' });
    face.load().then((loaded) => {
      document.fonts.add(loaded);
      drawLine(this.canvas.getContext('2d')!);
    }).catch((err) => console.error('The edition font did not load', err));
  }

  /** Shows the line at the given opacity; 0 hides it. */
  set(fade: number): void {
    if (fade === this.fade) return;
    this.fade = fade;
    this.canvas.hidden = fade === 0;
    this.canvas.style.opacity = String(fade);
  }
}
