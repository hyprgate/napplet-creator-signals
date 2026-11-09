<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { Subscription } from '@napplet/sdk';
  import { parseIntentResult, type IntentRequest } from '@hyprgate/types';
  import {
    invokeNappletIntent,
    createNoteViewerOpenIntentRequest,
    createNoteViewerOpenPayload,
    createProfileIntentRequest,
    pubkeyColorStyle,
    resourceImage,
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
    type CreatorSignalKind,
    type CreatorSignalsState,
  } from './lib/creator-signals-store';
  import { subscribeProfileMetadata } from './lib/profile-metadata';
  import {
    fallbackNpub,
    profileLabel,
    safeProfilePicture,
    uniqueSignalAuthors,
    type ProfileContent,
  } from './lib/profile-display';

  let state = $state.raw<CreatorSignalsState>({
    items: [],
    signals: [],
    selectedId: null,
    filter: 'all',
    query: '',
    loading: true,
    loadingPhase: 'identity',
    error: null,
    coverageRelays: [],
    queryWindowDays: 30,
    snapshot: null,
    lastUpdatedAt: null,
  });
  const store = createCreatorSignalsStore(() => {
    state = { ...store.state };
  });
  const kinds: Array<{ id: CreatorSignalKind; label: string; singular: string; plural: string; verb: string }> = [
    { id: 'reply', label: 'Replies', singular: 'reply', plural: 'replies', verb: 'replied' },
    { id: 'comment', label: 'Comments', singular: 'comment', plural: 'comments', verb: 'commented' },
    { id: 'reaction', label: 'Reactions', singular: 'reaction', plural: 'reactions', verb: 'reacted' },
    { id: 'repost', label: 'Reposts', singular: 'repost', plural: 'reposts', verb: 'reposted' },
    { id: 'zap', label: 'Zaps', singular: 'zap', plural: 'zaps', verb: 'zapped' },
    { id: 'follow', label: 'Follows', singular: 'follow', plural: 'follows', verb: 'follows you' },
  ];
  const items = $derived(visibleCreatorItems(state));
  const selected = $derived(selectedCreatorItem(state));
  const selectedSignals = $derived(creatorSignalsForItem(selected, state.signals, state.filter));
  const orphanSignals = $derived(unattachedSignals(state));
  const totals = $derived(creatorSignalCounts(state.signals));
  const coverage = $derived(coverageLabel(state));
  let otherOpen = $state(false);
  let detailOpen = $state(false);
  let backButton = $state<HTMLButtonElement | null>(null);
  // Other activity is the only pane left when no post matches, such as under Follows.
  const showOther = $derived(orphanSignals.length > 0 && (otherOpen || !selected));
  const visibleSignalAuthors = $derived(uniqueSignalAuthors(showOther ? orphanSignals : selectedSignals).join(','));
  const hasPane = $derived(showOther || !!selected);
  let profiles = $state.raw(new Map<string, ProfileContent>());
  let profileSub: Subscription | null = null;

  onMount(() => {
    store.load();
    return () => {
      profileSub?.close();
      store.destroy();
    };
  });

  $effect(() => {
    const authors = visibleSignalAuthors ? visibleSignalAuthors.split(',') : [];
    profileSub?.close();
    profileSub = subscribeProfileMetadata(authors, (pubkey, profile) => {
      profiles = new Map(profiles).set(pubkey, profile);
    });
    return () => profileSub?.close();
  });

  function setFilter(filter: CreatorFilter): void {
    store.setFilter(filter);
  }

  function setQuery(value: string): void {
    store.setQuery(value);
  }

  async function focusBack(): Promise<void> {
    detailOpen = true;
    await tick();
    if (backButton?.offsetParent) backButton.focus();
  }

  function selectItem(item: CreatorContent): void {
    otherOpen = false;
    store.select(item.id);
    void focusBack();
  }

  function selectOther(): void {
    otherOpen = true;
    void focusBack();
  }

  async function closeDetail(): Promise<void> {
    detailOpen = false;
    await tick();
    document.querySelector<HTMLElement>('.item.selected')?.focus();
  }

  async function invokeNavigation(request: IntentRequest | null): Promise<void> {
    if (!request) return;
    try {
      const result = parseIntentResult(await invokeNappletIntent(request));
      if (!result || result.archetype !== request.archetype || result.action !== (request.action ?? 'open')) return;
      if (!result.ok) return;
    } catch {
      // Keep the existing no-op behavior when navigation is unavailable.
    }
  }

  async function openItem(item: CreatorContent): Promise<void> {
    const payload = createNoteViewerOpenPayload({
      target: { type: 'event', id: item.id, kind: item.kind },
      source: { napplet: 'creator-signals' },
      behavior: { focus: true, reuse: false },
    });
    await invokeNavigation(payload ? createNoteViewerOpenIntentRequest(payload, { behavior: payload.behavior }) : null);
  }

  async function openSignalAuthor(signal: CreatorSignal): Promise<void> {
    await invokeNavigation(createProfileIntentRequest({ pubkey: signal.author }));
  }

  function shortNpub(pubkey: string): string {
    const npub = fallbackNpub(pubkey);
    return `${npub.slice(0, 12)}...${npub.slice(-6)}`;
  }

  function authorLabel(pubkey: string): string {
    const label = profileLabel(profiles.get(pubkey), pubkey);
    return label === fallbackNpub(pubkey) ? shortNpub(pubkey) : label;
  }

  function authorPicture(pubkey: string): string | null {
    return safeProfilePicture(profiles.get(pubkey));
  }

  function delta(kind: CreatorSignalKind): number {
    return state.snapshot ? totals[kind] - state.snapshot.totals[kind] : 0;
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

  function countSummary(item: CreatorContent): string {
    const counts = itemSignalCounts(item, state.signals);
    const parts = kinds
      .filter((kind) => counts[kind.id] > 0)
      .map((kind) => `${counts[kind.id]} ${counts[kind.id] === 1 ? kind.singular : kind.plural}`);
    return parts.length > 0 ? parts.join(' · ') : 'No engagement yet';
  }

  function verb(signal: CreatorSignal): string {
    if (signal.quote) return 'quoted';
    return kinds.find((kind) => kind.id === signal.kind)?.verb ?? '';
  }

  function capitalize(text: string): string {
    return text.slice(0, 1).toUpperCase() + text.slice(1);
  }
</script>

{#snippet signalRow(signal: CreatorSignal)}
  {@const label = authorLabel(signal.author)}
  {@const picture = authorPicture(signal.author)}
  <article>
    <header>
      <button
        type="button"
        class="author"
        style={pubkeyColorStyle(signal.author)}
        title={fallbackNpub(signal.author)}
        data-signal-author={signal.author}
        data-signal-author-label={label}
        onclick={() => openSignalAuthor(signal)}
      >
        <span class="avatar" aria-hidden="true">
          <span class="avatar-fallback">{profiles.has(signal.author) ? label.slice(0, 1).toUpperCase() : '?'}</span>
          {#if picture}<img use:resourceImage={picture} alt="" loading="lazy" />{/if}
        </span>
        <strong>{label}</strong>
      </button>
      <span class="verb">{verb(signal)}</span>
      <span class="time">{formatAge(signal.createdAt)}</span>
    </header>
    {#if signal.kind !== 'follow' && signal.summary}<p>{signal.summary}</p>{/if}
  </article>
{/snippet}

<main class="signals-shell">
  <header class="toolbar">
    <h1>Engagement on your posts</h1>
    <input
      aria-label="Search your posts"
      placeholder="Search your posts"
      value={state.query}
      oninput={(event) => setQuery(event.currentTarget.value)}
    />
  </header>

  <section class="filters" aria-label="Filter by kind of engagement">
    <button type="button" class="metric" aria-pressed={state.filter === 'all'} onclick={() => setFilter('all')}>
      <span class="metric-label">All</span>
      <strong>{state.signals.length}</strong>
    </button>
    {#each kinds as kind}
      {@const change = delta(kind.id)}
      <button type="button" class="metric" aria-pressed={state.filter === kind.id} onclick={() => setFilter(kind.id)}>
        <span class="metric-label">{kind.label}</span>
        <strong>{totals[kind.id]}</strong>
        {#if change !== 0}
          <span class="delta" title="Since you last opened this app">{change > 0 ? '+' : ''}{change}</span>
        {/if}
      </button>
    {/each}
  </section>
  <p class="coverage">
    Showing {coverage}, not global totals.
    {#if state.lastUpdatedAt}Latest activity {formatAge(state.lastUpdatedAt)}.{/if}
    {#if state.loading && state.items.length > 0}Still checking for more.{/if}
  </p>

  <section class="content" class:detail-open={detailOpen && hasPane} class:no-pane={!hasPane}>
    <section class="items" aria-label="Your posts">
      {#if orphanSignals.length > 0}
        <button type="button" class="other-row" class:selected={showOther} onclick={selectOther}>
          <strong>Other activity</strong>
          <span class="count">{orphanSignals.length}</span>
          <span class="hint">New follows, and activity on posts older than this window</span>
        </button>
      {/if}
      {#each items as item (item.id)}
        <button type="button" class="item" class:selected={!showOther && selected?.id === item.id} onclick={() => selectItem(item)}>
          <span class="item-title">
            {#if item.type === 'article'}<span class="kind">Article</span>{/if}
            <strong>{item.title}</strong>
          </span>
          {#if item.type === 'article'}<span class="summary">{item.summary}</span>{/if}
          <span class="signal-strip">
            <span class="strip-counts">{countSummary(item)}</span>
            <span class="time">{formatAge(item.createdAt)}</span>
          </span>
        </button>
      {/each}
      {#if items.length === 0 && orphanSignals.length === 0}
        {#if state.loading}
          <p class="empty-title">Looking for your recent posts...</p>
        {:else if state.error}
          <div class="empty">
            <p class="empty-title">Couldn't load your engagement</p>
            <p class="empty-hint">{state.error}</p>
            <button type="button" onclick={() => store.load()}>Try again</button>
          </div>
        {:else if state.query.trim()}
          <div class="empty">
            <p class="empty-title">No posts match "{state.query.trim()}"</p>
            <button type="button" onclick={() => setQuery('')}>Clear search</button>
          </div>
        {:else if state.filter !== 'all'}
          <div class="empty">
            <p class="empty-title">No {kinds.find((kind) => kind.id === state.filter)?.plural} yet</p>
            <button type="button" onclick={() => setFilter('all')}>Show everything</button>
          </div>
        {:else}
          <div class="empty">
            <p class="empty-title">Nothing to show yet</p>
            <p class="empty-hint">Post a note or an article, and the replies, reactions, reposts and zaps on it will show up here.</p>
          </div>
        {/if}
      {:else if items.length === 0}
        <p class="empty-hint none">
          {state.query.trim() ? `No posts match "${state.query.trim()}".` : `No posts have ${kinds.find((kind) => kind.id === state.filter)?.plural ?? 'activity'} yet.`}
        </p>
      {/if}
    </section>

    {#if hasPane}
      <aside class="detail" aria-label={showOther ? 'Other activity' : 'Post detail'}>
        <button type="button" class="back" bind:this={backButton} onclick={closeDetail}>Back to your posts</button>
        {#if showOther}
          <div class="detail-head">
            <div>
              <h2>Other activity</h2>
              <p class="muted">People who follow you, and engagement on posts outside the last {state.queryWindowDays} days.</p>
            </div>
          </div>
          <div class="signal-list">
            {#each orphanSignals as signal (signal.id)}
              {@render signalRow(signal)}
            {/each}
          </div>
        {:else if selected}
          <div class="detail-head">
            <div>
              <span class="eyebrow">{capitalize(selected.type)} · {formatAge(selected.createdAt)}</span>
              <h2>{selected.title}</h2>
              {#if selected.summary !== selected.title}<p class="muted">{selected.summary}</p>{/if}
            </div>
            <button type="button" class="open" onclick={() => openItem(selected)}>Open {selected.type}</button>
          </div>
          <div class="signal-list">
            {#each selectedSignals as signal (signal.id)}
              {@render signalRow(signal)}
            {/each}
            {#if selectedSignals.length === 0}
              <p class="empty-hint none">
                {state.filter === 'all' ? 'No engagement on this one yet.' : `No ${kinds.find((kind) => kind.id === state.filter)?.plural} on this one yet.`}
              </p>
            {/if}
          </div>
        {/if}
      </aside>
    {/if}
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

  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 14px;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    background: var(--hg-surface, #101010);
  }

  h1, h2, p {
    margin: 0;
    letter-spacing: 0;
  }

  h1 {
    font-size: 16px;
    line-height: 1.2;
  }

  h2 {
    font-size: 15px;
    line-height: 1.3;
    overflow-wrap: anywhere;
  }

  .eyebrow, .kind {
    color: var(--hg-accent, #9ee493);
    font-size: 11px;
    text-transform: uppercase;
  }

  input, button {
    border: 1px solid var(--hg-border, #303030);
    border-radius: 6px;
    background: var(--hg-surface, #111);
    color: var(--hg-text, #f3f1e8);
    font: inherit;
    padding: 7px 10px;
  }

  input {
    flex: 0 1 320px;
    min-width: 0;
  }

  button {
    cursor: pointer;
  }

  button:hover, input:focus {
    border-color: var(--hg-accent, #9ee493);
    outline: none;
  }

  button:focus-visible {
    outline: 2px solid var(--hg-accent, #9ee493);
    outline-offset: 1px;
  }

  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 0 12px 10px;
    background: var(--hg-surface, #101010);
  }

  .metric {
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
    padding: 4px 10px;
  }

  .metric[aria-pressed='true'] {
    border-color: var(--hg-accent, #9ee493);
    background: color-mix(in srgb, var(--hg-accent, #9ee493) 18%, transparent);
  }

  .metric-label {
    font-size: 12px;
    color: var(--hg-text-muted, #b8b1a4);
  }

  .metric[aria-pressed='true'] .metric-label {
    color: var(--hg-text, #f3f1e8);
  }

  .delta {
    font-size: 11px;
    color: var(--hg-accent, #9ee493);
  }

  .coverage {
    padding: 6px 12px;
    font-size: 12px;
    color: var(--hg-text-muted, #b8b1a4);
    border-top: 1px solid var(--hg-border, #303030);
    border-bottom: 1px solid var(--hg-border, #303030);
  }

  .content {
    min-height: 0;
    flex: 1;
    display: grid;
    grid-template-columns: minmax(280px, 0.9fr) minmax(320px, 1.1fr);
  }

  .content.no-pane {
    grid-template-columns: minmax(0, 1fr);
  }

  .items, .detail {
    min-width: 0;
    overflow: auto;
  }

  .items {
    padding: 12px;
  }

  .item, .other-row {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 5px;
    text-align: left;
    margin-bottom: 8px;
    padding: 10px;
  }

  .other-row {
    flex-direction: row;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 2px 8px;
    border-style: dashed;
    background: transparent;
  }

  .other-row .hint {
    flex-basis: 100%;
    font-size: 12px;
    color: var(--hg-text-muted, #b8b1a4);
  }

  .other-row .count {
    color: var(--hg-text-muted, #b8b1a4);
  }

  .item.selected, .other-row.selected {
    border-color: var(--hg-accent, #9ee493);
    background: color-mix(in srgb, var(--hg-accent, #9ee493) 10%, transparent);
  }

  .item-title {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
  }

  .item-title strong {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .summary {
    color: var(--hg-text-muted, #b8b1a4);
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .signal-strip {
    display: flex;
    gap: 8px;
    justify-content: space-between;
    font-size: 12px;
    color: var(--hg-text-muted, #b8b1a4);
  }

  .strip-counts {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .time {
    flex: none;
    font-size: 12px;
    color: var(--hg-text-muted, #b8b1a4);
  }

  .detail {
    border-left: 1px solid var(--hg-border, #303030);
    background: var(--hg-surface, #101010);
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .back {
    display: none;
    align-self: flex-start;
  }

  .detail-head {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: start;
  }

  .detail-head > div {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .open {
    flex: none;
  }

  .muted {
    color: var(--hg-text-muted, #b8b1a4);
    font-size: 13px;
    overflow-wrap: anywhere;
  }

  .signal-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  article {
    border: 1px solid var(--hg-border, #303030);
    border-radius: 6px;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  article header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    font-size: 13px;
  }

  article header .time {
    margin-left: auto;
  }

  article p {
    overflow-wrap: anywhere;
  }

  .verb {
    color: var(--hg-text-muted, #b8b1a4);
  }

  .author {
    display: inline-flex;
    gap: 6px;
    align-items: center;
    border: 0;
    background: none;
    padding: 0;
    max-width: 100%;
    min-width: 0;
    text-align: left;
  }

  .author strong {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .author:hover strong {
    text-decoration: underline;
  }

  .avatar {
    position: relative;
    display: inline-grid;
    place-items: center;
    flex: none;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    overflow: hidden;
    border: 1px solid var(--hg-border, #303030);
    font-size: 11px;
    font-weight: 600;
  }

  .avatar img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    text-align: center;
    padding: 56px 16px;
  }

  .empty-title {
    font-weight: 600;
  }

  .empty-hint {
    color: var(--hg-text-muted, #b8b1a4);
    font-size: 13px;
    max-width: 44ch;
  }

  .none {
    padding: 12px 4px;
  }

  @media (max-width: 760px) {
    input {
      flex: 1 1 100%;
    }

    .content, .content.no-pane {
      grid-template-columns: minmax(0, 1fr);
    }

    .detail {
      border-left: 0;
      display: none;
    }

    .content.detail-open .items {
      display: none;
    }

    .content.detail-open .detail {
      display: flex;
    }

    .back {
      display: block;
    }
  }
</style>
