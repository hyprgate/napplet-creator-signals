import { describe, expect, it } from 'vitest';
import {
  buildCreatorItems,
  contentFromEvent,
  coverageLabel,
  createInitialCreatorSignalsState,
  creatorSignalCounts,
  signalFromEvent,
  visibleCreatorItems,
  type CreatorContent,
  type CreatorSignal,
} from './creator-signals-store';

const SELF = 'a'.repeat(64);
const AUTHOR = 'b'.repeat(64);
const NOTE = '1'.repeat(64);
const ARTICLE = '2'.repeat(64);

function event(partial: Partial<Parameters<typeof contentFromEvent>[0]>): Parameters<typeof contentFromEvent>[0] {
  return {
    id: partial.id ?? 'e'.repeat(64),
    pubkey: partial.pubkey ?? AUTHOR,
    created_at: partial.created_at ?? 1,
    kind: partial.kind ?? 1,
    tags: partial.tags ?? [],
    content: partial.content ?? 'hello',
    sig: partial.sig ?? 's',
  };
}

describe('creator signals store', () => {
  it('starts empty instead of loading deterministic fixtures', () => {
    const state = createInitialCreatorSignalsState();

    expect(state.items).toEqual([]);
    expect(state.signals).toEqual([]);
    expect(state.queryWindowDays).toBe(30);
  });

  it('converts notes and NIP-23 articles into creator content', () => {
    const note = contentFromEvent(event({ id: NOTE, pubkey: SELF, content: 'short note' }), ['wss://relay.example']);
    const article = contentFromEvent(event({
      id: ARTICLE,
      pubkey: SELF,
      kind: 30023,
      tags: [['d', 'creator-signals'], ['title', 'Creator Signals Post']],
      content: 'long form body',
    }));

    expect(note).toMatchObject({
      id: NOTE,
      type: 'note',
      title: 'short note',
      coverageRelays: ['wss://relay.example'],
    });
    expect(article).toMatchObject({
      id: ARTICLE,
      type: 'article',
      address: `30023:${SELF}:creator-signals`,
      title: 'Creator Signals Post',
    });
  });

  it('classifies replies, comments, reactions, reposts, zaps, and follow-list mentions', () => {
    expect(signalFromEvent(event({
      id: 'reply',
      kind: 1,
      tags: [['e', NOTE, '', 'root'], ['p', SELF]],
      content: 'reply text',
    }), SELF)?.kind).toBe('reply');

    expect(signalFromEvent(event({
      id: 'comment',
      kind: 1111,
      tags: [['E', ARTICLE], ['K', '30023'], ['P', SELF]],
      content: 'comment text',
    }), SELF)?.kind).toBe('comment');

    expect(signalFromEvent(event({ id: 'reaction', kind: 7, tags: [['e', NOTE], ['p', SELF]], content: '+' }), SELF)?.kind).toBe('reaction');
    expect(signalFromEvent(event({ id: 'repost', kind: 6, tags: [['e', NOTE], ['p', SELF]] }), SELF)?.kind).toBe('repost');
    expect(signalFromEvent(event({ id: 'zap', kind: 9735, tags: [['e', NOTE], ['p', SELF]] }), SELF)?.kind).toBe('zap');
    expect(signalFromEvent(event({ id: 'follow', kind: 3, tags: [['p', SELF]] }), SELF)?.kind).toBe('follow');
  });

  it('attaches signals by event id and address target', () => {
    const contents: CreatorContent[] = [
      contentFromEvent(event({ id: NOTE, pubkey: SELF, content: 'note' }))!,
      contentFromEvent(event({
        id: ARTICLE,
        pubkey: SELF,
        kind: 30023,
        tags: [['d', 'post']],
        content: 'article',
      }))!,
    ];
    const signals: CreatorSignal[] = [
      signalFromEvent(event({ id: 'reaction', kind: 7, tags: [['e', NOTE], ['p', SELF]] }), SELF)!,
      signalFromEvent(event({ id: 'article-zap', kind: 9735, tags: [['a', `30023:${SELF}:post`], ['p', SELF]] }), SELF)!,
    ];

    const grouped = buildCreatorItems(contents, signals);

    expect(grouped.find((item) => item.id === NOTE)?.signalIds).toEqual(['reaction']);
    expect(grouped.find((item) => item.id === ARTICLE)?.signalIds).toEqual(['article-zap']);
  });

  it('filters visible content by query and selected signal kind', () => {
    const note = contentFromEvent(event({ id: NOTE, pubkey: SELF, content: 'alpha note' }))!;
    const reaction = signalFromEvent(event({ id: 'reaction', kind: 7, tags: [['e', NOTE], ['p', SELF]] }), SELF)!;
    const items = buildCreatorItems([note], [reaction]);
    const state = { ...createInitialCreatorSignalsState(), items, signals: [reaction], query: 'alpha', filter: 'reaction' as const };

    expect(visibleCreatorItems(state)).toHaveLength(1);
    expect(visibleCreatorItems({ ...state, filter: 'zap' })).toHaveLength(0);
  });

  it('counts signals and labels coverage as a query window, not exact totals', () => {
    const signals: CreatorSignal[] = [
      { id: 'a', kind: 'reply', targetKey: NOTE, author: AUTHOR, summary: 'a', createdAt: 1 },
      { id: 'b', kind: 'reply', targetKey: NOTE, author: AUTHOR, summary: 'b', createdAt: 2 },
      { id: 'c', kind: 'zap', targetKey: NOTE, author: AUTHOR, summary: 'c', createdAt: 3 },
    ];

    expect(creatorSignalCounts(signals)).toMatchObject({ reply: 2, zap: 1 });
    expect(coverageLabel({ coverageRelays: ['wss://a.example', 'wss://b.example'], queryWindowDays: 30 })).toBe('2 read relays / 30d query window');
  });
});
