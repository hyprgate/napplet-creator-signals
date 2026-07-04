import type { NostrEvent } from '@hyprgate/types';
import { identity, relay, type Subscription } from "@napplet/sdk";
import {
  isCanonicalHexPubkey,
  KIND_CONTACTS,
  KIND_GENERIC_REPOST,
  KIND_NIP22_COMMENT,
  KIND_REACTION,
  KIND_REPOST,
  KIND_TEXT_NOTE,
  KIND_ZAP_RECEIPT,
  waitForPublicKey,
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
export type CreatorLoadingPhase = 'idle' | 'identity' | 'content' | 'signals' | 'comments' | 'complete' | 'unavailable';

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
  loadingPhase: CreatorLoadingPhase;
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
export const CREATOR_IDENTITY_TIMEOUT_MS = 2500;
export const CREATOR_IDENTITY_RETRY_INTERVAL_MS = 100;
export const CREATOR_SIGNAL_STAGE_DELAY_MS = 250;
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
    loadingPhase: 'idle',
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
  stageTimers: ReturnType<typeof setTimeout>[];
  pendingEose: number;
  pendingStages: number;
  loadGeneration: number;
  rebuildScheduled: boolean;
  persistAfterRebuild: boolean;
  notify(): void;
}

function scheduleRebuild(ctx: CreatorSignalsContext): void {
  if (ctx.rebuildScheduled) return;
  ctx.rebuildScheduled = true;
  const generation = ctx.loadGeneration;
  queueMicrotask(() => {
    if (generation !== ctx.loadGeneration) return;
    ctx.rebuildScheduled = false;
    rebuild(ctx);
    if (ctx.persistAfterRebuild) {
      ctx.persistAfterRebuild = false;
      persistSnapshot(createSnapshot(ctx.state.signals));
    }
    ctx.notify();
  });
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
  ctx.loadGeneration += 1;
  for (const sub of ctx.subs.splice(0)) sub.close();
  for (const timer of ctx.stageTimers.splice(0)) clearTimeout(timer);
  ctx.pendingEose = 0;
  ctx.pendingStages = 0;
  ctx.rebuildScheduled = false;
  ctx.persistAfterRebuild = false;
}

function completeStage(ctx: CreatorSignalsContext): void {
  ctx.pendingStages = Math.max(0, ctx.pendingStages - 1);
  if (ctx.pendingEose === 0 && ctx.pendingStages === 0) {
    ctx.state.loading = false;
    ctx.state.loadingPhase = 'complete';
    ctx.persistAfterRebuild = true;
  }
}

function subscribe(ctx: CreatorSignalsContext, filter: NostrFilter, onEvent: (event: NostrEvent) => void): void {
  ctx.pendingEose += 1;
  try {
    const sub = relay.subscribe(
      filter,
      (result) => {
        const event = result.event as NostrEvent;
        onEvent(event);
        scheduleRebuild(ctx);
      },
      () => {
        ctx.pendingEose = Math.max(0, ctx.pendingEose - 1);
        completeStage(ctx);
        scheduleRebuild(ctx);
      },
    );
    ctx.subs.push(sub);
  } catch (error) {
    ctx.pendingEose = Math.max(0, ctx.pendingEose - 1);
    ctx.state.error = error instanceof Error
      ? `Creator Signals loaded with partial coverage: ${error.message}`
      : 'Creator Signals loaded with partial coverage.';
    completeStage(ctx);
    scheduleRebuild(ctx);
  }
}

function runStage(
  ctx: CreatorSignalsContext,
  generation: number,
  phase: CreatorLoadingPhase,
  run: () => void,
): void {
  if (generation !== ctx.loadGeneration) return;
  ctx.state.loadingPhase = phase;
  run();
  scheduleRebuild(ctx);
}

function scheduleStage(
  ctx: CreatorSignalsContext,
  generation: number,
  delayMs: number,
  phase: CreatorLoadingPhase,
  run: () => void,
): void {
  const timer = setTimeout(() => {
    const index = ctx.stageTimers.indexOf(timer);
    if (index >= 0) ctx.stageTimers.splice(index, 1);
    runStage(ctx, generation, phase, run);
  }, delayMs);
  ctx.stageTimers.push(timer);
}

async function load(ctx: CreatorSignalsContext): Promise<void> {
  destroyStore(ctx);
  const generation = ctx.loadGeneration;
  ctx.contents.clear();
  ctx.signals.clear();
  ctx.state.loading = true;
  ctx.state.loadingPhase = 'identity';
  ctx.state.error = null;
  ctx.state.selectedId = null;
  ctx.state.snapshot = await restoreSnapshot();
  rebuild(ctx);
  ctx.notify();

  try {
    const self = await waitForPublicKey(identity, {
      timeoutMs: CREATOR_IDENTITY_TIMEOUT_MS,
      intervalMs: CREATOR_IDENTITY_RETRY_INTERVAL_MS,
      isValidPubkey: isCanonicalHexPubkey,
    });
    if (generation !== ctx.loadGeneration) return;
    if (!self) {
      ctx.state.loading = false;
      ctx.state.loadingPhase = 'unavailable';
      ctx.state.error = 'Identity is not ready yet. Reopen Creator Signals once the runtime identity service is ready.';
      ctx.notify();
      return;
    }

    const relayMap = await identity.getRelays().catch(() => ({} as Record<string, RelayMode>));
    if (generation !== ctx.loadGeneration) return;
    ctx.state.coverageRelays = readableRelays(relayMap);
    const since = querySince();
    ctx.pendingStages = 3;

    runStage(ctx, generation, 'content', () => {
      subscribe(ctx, { authors: [self], kinds: [KIND_TEXT_NOTE, KIND_LONGFORM], since, limit: 80 }, (event) => {
        const content = contentFromEvent(event, ctx.state.coverageRelays);
        if (content) ctx.contents.set(content.id, content);
      });
    });
    scheduleStage(ctx, generation, CREATOR_SIGNAL_STAGE_DELAY_MS, 'signals', () => {
      subscribe(ctx, { kinds: [...SIGNAL_KINDS], '#p': [self], since, limit: 180 }, (event) => {
        const signal = signalFromEvent(event, self);
        if (signal) ctx.signals.set(signal.id, signal);
      });
    });
    scheduleStage(ctx, generation, CREATOR_SIGNAL_STAGE_DELAY_MS * 2, 'comments', () => {
      subscribe(ctx, { kinds: [KIND_NIP22_COMMENT], '#P': [self], since, limit: 120 }, (event) => {
        const signal = signalFromEvent(event, self);
        if (signal) ctx.signals.set(signal.id, signal);
      });
    });
  } catch (error) {
    if (generation !== ctx.loadGeneration) return;
    ctx.state.loading = false;
    ctx.state.loadingPhase = 'unavailable';
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
    stageTimers: [],
    pendingEose: 0,
    pendingStages: 0,
    loadGeneration: 0,
    rebuildScheduled: false,
    persistAfterRebuild: false,
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
