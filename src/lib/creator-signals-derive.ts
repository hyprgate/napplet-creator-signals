// napplets/creator-signals/src/lib/creator-signals-derive.ts
// Pure derivation + parsing helpers for creator-signals, split out of the store
// module so neither file grows unbounded. No relay/identity/storage I/O here
// except snapshot persistence, which is self-contained.

import { storage } from "@napplet/sdk";
import {
  KIND_CONTACTS,
  KIND_GENERIC_REPOST,
  KIND_REACTION,
  KIND_REPOST,
  KIND_TEXT_NOTE,
  KIND_ZAP_RECEIPT,
  parseNoteViewerReply,
} from '@hyprgate/utils';
import {
  CREATOR_SNAPSHOT_KEY,
  KIND_LONGFORM,
  QUERY_WINDOW_DAYS,
  SECONDS_PER_DAY,
  ZERO_COUNTS,
  type CreatorContent,
  type CreatorContentType,
  type CreatorFilter,
  type CreatorSignal,
  type CreatorSignalKind,
  type CreatorSignalsState,
  type CreatorSnapshot,
  type NostrEvent,
  type RelayMode,
} from './creator-signals-store.js';

export function contentFromEvent(event: NostrEvent, coverageRelays: string[] = []): CreatorContent | null {
  if (event.kind !== KIND_TEXT_NOTE && event.kind !== KIND_LONGFORM) return null;
  const type: CreatorContentType = event.kind === KIND_LONGFORM ? 'article' : 'note';
  return {
    id: event.id,
    address: type === 'article' ? addressForEvent(event) : null,
    kind: event.kind,
    type,
    title: titleForEvent(event, type),
    summary: summarize(event.content, 180),
    createdAt: event.created_at,
    signalIds: [],
    coverageRelays,
  };
}

export function signalFromEvent(event: NostrEvent, selfPubkey: string): CreatorSignal | null {
  if (event.kind === KIND_CONTACTS) {
    if (!hasTagValue(event.tags, 'p', selfPubkey) || event.pubkey === selfPubkey) return null;
    return createSignal(event, 'follow', null, 'Added you to a contact list.');
  }

  if (event.pubkey === selfPubkey) return null;

  const reply = parseNoteViewerReply(event);
  if (reply?.type === 'kind1-reply') {
    return createSignal(event, 'reply', reply.root.id, summarize(event.content, 120));
  }
  if (reply?.type === 'nip22-comment') {
    return createSignal(event, 'comment', referenceKey(reply.root), summarize(event.content, 120));
  }

  if (event.kind === KIND_REACTION) {
    const target = firstTagValue(event.tags, 'e') ?? firstTagValue(event.tags, 'a');
    if (!target) return null;
    return createSignal(event, 'reaction', target, event.content.trim() || '+');
  }

  if (event.kind === KIND_REPOST || event.kind === KIND_GENERIC_REPOST) {
    const target = firstTagValue(event.tags, 'e') ?? firstTagValue(event.tags, 'a');
    if (!target) return null;
    return createSignal(event, 'repost', target, `Reposted kind ${event.kind}.`);
  }

  if (event.kind === KIND_ZAP_RECEIPT) {
    const target = firstTagValue(event.tags, 'e') ?? firstTagValue(event.tags, 'a');
    if (!target) return null;
    return createSignal(event, 'zap', target, 'Zap receipt observed.');
  }

  const quoteTarget = firstTagValue(event.tags, 'q');
  if (event.kind === KIND_TEXT_NOTE && quoteTarget) {
    return createSignal(event, 'repost', quoteTarget, summarize(event.content, 120));
  }

  return null;
}

export function buildCreatorItems(contents: CreatorContent[], signals: CreatorSignal[]): CreatorContent[] {
  const aliasToId = new Map<string, string>();
  for (const content of contents) {
    aliasToId.set(content.id, content.id);
    if (content.address) aliasToId.set(content.address, content.id);
  }

  const signalIdsByContent = new Map<string, string[]>();
  for (const signal of signals) {
    if (!signal.targetKey) continue;
    const contentId = aliasToId.get(signal.targetKey);
    if (!contentId) continue;
    const existing = signalIdsByContent.get(contentId) ?? [];
    existing.push(signal.id);
    signalIdsByContent.set(contentId, existing);
  }

  return contents
    .map((content) => ({
      ...content,
      signalIds: [...new Set(signalIdsByContent.get(content.id) ?? [])],
    }))
    .sort((a, b) => {
      const aLast = latestSignalTime(a, signals) ?? a.createdAt;
      const bLast = latestSignalTime(b, signals) ?? b.createdAt;
      return bLast - aLast || b.signalIds.length - a.signalIds.length || b.createdAt - a.createdAt;
    });
}

