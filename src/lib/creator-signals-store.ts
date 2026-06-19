import type { NostrEvent } from '@hyprgate/types';
import { identity, relay, type Subscription } from "@napplet/sdk";
import {
  KIND_CONTACTS,
  KIND_GENERIC_REPOST,
  KIND_NIP22_COMMENT,
  KIND_REACTION,
  KIND_REPOST,
  KIND_TEXT_NOTE,
  KIND_ZAP_RECEIPT,
} from '@hyprgate/utils';
import {
  contentFromEvent,
  createSnapshot,
  persistSnapshot,
  querySince,
  readableRelays,
  restoreSnapshot,
  signalFromEvent,
  buildCreatorItems,
} from './creator-signals-derive.js';

// Derivation/parsing helpers live in ./creator-signals-derive; re-exported here
// so existing import paths (and tests) stay stable.
export {
  buildCreatorItems,
  contentFromEvent,
  coverageLabel,
  creatorSignalCounts,
  creatorSignalsForItem,
  itemSignalCounts,
  selectedCreatorItem,
  signalFromEvent,
  unattachedSignals,
  visibleCreatorItems,
} from './creator-signals-derive.js';

// NostrEvent is the canonical NIP-01 event from @hyprgate/types; re-exported
// here so ./creator-signals-derive and other local importers keep one path.
export type { NostrEvent };

interface NostrFilter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  [key: `#${string}`]: string[] | undefined;
}

export interface RelayMode {
  read?: boolean;
  write?: boolean;
}

export type CreatorContentType = 'note' | 'article';
export type CreatorSignalKind = 'reply' | 'comment' | 'reaction' | 'repost' | 'zap' | 'follow';
export type CreatorFilter = CreatorSignalKind | 'all';

export interface CreatorContent {
  id: string;
  address: string | null;
  kind: number;
  type: CreatorContentType;
  title: string;
  summary: string;
  createdAt: number;
  signalIds: string[];
  coverageRelays: string[];
}

export interface CreatorSignal {
  id: string;
  kind: CreatorSignalKind;
  targetKey: string | null;
  author: string;
  summary: string;
  createdAt: number;
}

export interface CreatorSnapshot {
  capturedAt: number;
  totals: Record<CreatorSignalKind, number>;
}

export interface CreatorSignalsState {
  items: CreatorContent[];
  signals: CreatorSignal[];
  selectedId: string | null;
  filter: CreatorFilter;
  query: string;
  loading: boolean;
  error: string | null;
  coverageRelays: string[];
  queryWindowDays: number;
  snapshot: CreatorSnapshot | null;
  lastUpdatedAt: number | null;
}

export interface CreatorSignalsStore {
  state: CreatorSignalsState;
  load(): void;
  setFilter(filter: CreatorFilter): void;
  setQuery(query: string): void;
  select(id: string): void;
  destroy(): void;
}

export const KIND_LONGFORM = 30023;
export const CREATOR_SNAPSHOT_KEY = 'creator-signals:snapshot:v1';
export const QUERY_WINDOW_DAYS = 30;
export const SECONDS_PER_DAY = 86_400;
const SIGNAL_KINDS = [
  KIND_TEXT_NOTE,
  KIND_NIP22_COMMENT,
  KIND_REACTION,
  KIND_REPOST,
  KIND_GENERIC_REPOST,
  KIND_ZAP_RECEIPT,
  KIND_CONTACTS,
] as const;
export const ZERO_COUNTS: Record<CreatorSignalKind, number> = {
  reply: 0,
  comment: 0,
  reaction: 0,
  repost: 0,
  zap: 0,
  follow: 0,
};

export function createInitialCreatorSignalsState(): CreatorSignalsState {
  return {
    items: [],
    signals: [],
    selectedId: null,
    filter: 'all',
    query: '',
    loading: false,
    error: null,
    coverageRelays: [],
    queryWindowDays: QUERY_WINDOW_DAYS,
    snapshot: null,
    lastUpdatedAt: null,
  };
}

