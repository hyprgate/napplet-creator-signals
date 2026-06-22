import { describe, expect, it } from 'vitest';
import {
  fallbackNpub,
  profileLabel,
  safeProfilePicture,
  uniqueSignalAuthors,
} from './profile-display';
import type { CreatorSignal } from './creator-signals-store';

const PUBKEY = 'b'.repeat(64);

describe('creator signal profile display helpers', () => {
  it('uses display name priority before npub fallback', () => {
    expect(profileLabel({ display_name: 'Display' }, PUBKEY)).toBe('Display');
    expect(profileLabel({ displayName: 'Camel' }, PUBKEY)).toBe('Camel');
    expect(profileLabel({ name: 'Name' }, PUBKEY)).toBe('Name');
    expect(profileLabel({ nip05: 'alice@example.test' }, PUBKEY)).toBe('alice@example.test');
    expect(profileLabel(undefined, PUBKEY)).toBe(fallbackNpub(PUBKEY));
    expect(fallbackNpub(PUBKEY)).toMatch(/^npub1/);
  });

  it('keeps only safe avatar URLs', () => {
    expect(safeProfilePicture({ picture: 'https://example.test/avatar.png' })).toBe('https://example.test/avatar.png');
    expect(safeProfilePicture({ picture: 'http://example.test/avatar.png' })).toBe('http://example.test/avatar.png');
    expect(safeProfilePicture({ picture: 'javascript:alert(1)' })).toBeNull();
    expect(safeProfilePicture({ picture: 'not a url' })).toBeNull();
  });

  it('dedupes visible signal authors for profile lookup', () => {
    const signals: CreatorSignal[] = [
      { id: 'a', kind: 'reply', targetKey: null, author: PUBKEY, summary: 'one', createdAt: 1 },
      { id: 'b', kind: 'zap', targetKey: null, author: PUBKEY, summary: 'two', createdAt: 2 },
      { id: 'c', kind: 'repost', targetKey: null, author: 'c'.repeat(64), summary: 'three', createdAt: 3 },
    ];

    expect(uniqueSignalAuthors(signals)).toEqual([PUBKEY, 'c'.repeat(64)]);
  });
});
