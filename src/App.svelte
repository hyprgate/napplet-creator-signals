<script lang="ts">
  import { onMount } from 'svelte';
  import { inc as ipc } from '@napplet/sdk';
  import {
    NOTE_VIEWER_OPEN_TOPIC,
    createNoteViewerOpenPayload,
    pubkeyColorStyle,
  } from '@hyprgate/utils';
  import {
    coverageLabel,
    createCreatorSignalsStore,
    creatorSignalCounts,
    creatorSignalsForItem,
    itemSignalCounts,
    selectedCreatorItem,
    unattachedSignals,
    visibleCreatorItems,
    type CreatorContent,
    type CreatorFilter,
    type CreatorSignal,
    type CreatorSignalsState,
  } from './lib/creator-signals-store';

  let state = $state<CreatorSignalsState>({
    items: [],
    signals: [],
    selectedId: null,
    filter: 'all',
    query: '',
    loading: true,
    error: null,
    coverageRelays: [],
    queryWindowDays: 30,
    snapshot: null,
    lastUpdatedAt: null,
  });
  const store = createCreatorSignalsStore(() => {
    state = { ...store.state };
  });
  const filters: CreatorFilter[] = ['all', 'reply', 'comment', 'reaction', 'repost', 'zap'];
  const items = $derived(visibleCreatorItems(state));
  const selected = $derived(selectedCreatorItem(state));
  const selectedSignals = $derived(creatorSignalsForItem(selected, state.signals, state.filter));
  const orphanSignals = $derived(unattachedSignals(state));
  const totals = $derived(creatorSignalCounts(state.signals));
  const coverage = $derived(coverageLabel(state));

  onMount(() => {
    store.load();
    return () => store.destroy();
  });

  function setFilter(filter: CreatorFilter): void {
    store.setFilter(filter);
  }

  function setQuery(value: string): void {
    store.setQuery(value);
  }

  function selectItem(item: CreatorContent): void {
    store.select(item.id);
  }

  function openItem(item: CreatorContent): void {
    const payload = createNoteViewerOpenPayload({
      target: { type: 'event', id: item.id, kind: item.kind },
      source: { napplet: 'creator-signals' },
      behavior: { focus: true, newWindow: true },
    });
    if (payload) ipc.emit(NOTE_VIEWER_OPEN_TOPIC, [], JSON.stringify(payload));
  }

  function openSignalAuthor(signal: CreatorSignal): void {
    ipc.emit('profile:open', [], JSON.stringify({ pubkey: signal.author }));
  }

  function delta(kind: keyof typeof totals): number | null {
    return state.snapshot ? totals[kind] - state.snapshot.totals[kind] : null;
  }

  function formatAge(timestamp: number | null): string {
    if (!timestamp) return 'no activity';
    const seconds = Math.max(0, Math.floor(Date.now() / 1000) - timestamp);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }
</script>

