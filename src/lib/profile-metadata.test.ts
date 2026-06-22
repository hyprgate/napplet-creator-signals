import { describe, expect, it } from 'vitest';
import type { NostrEvent } from '@hyprgate/types';
import { parseProfileEvent } from './profile-metadata';

function event(content: string, overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: 'e'.repeat(64),
    pubkey: 'a'.repeat(64),
    created_at: 1,
    kind: 0,
    tags: [],
    content,
    sig: 's',
    ...overrides,
  };
}

describe('creator signal profile metadata', () => {
  it('parses display names, nip05, and avatars from kind-0 events', () => {
    expect(parseProfileEvent(event(JSON.stringify({
      display_name: 'Display',
      displayName: 'Camel',
      name: 'Name',
      nip05: 'alice@example.test',
      picture: 'https://example.test/a.png',
    })))).toEqual({
      display_name: 'Display',
      displayName: 'Camel',
      name: 'Name',
      nip05: 'alice@example.test',
      picture: 'https://example.test/a.png',
    });
  });

  it('ignores non-profile and malformed events', () => {
    expect(parseProfileEvent(event('{}', { kind: 1 }))).toBeNull();
    expect(parseProfileEvent(event('{'))).toBeNull();
  });
});
