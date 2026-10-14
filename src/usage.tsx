import {
  Action,
  ActionPanel,
  Cache,
  Color,
  getPreferenceValues,
  Icon,
  Keyboard,
  List,
  openExtensionPreferences,
  showToast,
  Toast,
} from "@raycast/api";
import { getFavicon } from "@raycast/utils";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DisplayMode,
  detailMarkdown,
  failureTitle,
  formatUpdated,
  listSummary,
  ProviderState,
  summaryText,
  Tone,
} from "./lib/format";
import { getGitHubToken, signInWithGitHub, signOutOfGitHub } from "./lib/github-auth";
import { realDeps } from "./lib/deps";
import { PROVIDERS, Provider } from "./lib/providers";
import { toSettings } from "./lib/settings";
import {
  applyFailure,
  applySuccess,
  Cached,
  initialStates,
  providersToRefresh,
  sections,
  startRefresh,
  toFailure,
  Transition,
} from "./lib/usage-state";
import { ProviderId, Settings } from "./lib/types";

// The last successful result of every provider is kept, so reopening the command shows numbers at once while the
// refresh runs. The transitions in usage-state.ts decide what is kept.
const cache = new Cache();
const CACHE_KEY = "usage-v1";

const PROVIDER_IDS: ProviderId[] = PROVIDERS.map((provider) => provider.id);

function readCache(): Cached {
  try {
    const raw = cache.get(CACHE_KEY);
    return raw ? (JSON.parse(raw) as Cached) : {};
  } catch {
    return {};
  }
}

function writeCache(usage: Cached) {
  try {
    cache.set(CACHE_KEY, JSON.stringify(usage));
  } catch {
    // A full or unwritable cache only costs the instant reopen, so the list still works without it.
  }
}

// The hook only holds the latest transition and renders it. Every change goes through the pure functions in
// usage-state.ts, which are tested.
function useUsage() {
  const [initialCache] = useState(readCache);
  const storeRef = useRef<Transition>({ states: initialStates(PROVIDER_IDS, initialCache), cached: initialCache });
  const [states, setStates] = useState(storeRef.current.states);
  // The refresh that asked for each provider last. A result counts only when it comes from that refresh, so a forced
  // refresh that starts while a partial one is running wins, and a partial refresh never drops another one's results.
  const requestsRef = useRef<Partial<Record<ProviderId, number>>>({});
  const requestCountRef = useRef(0);

  const commit = useCallback((next: Transition) => {
    storeRef.current = next;
    writeCache(next.cached);
    setStates(next.states);
  }, []);

  const refresh = useCallback(
    async (settings: Settings, options: { force: boolean }) => {
      const ids = providersToRefresh(storeRef.current.states, PROVIDER_IDS, Date.now(), options);
      if (ids.length === 0) {
        return;
      }
      const request = ++requestCountRef.current;
      for (const id of ids) {
        requestsRef.current[id] = request;
      }
      commit({ states: startRefresh(storeRef.current.states, ids), cached: storeRef.current.cached });

      const deps = realDeps();
      const providers = PROVIDERS.filter((provider) => ids.includes(provider.id));
      await Promise.all(
        providers.map((provider: Provider) =>
          provider.fetchUsage(deps, settings).then(
            (usage) => {
              if (requestsRef.current[provider.id] === request) {
                const { states: current, cached } = storeRef.current;
                commit(applySuccess(current, cached, provider.id, usage));
              }
            },
            (error: unknown) => {
              if (requestsRef.current[provider.id] === request) {
                const { states: current, cached } = storeRef.current;
                commit(applyFailure(current, cached, provider.id, toFailure(error)));
              }
            },
          ),
        ),
      );
    },
    [commit],
  );

  return { states, refresh };
}

const TONE_COLORS: Record<Tone, Color.ColorLike> = {
  ok: Color.Green,
  warning: Color.Yellow,
  critical: Color.Red,
  error: Color.Red,
  neutral: Color.SecondaryText,
};

interface ProviderItemProps {
  provider: Provider;
  state: ProviderState;
  mode: DisplayMode;
  now: number;
  // Set only for Copilot when no token is in the preferences. undefined means the sign-in actions don't apply.
  gitHubSignedIn?: boolean;
  onRefresh: () => void;
  onSignIn: () => void;
  onSignOut: () => void;
}