interface CreatorSignalsContext {
  state: CreatorSignalsState;
  contents: Map<string, CreatorContent>;
  signals: Map<string, CreatorSignal>;
  subs: Subscription[];
  pendingEose: number;
  notify(): void;
}

function rebuild(ctx: CreatorSignalsContext): void {
  ctx.state.items = buildCreatorItems([...ctx.contents.values()], [...ctx.signals.values()]);
  ctx.state.signals = [...ctx.signals.values()].sort((a, b) => b.createdAt - a.createdAt);
  if (!ctx.state.selectedId || !ctx.state.items.some((item) => item.id === ctx.state.selectedId)) {
    ctx.state.selectedId = ctx.state.items[0]?.id ?? null;
  }
  ctx.state.lastUpdatedAt = ctx.state.signals[0]?.createdAt ?? ctx.state.items[0]?.createdAt ?? null;
}

function destroyStore(ctx: CreatorSignalsContext): void {
  for (const sub of ctx.subs.splice(0)) sub.close();
  ctx.pendingEose = 0;
}

function subscribe(ctx: CreatorSignalsContext, filter: NostrFilter, onEvent: (event: NostrEvent) => void): void {
  ctx.pendingEose += 1;
  const sub = relay.subscribe(
    filter,
    (event) => {
      onEvent(event);
      rebuild(ctx);
      ctx.notify();
    },
    () => {
      ctx.pendingEose = Math.max(0, ctx.pendingEose - 1);
      if (ctx.pendingEose === 0) {
        ctx.state.loading = false;
        persistSnapshot(createSnapshot(ctx.state.signals));
      }
      rebuild(ctx);
      ctx.notify();
    },
  );
  ctx.subs.push(sub);
}

async function load(ctx: CreatorSignalsContext): Promise<void> {
  destroyStore(ctx);
  ctx.contents.clear();
  ctx.signals.clear();
  ctx.state.loading = true;
  ctx.state.error = null;
  ctx.state.selectedId = null;
  ctx.state.snapshot = await restoreSnapshot();
  rebuild(ctx);
  ctx.notify();

  try {
    const [self, relayMap] = await Promise.all([
      identity.getPublicKey(),
      identity.getRelays().catch(() => ({} as Record<string, RelayMode>)),
    ]);
    ctx.state.coverageRelays = readableRelays(relayMap);
    const since = querySince();

    subscribe(ctx, { authors: [self], kinds: [KIND_TEXT_NOTE, KIND_LONGFORM], since, limit: 80 }, (event) => {
      const content = contentFromEvent(event, ctx.state.coverageRelays);
      if (content) ctx.contents.set(content.id, content);
    });
    subscribe(ctx, { kinds: [...SIGNAL_KINDS], '#p': [self], since, limit: 260 }, (event) => {
      const signal = signalFromEvent(event, self);
      if (signal) ctx.signals.set(signal.id, signal);
    });
    subscribe(ctx, { kinds: [KIND_NIP22_COMMENT], '#P': [self], since, limit: 160 }, (event) => {
      const signal = signalFromEvent(event, self);
      if (signal) ctx.signals.set(signal.id, signal);
    });
  } catch (error) {
    ctx.state.loading = false;
    ctx.state.error = error instanceof Error ? error.message : 'Unable to load creator signals.';
    ctx.notify();
  }
}

export function createCreatorSignalsStore(onUpdate?: () => void): CreatorSignalsStore {
  const ctx: CreatorSignalsContext = {
    state: createInitialCreatorSignalsState(),
    contents: new Map<string, CreatorContent>(),
    signals: new Map<string, CreatorSignal>(),
    subs: [],
    pendingEose: 0,
    notify: () => onUpdate?.(),
  };

  return {
    state: ctx.state,
    load: () => { void load(ctx); },
    setFilter(filter: CreatorFilter): void {
      ctx.state.filter = filter;
      ctx.notify();
    },
    setQuery(query: string): void {
      ctx.state.query = query;
      ctx.notify();
    },
    select(id: string): void {
      ctx.state.selectedId = id;
      ctx.notify();
    },
    destroy: () => destroyStore(ctx),
  };
}
