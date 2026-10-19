import { describe, expect, it } from 'vitest';
import { ACTOR_NAMES } from './actor-names.ts';

describe('actor names', () => {
  it('cite where each was seen', () => {
    for (const [id, entry] of Object.entries(ACTOR_NAMES)) {
      expect(Number(id), id).toBeGreaterThanOrEqual(0);
      expect(entry.name.trim(), id).not.toBe('');
      expect(entry.note, id).toMatch(/^Seen in .*out\/actors\/scene-\d+\/sheet-\d\.png/);
    }
  });
});
