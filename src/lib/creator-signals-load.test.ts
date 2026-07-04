import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CREATOR_IDENTITY_RETRY_INTERVAL_MS,
  CREATOR_IDENTITY_TIMEOUT_MS,
  CREATOR_SIGNAL_STAGE_DELAY_MS,
  createCreatorSignalsStore,
  type NostrEvent,
} from './creator-signals-store';

const SELF = 'a'.repeat(64);
const RELAYS = {
  'wss://read.example': { read: true },
  'wss://write.example': { write: true },
};

const sdk = vi.hoisted(() => ({
  getPublicKey: vi.fn(),
  getRelays: vi.fn(),
  getItem: vi.fn(),
  setItem: vi.fn(),
  subscribe: vi.fn(),
  subscriptions: [] as Array<{
    filter: Record<string, unknown>;
    onEvent: (result: { event: NostrEvent }) => void;
    onEose: () => void;
    close: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock('@napplet/sdk', () => ({
  identity: {
    getPublicKey: sdk.getPublicKey,
    getRelays: sdk.getRelays,
  },
  relay: {
    subscribe: sdk.subscribe,
  },
  storage: {
    getItem: sdk.getItem,
    setItem: sdk.setItem,
  },
}));

function nostrEvent(partial: Partial<NostrEvent>): NostrEvent {
  return {
    id: partial.id ?? '1'.repeat(64),
    pubkey: partial.pubkey ?? SELF,
    created_at: partial.created_at ?? 1,
    kind: partial.kind ?? 1,
    tags: partial.tags ?? [],
    content: partial.content ?? 'hello',
    sig: partial.sig ?? 'sig',
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
}

describe('creator signals load scheduling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sdk.subscriptions = [];
    sdk.getPublicKey.mockResolvedValue(SELF);
    sdk.getRelays.mockResolvedValue(RELAYS);
    sdk.getItem.mockResolvedValue(null);
    sdk.setItem.mockResolvedValue(undefined);
    sdk.subscribe.mockImplementation((
      filter: Record<string, unknown>,
      onEvent: (result: { event: NostrEvent }) => void,
      onEose: () => void,
    ) => {
      const close = vi.fn();
      sdk.subscriptions.push({ filter, onEvent, onEose, close });
      return { close };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('waits through delayed identity before subscribing', async () => {
    sdk.getPublicKey.mockReset();
    sdk.getPublicKey
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(SELF);
    const store = createCreatorSignalsStore();

    store.load();
    await flushMicrotasks();

    expect(sdk.subscriptions).toHaveLength(0);
    expect(store.state.loadingPhase).toBe('identity');

    await vi.advanceTimersByTimeAsync(CREATOR_IDENTITY_RETRY_INTERVAL_MS);
    await flushMicrotasks();

    expect(sdk.getPublicKey).toHaveBeenCalledTimes(2);
    expect(sdk.subscriptions).toHaveLength(1);
    expect(store.state.error).toBeNull();
  });

  it('shows recoverable unavailable state when identity never resolves', async () => {
    sdk.getPublicKey.mockResolvedValue(null);
    const store = createCreatorSignalsStore();

    store.load();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(CREATOR_IDENTITY_TIMEOUT_MS);
    await flushMicrotasks();

    expect(sdk.subscriptions).toHaveLength(0);
    expect(store.state.loading).toBe(false);
    expect(store.state.loadingPhase).toBe('unavailable');
    expect(store.state.error).toContain('Identity is not ready yet');
  });

  it('stages high-volume subscriptions after creator content', async () => {
    const store = createCreatorSignalsStore();

    store.load();
    await flushMicrotasks();

    expect(sdk.subscriptions).toHaveLength(1);
    expect(sdk.subscriptions[0]?.filter).toMatchObject({
      authors: [SELF],
      kinds: [1, 30023],
      limit: 80,
    });
    expect(store.state.loadingPhase).toBe('content');

    await vi.advanceTimersByTimeAsync(CREATOR_SIGNAL_STAGE_DELAY_MS);
    await flushMicrotasks();
    expect(sdk.subscriptions).toHaveLength(2);
    expect(sdk.subscriptions[1]?.filter).toMatchObject({
      '#p': [SELF],
      limit: 180,
    });
    expect(store.state.loadingPhase).toBe('signals');

    await vi.advanceTimersByTimeAsync(CREATOR_SIGNAL_STAGE_DELAY_MS);
    await flushMicrotasks();
    expect(sdk.subscriptions).toHaveLength(3);
    expect(sdk.subscriptions[2]?.filter).toMatchObject({
      '#P': [SELF],
      kinds: [1111],
      limit: 120,
    });
    expect(store.state.loadingPhase).toBe('comments');
  });

  it('batches relay event bursts into one state update', async () => {
    const onUpdate = vi.fn();
    const store = createCreatorSignalsStore(onUpdate);

    store.load();
    await flushMicrotasks();
    onUpdate.mockClear();

    sdk.subscriptions[0]!.onEvent({ event: nostrEvent({ id: '1'.repeat(64), content: 'first' }) });
    sdk.subscriptions[0]!.onEvent({ event: nostrEvent({ id: '2'.repeat(64), content: 'second' }) });

    expect(onUpdate).not.toHaveBeenCalled();
    await flushMicrotasks();

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(store.state.items).toHaveLength(2);
  });

  it('keeps partial loading active until all staged subscriptions finish', async () => {
    const store = createCreatorSignalsStore();

    store.load();
    await flushMicrotasks();
    sdk.subscriptions[0]!.onEose();
    await flushMicrotasks();

    expect(store.state.loading).toBe(true);
    expect(store.state.loadingPhase).toBe('content');

    await vi.advanceTimersByTimeAsync(CREATOR_SIGNAL_STAGE_DELAY_MS * 2);
    await flushMicrotasks();
    sdk.subscriptions[1]!.onEose();
    sdk.subscriptions[2]!.onEose();
    await flushMicrotasks();

    expect(store.state.loading).toBe(false);
    expect(store.state.loadingPhase).toBe('complete');
    expect(sdk.setItem).toHaveBeenCalledTimes(1);
  });
});
