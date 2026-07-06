import { outbox, relay, type Subscription } from '@napplet/sdk';
import type { NostrEvent } from '@hyprgate/types';
import type { ProfileContent } from './profile-display';

interface NappletShellHandle {
  ready(): Promise<unknown>;
  supports(domain: string, protocol?: string): boolean;
}

export type ProfileMetadataCallback = (pubkey: string, profile: ProfileContent) => void;

const NOOP_SUBSCRIPTION: Subscription = { close: () => { /* no-op */ } };

function getShell(): NappletShellHandle | null {
  return (globalThis as unknown as { napplet?: { shell?: NappletShellHandle } }).napplet?.shell ?? null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function parseProfileEvent(event: NostrEvent): ProfileContent | null {
  if (event.kind !== 0) return null;

  try {
    const metadata = JSON.parse(event.content) as Record<string, unknown>;
    return {
      name: optionalString(metadata.name),
      display_name: optionalString(metadata.display_name),
      displayName: optionalString(metadata.displayName),
      nip05: optionalString(metadata.nip05),
      picture: optionalString(metadata.picture),
    };
  } catch {
    return null;
  }
}

export function subscribeProfileMetadata(
  pubkeys: string[],
  onProfile: ProfileMetadataCallback,
  onDone: () => void = () => { /* no-op */ },
): Subscription {
  const authors = [...new Set(pubkeys.filter((pubkey) => pubkey.length > 0))];
  if (authors.length === 0) {
    onDone();
    return NOOP_SUBSCRIPTION;
  }

  const latestByPubkey = new Map<string, number>();
  let subscription: Subscription | null = null;
  let closed = false;
  let closeWhenReady = false;

  function close(): void {
    if (closed) return;
    closed = true;
    if (subscription) {
      subscription.close();
    } else {
      closeWhenReady = true;
    }
  }

  function handleEvent(event: NostrEvent): void {
    if (closed || event.kind !== 0 || !authors.includes(event.pubkey)) return;
    const latestCreatedAt = latestByPubkey.get(event.pubkey);
    if (latestCreatedAt !== undefined && latestCreatedAt > event.created_at) return;

    const profile = parseProfileEvent(event);
    if (!profile) return;

    latestByPubkey.set(event.pubkey, event.created_at);
    onProfile(event.pubkey, profile);
  }

  function handleEose(): void {
    onDone();
  }

  const filters = authors.map((author) => ({ kinds: [0], authors: [author], limit: 1 }));
  void (async () => {
    const shell = getShell();
    await shell?.ready();
    if (closed) return;
    if (shell?.supports('outbox') ?? false) {
      subscription = NOOP_SUBSCRIPTION;
      try {
        const result = await outbox.query(filters);
        for (const item of result.events) handleEvent(item.event as NostrEvent);
      } finally {
        if (!closed) handleEose();
      }
    } else {
      subscription = relay.subscribe(filters, (result) => handleEvent(result.event as NostrEvent), handleEose);
    }
    if (closeWhenReady) subscription.close();
  })();

  return { close };
}
