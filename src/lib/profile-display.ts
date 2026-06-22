import { buildMentionReference } from '@hyprgate/utils';
import type { CreatorSignal } from './creator-signals-store';

export interface ProfileContent {
  name?: string;
  display_name?: string;
  displayName?: string;
  nip05?: string;
  picture?: string;
}

export function fallbackNpub(pubkey: string): string {
  const reference = buildMentionReference(pubkey);
  return reference.startsWith('nostr:') ? reference.slice('nostr:'.length) : reference;
}

export function profileLabel(profile: ProfileContent | undefined, pubkey: string): string {
  return profile?.display_name
    ?? profile?.displayName
    ?? profile?.name
    ?? profile?.nip05
    ?? fallbackNpub(pubkey);
}

export function safeProfilePicture(profile: ProfileContent | undefined): string | null {
  if (!profile?.picture) return null;
  try {
    const parsed = new URL(profile.picture);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export function uniqueSignalAuthors(signals: CreatorSignal[]): string[] {
  return [...new Set(signals.map((signal) => signal.author).filter(Boolean))];
}
