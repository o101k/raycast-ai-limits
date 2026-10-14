import type { Failure, ProviderState } from "./format";
import { ProviderError, ProviderId, ProviderUsage } from "./types";

// The state transitions behind the usage view. Each one takes the current states and cache and returns the new ones,
// so the view only stores the result and the tests can check every case without Raycast.

export type Cached = Partial<Record<ProviderId, ProviderUsage>>;
export type States = Record<ProviderId, ProviderState>;

export interface Transition {
  states: States;
  cached: Cached;
}

// Saved results from the cache of an earlier session are used as long as they're this recent. Opening the command again
// within this window shows them without a request, so rate-limited endpoints (Claude answers 429 quickly) aren't hit on
// every open. A result exactly this old counts as stale and is fetched again.
export const FRESH_MS = 2 * 60_000;

// A provider with no saved result is still loading, so the spinner shows while it is fetched. Providers with a saved
// result show it at once, and become loading only when they are refreshed.
export function initialStates(ids: readonly ProviderId[], cached: Cached): States {
  const states = {} as States;
  for (const id of ids) {
    states[id] = { loading: cached[id] === undefined, usage: cached[id] };
  }
  return states;
}

// Which providers to fetch. A forced refresh (Refresh, sign in or out) fetches all of them. Otherwise a provider is
// fetched when it has no saved result, or when its result is FRESH_MS old or older. Providers with no saved result are
// always fetched, since that is how "not connected" is found, and that costs no network.
export function providersToRefresh(
  states: States,
  ids: readonly ProviderId[],
  now: number,
  options: { force: boolean },
): ProviderId[] {
  if (options.force) {
    return [...ids];
  }
  return ids.filter((id) => {
    const usage = states[id].usage;
    return usage === undefined || now - usage.fetchedAt >= FRESH_MS;
  });
}

// Marks the given providers loading. Saved results stay on screen until their provider answers.
export function startRefresh(states: States, ids: readonly ProviderId[]): States {
  const next = { ...states };
  for (const id of ids) {
    next[id] = { ...next[id], loading: true };
  }
  return next;
}

export function applySuccess(states: States, cached: Cached, id: ProviderId, usage: ProviderUsage): Transition {
  return {
    states: { ...states, [id]: { loading: false, usage } },
    cached: { ...cached, [id]: usage },
  };
}

// A "not-connected" failure means the credentials were removed, so the saved numbers are dropped from the state and the
// cache. Other failures keep the saved numbers and show the failure next to them.
export function applyFailure(states: States, cached: Cached, id: ProviderId, failure: Failure): Transition {
  if (failure.kind === "not-connected") {
    const remaining = { ...cached };
    delete remaining[id];
    return {
      states: { ...states, [id]: { loading: false, failure } },
      cached: remaining,
    };
  }
  return {
    states: { ...states, [id]: { loading: false, usage: states[id].usage, failure } },
    cached,
  };
}

// Providers with no credentials are listed apart from the usage, so the list starts with the ones that work.
export function isNotConnected(state: ProviderState): boolean {
  return state.usage === undefined && state.failure?.kind === "not-connected";
}

export function sections(
  states: States,
  ids: readonly ProviderId[],
  showNotConnected: boolean,
): { usage: ProviderId[]; notConnected: ProviderId[] } {
  return {
    usage: ids.filter((id) => !isNotConnected(states[id])),
    notConnected: showNotConnected ? ids.filter((id) => isNotConnected(states[id])) : [],
  };
}

export function toFailure(error: unknown): Failure {
  if (error instanceof ProviderError) {
    return { kind: error.kind, message: error.message, hint: error.hint, code: error.code };
  }
  return { kind: "http", message: error instanceof Error ? error.message : String(error) };
}