function ProviderItem({
  provider,
  state,
  mode,
  now,
  gitHubSignedIn,
  onRefresh,
  onSignIn,
  onSignOut,
}: ProviderItemProps) {
  const { usage, failure } = state;
  const summary = listSummary(state, mode, now);
  const accessories: List.Item.Accessory[] = [];
  if (summary.tag) {
    accessories.push({
      tag: { value: summary.tag.text, color: TONE_COLORS[summary.tag.tone] },
      tooltip: summary.tooltip,
    });
  }
  if (summary.text) {
    accessories.push({ text: summary.text });
  }

  const metadata = (
    <List.Item.Detail.Metadata>
      {usage?.plan && <List.Item.Detail.Metadata.Label title="Plan" text={usage.plan} />}
      {usage?.account && <List.Item.Detail.Metadata.Label title="Account" text={usage.account} />}
      {usage && <List.Item.Detail.Metadata.Label title="Source" text={usage.source} />}
      {usage && <List.Item.Detail.Metadata.Label title="Updated" text={formatUpdated(usage.fetchedAt, now)} />}
      {failure && <List.Item.Detail.Metadata.Label title="Status" text={failureTitle(failure)} />}
      {failure && usage && <List.Item.Detail.Metadata.Label title="Refresh" text="Failed, showing saved data" />}
    </List.Item.Detail.Metadata>
  );

  return (
    <List.Item
      title={provider.name}
      subtitle={usage?.plan}
      icon={getFavicon(provider.iconUrl, { fallback: Icon.Gauge })}
      accessories={accessories}
      detail={<List.Item.Detail markdown={detailMarkdown(provider.name, state, mode, now)} metadata={metadata} />}
      actions={
        <ActionPanel>
          <Action
            title="Refresh"
            icon={Icon.ArrowClockwise}
            shortcut={Keyboard.Shortcut.Common.Refresh}
            onAction={onRefresh}
          />
          <Action.OpenInBrowser title="Open Usage Dashboard" url={provider.dashboardUrl} icon={Icon.Globe} />
          <Action.CopyToClipboard
            title="Copy Usage"
            content={summaryText(provider.name, state, mode, now)}
            icon={Icon.Clipboard}
            shortcut={Keyboard.Shortcut.Common.Copy}
          />
          {gitHubSignedIn === true && <Action title="Sign out of GitHub" icon={Icon.Logout} onAction={onSignOut} />}
          {gitHubSignedIn === false && <Action title="Sign in with GitHub" icon={Icon.Person} onAction={onSignIn} />}
          <Action title="Open Extension Preferences" icon={Icon.Gear} onAction={openExtensionPreferences} />
        </ActionPanel>
      }
    />
  );
}

export default function Command() {
  const preferences = getPreferenceValues<Preferences.Usage>();
  const mode: DisplayMode = preferences.displayMode;

  // The GitHub token from signing in is read before the first fetch, so Copilot's first request already has it.
  const [gitHubToken, setGitHubToken] = useState<string>();
  const [gitHubTokenChecked, setGitHubTokenChecked] = useState(false);
  useEffect(() => {
    let active = true;
    getGitHubToken()
      .catch(() => undefined)
      .then((token) => {
        if (active) {
          setGitHubToken(token);
          setGitHubTokenChecked(true);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const settings = toSettings(preferences, {}, gitHubToken);
  const { states, refresh } = useUsage();

  // The first refresh waits for the GitHub token check, and then runs once.
  const startedRef = useRef(false);
  useEffect(() => {
    if (gitHubTokenChecked && !startedRef.current) {
      startedRef.current = true;
      void refresh(settings, { force: false });
    }
  }, [gitHubTokenChecked, refresh, settings]);

  async function signIn() {
    try {
      const token = await signInWithGitHub();
      setGitHubToken(token);
      await refresh(toSettings(preferences, {}, token), { force: true });
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Could not sign in with GitHub",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function signOut() {
    try {
      await signOutOfGitHub();
      setGitHubToken(undefined);
      await refresh(toSettings(preferences, {}, undefined), { force: true });
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Could not sign out of GitHub",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const now = Date.now();
  const split = sections(states, PROVIDER_IDS, preferences.showNotConnected);
  const usageProviders = PROVIDERS.filter((provider) => split.usage.includes(provider.id));
  const notConnectedProviders = PROVIDERS.filter((provider) => split.notConnected.includes(provider.id));
  const isLoading = Object.values(states).some((state) => state.loading);
  const hasPreferenceToken = Boolean(preferences.githubToken?.trim());

  function itemFor(provider: Provider) {
    return (
      <ProviderItem
        key={provider.id}
        provider={provider}
        state={states[provider.id]}
        mode={mode}
        now={now}
        gitHubSignedIn={provider.id === "copilot" && !hasPreferenceToken ? gitHubToken !== undefined : undefined}
        onRefresh={() => refresh(settings, { force: true })}
        onSignIn={() => void signIn()}
        onSignOut={() => void signOut()}
      />
    );
  }

  return (
    <List isLoading={isLoading} isShowingDetail searchBarPlaceholder="Filter providers">
      <List.Section title="Usage">{usageProviders.map(itemFor)}</List.Section>
      {notConnectedProviders.length > 0 && (
        <List.Section title="Not Connected">{notConnectedProviders.map(itemFor)}</List.Section>
      )}
      {!isLoading && usageProviders.length === 0 && notConnectedProviders.length === 0 && (
        <List.EmptyView
          title="No AI Tools Connected"
          description="Add a key or cookie in the extension preferences, or sign in to Claude Code, Codex, Cursor or Gemini CLI on this Mac."
          icon={Icon.Gauge}
          actions={
            <ActionPanel>
              <Action title="Open Extension Preferences" icon={Icon.Gear} onAction={openExtensionPreferences} />
            </ActionPanel>
          }
        />
      )}
    </List>
  );
}
