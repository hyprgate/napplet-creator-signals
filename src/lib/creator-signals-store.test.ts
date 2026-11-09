import { describe, expect, it } from 'vitest';
import {
  buildCreatorItems,
  contentFromEvent,
  creatorSignalsForItem,
  selectedCreatorItem,
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
    expect(coverageLabel({ coverageRelays: ['wss://a.example', 'wss://b.example'], queryWindowDays: 30 })).toBe('what 2 relays returned in the last 30 days');
  });

  it('credits a zap to its sender and words the amount', () => {
    const sender = 'c'.repeat(64);
    const signal = signalFromEvent(event({
      id: 'zap',
      kind: 9735,
      pubkey: 'd'.repeat(64),
      content: '',
      tags: [['p', SELF], ['e', NOTE], ['description', JSON.stringify({ kind: 9734, pubkey: sender, content: 'nice', tags: [['amount', '21000']] })]],
    }), SELF);

    expect(signal?.author).toBe(sender);
    expect(signal?.targetKey).toBe(NOTE);
    expect(signal?.summary).toBe('Zapped 21 sats: nice');
  });

  it('keeps a zap on your profile as other activity instead of dropping it', () => {
    const signal = signalFromEvent(event({ id: 'zap', kind: 9735, tags: [['p', SELF]], content: '' }), SELF);

    expect(signal?.kind).toBe('zap');
    expect(signal?.targetKey).toBeNull();
  });

  it('says what a repost and a reaction mean instead of printing kinds', () => {
    expect(signalFromEvent(event({ id: 'r', kind: 6, tags: [['e', NOTE], ['p', SELF]] }), SELF)?.summary).toBe('Reposted your post');
    expect(signalFromEvent(event({ id: 'l', kind: 7, tags: [['e', NOTE], ['p', SELF]], content: '+' }), SELF)?.summary).toBe('Liked this');
    expect(signalFromEvent(event({ id: 'f', kind: 7, tags: [['e', NOTE], ['p', SELF]], content: '🔥' }), SELF)?.summary).toBe('Reacted 🔥');
  });

  it('marks a quote so it reads differently from a plain repost', () => {
    const signal = signalFromEvent(event({ id: 'q', kind: 1, tags: [['q', NOTE], ['p', SELF]], content: 'good point' }), SELF);

    expect(signal?.kind).toBe('repost');
    expect(signal?.quote).toBe(true);
    expect(signal?.summary).toBe('good point');
  });

  it('keeps the detail pane on a visible post that has the filtered kind', () => {
    const items = [
      { ...contentFromEvent(event({ id: 'with-zap', kind: 1 }))!, signalIds: ['zap'] },
      { ...contentFromEvent(event({ id: 'quiet', kind: 1 }))!, signalIds: [] },
    ];
    const signals = [{ id: 'zap', kind: 'zap' as const, targetKey: 'with-zap', author: 'a', summary: '', createdAt: 1 }];
    const state = { ...createInitialCreatorSignalsState(), items, signals, selectedId: 'quiet', filter: 'zap' as const };

    expect(selectedCreatorItem(state)?.id).toBe('with-zap');
    expect(selectedCreatorItem({ ...state, filter: 'follow' })).toBeNull();
    expect(creatorSignalsForItem(items[0]!, signals, 'follow')).toEqual([]);
  });

  it('reads an article summary from its tag, not its markdown', () => {
    const article = contentFromEvent(event({ kind: 30023, tags: [['d', 'x'], ['title', 'T'], ['summary', 'Short']], content: '# T\n\nBody' }));
    const untagged = contentFromEvent(event({ kind: 30023, tags: [['d', 'x'], ['title', 'T']], content: '# T\n\nBody' }));

    expect(article?.summary).toBe('Short');
    expect(untagged?.summary).toBe('Body');
  });
});