<main class="signals-shell">
  <header class="toolbar">
    <div class="title-block">
      <span class="eyebrow">creator signals</span>
      <h1>Relay-windowed engagement</h1>
    </div>
    <input
      aria-label="Search creator content"
      placeholder="filter notes, articles, ids..."
      value={state.query}
      oninput={(event) => setQuery(event.currentTarget.value)}
    />
  </header>

  <section class="metrics" aria-label="Signal totals">
    <div>
      <strong>{totals.reply}</strong>
      <span>replies {delta('reply') === null ? '' : `(${delta('reply')! >= 0 ? '+' : ''}${delta('reply')})`}</span>
    </div>
    <div>
      <strong>{totals.comment}</strong>
      <span>comments {delta('comment') === null ? '' : `(${delta('comment')! >= 0 ? '+' : ''}${delta('comment')})`}</span>
    </div>
    <div>
      <strong>{totals.reaction}</strong>
      <span>reactions {delta('reaction') === null ? '' : `(${delta('reaction')! >= 0 ? '+' : ''}${delta('reaction')})`}</span>
    </div>
    <div>
      <strong>{totals.repost}</strong>
      <span>reposts {delta('repost') === null ? '' : `(${delta('repost')! >= 0 ? '+' : ''}${delta('repost')})`}</span>
    </div>
    <div>
      <strong>{totals.zap}</strong>
      <span>zaps {delta('zap') === null ? '' : `(${delta('zap')! >= 0 ? '+' : ''}${delta('zap')})`}</span>
    </div>
    <div>
      <strong>{totals.follow}</strong>
      <span>follow-list mentions</span>
    </div>
  </section>

  <section class="filters" aria-label="Signal filters">
    {#each filters as filter}
      <button type="button" class:active={state.filter === filter} onclick={() => setFilter(filter)}>
        {filter}
      </button>
    {/each}
    <span>{coverage}</span>
    <span>updated {formatAge(state.lastUpdatedAt)}</span>
  </section>

  <section class="content">
    <section class="items" aria-label="Creator content">
      {#each items as item}
        {@const counts = itemSignalCounts(item, state.signals)}
        <button type="button" class="item" class:selected={selected?.id === item.id} onclick={() => selectItem(item)}>
          <span class="kind">{item.type}</span>
          <strong>{item.title}</strong>
          <span class="summary">{item.summary}</span>
          <span class="signal-strip">
            {counts.reply}r / {counts.comment}c / {counts.reaction}react / {counts.repost}rp / {counts.zap}zap
          </span>
        </button>
      {/each}
      {#if state.loading}
        <p class="empty">Loading creator signals...</p>
      {:else if state.error}
        <p class="empty">{state.error}</p>
      {:else if items.length === 0}
        <p class="empty">No matching recent notes or articles found for this relay window.</p>
      {/if}
    </section>

    <aside class="detail">
      {#if selected}
        <div class="detail-head">
          <div>
            <span class="eyebrow">{selected.type} / kind {selected.kind}</span>
            <h2>{selected.title}</h2>
          </div>
          <button type="button" onclick={() => openItem(selected)}>Open</button>
        </div>
        <p class="coverage-note">
          Counts reflect events returned by {coverage}; they are coverage signals, not global totals.
        </p>
        <code>{selected.address ?? selected.id}</code>
        <div class="signal-list">
          {#each selectedSignals as signal}
            <article>
              <button type="button" class="author" style={pubkeyColorStyle(signal.author)} onclick={() => openSignalAuthor(signal)}>
                {signal.author}
              </button>
              <span>{signal.kind} / {formatAge(signal.createdAt)}</span>
              <p>{signal.summary}</p>
            </article>
          {/each}
          {#if selectedSignals.length === 0}
            <p class="empty">No {state.filter === 'all' ? '' : `${state.filter} `}signals mapped to this item yet.</p>
          {/if}
        </div>
      {/if}
    </aside>

    <aside class="loose" aria-label="Unmapped creator activity">
      <span class="eyebrow">unmapped</span>
      <h2>Audience drift</h2>
      <p>Follow-list mentions and signals whose target content was not in the current query window.</p>
      <div class="loose-list">
        {#each orphanSignals.slice(0, 18) as signal}
          <article>
            <span>{signal.kind} / {formatAge(signal.createdAt)}</span>
            <button type="button" class="author" style={pubkeyColorStyle(signal.author)} onclick={() => openSignalAuthor(signal)}>
              {signal.author}
            </button>
            <p>{signal.summary}</p>
          </article>
        {/each}
        {#if orphanSignals.length === 0}
          <p class="empty">No unmapped activity in this view.</p>
        {/if}
      </div>
    </aside>
  </section>
</main>

<style>
  :global(body) {
    margin: 0;
    background: var(--hg-bg, #070707);
    color: var(--hg-text, #f3f1e8);
    font-family: var(--hg-font-body, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  }

  .signals-shell {
    height: 100vh;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .toolbar, .metrics, .filters {
    border-bottom: 1px solid var(--hg-border, #303030);
    background: var(--hg-surface, #101010);
  }

  .toolbar {
    display: grid;
    grid-template-columns: minmax(220px, 0.7fr) minmax(220px, 1fr);
    gap: 14px;
    align-items: end;
    padding: 10px 12px;
  }

  h1, h2, p {
    margin: 0;
    letter-spacing: 0;
  }

  h1 {
    font-size: 18px;
    line-height: 1.2;
  }

  h2 {
    font-size: 16px;
    line-height: 1.25;
  }

  .eyebrow, .kind {
    color: var(--hg-accent, #9ee493);
    font-size: 11px;
    text-transform: uppercase;
  }

  input, button {
    border: 1px solid var(--hg-border, #303030);
    border-radius: 6px;
    background: #0b0b0b;
    color: var(--hg-text, #f3f1e8);
    font: inherit;
    padding: 8px 10px;
  }

  button {
    cursor: pointer;
  }

  button:hover, button.active, button.selected, input:focus {
    border-color: var(--hg-accent, #9ee493);
    outline: none;
  }

  .metrics {
    display: grid;
    grid-template-columns: repeat(6, minmax(90px, 1fr));
  }

  .metrics div {
    padding: 10px 12px;
    border-right: 1px solid var(--hg-border, #303030);
  }

  .metrics strong {
    display: block;
    color: var(--hg-accent-cyan, #82d8f7);
    font-size: 18px;
  }

  .metrics span, .filters span, .summary, .signal-strip, .coverage-note, .loose p {
    color: var(--hg-text-muted, #b8b1a4);
  }

  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    padding: 8px 12px;
  }

  .filters span {
    font-size: 12px;
  }

  .content {
    min-height: 0;
    flex: 1;
    display: grid;
    grid-template-columns: minmax(280px, 0.95fr) minmax(320px, 1fr) minmax(230px, 0.65fr);
  }

  .items, .detail, .loose {
    min-width: 0;
    overflow: auto;
  }

  .items {
    padding: 12px;
  }

  .item {
    width: 100%;
    display: grid;
    grid-template-columns: 70px minmax(0, 1fr);
    grid-template-rows: auto auto auto;
    gap: 5px 10px;
    text-align: left;
    margin-bottom: 8px;
  }

  .item .summary, .item .signal-strip {
    grid-column: 2;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .detail {
    border-left: 1px solid var(--hg-border, #303030);
    border-right: 1px solid var(--hg-border, #303030);
    background: var(--hg-surface, #101010);
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .detail-head {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: start;
  }

  code {
    color: var(--hg-accent-cyan, #82d8f7);
    overflow-wrap: anywhere;
  }

  .signal-list, .loose-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  article {
    border: 1px solid var(--hg-border, #303030);
    border-radius: 6px;
    padding: 10px;
  }

  article span {
    color: var(--hg-accent, #9ee493);
    display: block;
    font-size: 11px;
    margin-bottom: 6px;
    text-transform: uppercase;
  }

  .author {
    border: 0;
    background: transparent;
    padding: 0;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    text-align: left;
    white-space: nowrap;
  }

  article p {
    color: var(--hg-text-muted, #b8b1a4);
    margin-top: 6px;
  }

  .loose {
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .empty {
    color: var(--hg-text-muted, #b8b1a4);
    padding: 10px;
  }

  @media (max-width: 940px) {
    .toolbar, .content {
      display: flex;
      flex-direction: column;
    }

    .metrics {
      grid-template-columns: repeat(3, minmax(90px, 1fr));
    }

    .detail {
      border-left: 0;
      border-right: 0;
      border-top: 1px solid var(--hg-border, #303030);
      border-bottom: 1px solid var(--hg-border, #303030);
    }
  }

  @media (max-width: 560px) {
    .metrics {
      grid-template-columns: repeat(2, minmax(90px, 1fr));
    }

    .item {
      grid-template-columns: 1fr;
    }

    .item .summary, .item .signal-strip {
      grid-column: 1;
    }
  }
</style>