export function visibleCreatorItems(state: CreatorSignalsState): CreatorContent[] {
  const q = state.query.trim().toLowerCase();
  const signalById = new Map(state.signals.map((signal) => [signal.id, signal]));
  return state.items.filter((item) => {
    const matchesQuery = !q || [item.title, item.summary, item.type, item.id, item.address ?? '']
      .join(' ')
      .toLowerCase()
      .includes(q);
    if (!matchesQuery) return false;
    if (state.filter === 'all' || state.filter === 'follow') return true;
    return item.signalIds.some((id) => signalById.get(id)?.kind === state.filter);
  });
}

export function selectedCreatorItem(state: CreatorSignalsState): CreatorContent | null {
  return state.items.find((item) => item.id === state.selectedId) ?? visibleCreatorItems(state)[0] ?? null;
}

export function creatorSignalsForItem(item: CreatorContent | null, signals: CreatorSignal[], filter: CreatorFilter): CreatorSignal[] {
  if (!item) return [];
  const ids = new Set(item.signalIds);
  return signals
    .filter((signal) => ids.has(signal.id))
    .filter((signal) => filter === 'all' || filter === 'follow' || signal.kind === filter)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function unattachedSignals(state: CreatorSignalsState): CreatorSignal[] {
  const attached = new Set(state.items.flatMap((item) => item.signalIds));
  return state.signals
    .filter((signal) => !attached.has(signal.id))
    .filter((signal) => state.filter === 'all' || signal.kind === state.filter)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function creatorSignalCounts(signals: CreatorSignal[]): Record<CreatorSignalKind, number> {
  return signals.reduce<Record<CreatorSignalKind, number>>((counts, signal) => {
    counts[signal.kind] += 1;
    return counts;
  }, { ...ZERO_COUNTS });
}

export function itemSignalCounts(item: CreatorContent, signals: CreatorSignal[]): Record<CreatorSignalKind, number> {
  const ids = new Set(item.signalIds);
  return creatorSignalCounts(signals.filter((signal) => ids.has(signal.id)));
}

export function coverageLabel(state: Pick<CreatorSignalsState, 'coverageRelays' | 'queryWindowDays'>): string {
  const count = state.coverageRelays.length;
  const relayWord = count === 1 ? 'relay' : 'relays';
  return `${count} read ${relayWord} / ${state.queryWindowDays}d query window`;
}

export function readableRelays(relays: Record<string, RelayMode>): string[] {
  return Object.entries(relays)
    .filter(([, mode]) => mode.read)
    .map(([url]) => url)
    .sort();
}

export function querySince(): number {
  return Math.floor(Date.now() / 1000) - (QUERY_WINDOW_DAYS * SECONDS_PER_DAY);
}

export async function restoreSnapshot(): Promise<CreatorSnapshot | null> {
  try {
    const raw = await storage.getItem(CREATOR_SNAPSHOT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CreatorSnapshot;
    if (typeof parsed.capturedAt !== 'number') return null;
    return {
      capturedAt: parsed.capturedAt,
      totals: { ...ZERO_COUNTS, ...parsed.totals },
    };
  } catch {
    return null;
  }
}

export function persistSnapshot(snapshot: CreatorSnapshot): void {
  void storage.setItem(CREATOR_SNAPSHOT_KEY, JSON.stringify(snapshot)).catch(() => {});
}

export function createSnapshot(signals: CreatorSignal[]): CreatorSnapshot {
  return {
    capturedAt: Math.floor(Date.now() / 1000),
    totals: creatorSignalCounts(signals),
  };
}

function latestSignalTime(item: CreatorContent, signals: CreatorSignal[]): number | null {
  const ids = new Set(item.signalIds);
  const times = signals.filter((signal) => ids.has(signal.id)).map((signal) => signal.createdAt);
  return times.length > 0 ? Math.max(...times) : null;
}

function createSignal(event: NostrEvent, kind: CreatorSignalKind, targetKey: string | null, summary: string): CreatorSignal {
  return {
    id: event.id,
    kind,
    targetKey,
    author: event.pubkey,
    summary,
    createdAt: event.created_at,
  };
}

function referenceKey(reference: { type: 'event'; id: string } | { type: 'address'; address: string }): string {
  return reference.type === 'event' ? reference.id : reference.address;
}

function addressForEvent(event: NostrEvent): string | null {
  const d = firstTagValue(event.tags, 'd');
  return d ? `${event.kind}:${event.pubkey}:${d}` : null;
}

function titleForEvent(event: NostrEvent, type: CreatorContentType): string {
  const title = firstTagValue(event.tags, 'title') ?? firstTagValue(event.tags, 'subject');
  if (title) return title;
  if (type === 'article') return firstTagValue(event.tags, 'd') ?? `Article ${event.id.slice(0, 10)}`;
  return summarize(event.content, 72);
}

function hasTagValue(tags: string[][], name: string, value: string): boolean {
  return tags.some((tag) => tag[0] === name && tag[1] === value);
}

function firstTagValue(tags: string[][], name: string): string | null {
  return tags.find((tag) => tag[0] === name && tag[1])?.[1] ?? null;
}

function summarize(content: string, maxLength: number): string {
  const trimmed = content.trim().replace(/\s+/g, ' ');
  if (!trimmed) return 'No text content';
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}...` : trimmed;
}
