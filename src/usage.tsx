import {
  Action,
  ActionPanel,
  Cache,
  Color,
  getPreferenceValues,
  Icon,
  Keyboard,
  List,
  open,
  openExtensionPreferences,
  showToast,
  Toast,
} from "@raycast/api";
import { getFavicon } from "@raycast/utils";
import { JSX, useCallback, useEffect, useRef, useState } from "react";
import { ApiKeyForm, ApiKeyMethod, SecretForm } from "./components/connect-forms";
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
import {
  connectLocal,
  ConnectOutcome,
  isConnectOverridden,
  isFallbackOverridden,
  isStoppableConnect,
  LocalConnectMethod,
  LoginCheck,
  loginCheckFromError,
} from "./lib/connect";
import { Connections } from "./lib/connections";
import { forgetConnections, loadConnections, saveConnections } from "./lib/connections-store";
import { getGitHubToken, signInWithGitHub, signOutOfGitHub } from "./lib/github-auth";
import { realDeps } from "./lib/deps";
import { signInWithOpenRouter } from "./lib/openrouter-signin";
import { PROVIDERS, Provider } from "./lib/providers";
import { CREATE_KEY_URL as OPENROUTER_CREATE_KEY_URL } from "./lib/providers/openrouter";
import { toSettings } from "./lib/settings";
import {
  applyFailure,
  applySuccess,
  Cached,
  initialStates,
  isNotConnected,
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
function useUsage(onKeychainDenied: () => void) {
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
                if (usage.keychainDenied) {
                  onKeychainDenied();
                }
              }
            },
            (error: unknown) => {
              if (requestsRef.current[provider.id] === request) {
                const { states: current, cached } = storeRef.current;
                const failure = toFailure(error);
                commit(applyFailure(current, cached, provider.id, failure));
                if (failure.code === "keychain-denied") {
                  onKeychainDenied();
                }
              }
            },
          ),
        ),
      );
    },
    [commit, onKeychainDenied],
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

// Connect reads best with the product's own name for these three. Every other provider reads "Connect <name>".
const CONNECT_TITLES: Partial<Record<ProviderId, string>> = {
  claude: "Connect Claude Code",
  gemini: "Connect Gemini CLI",
  copilot: "Connect GitHub",
};

// Pasting an OpenRouter key by hand, for someone who would rather not sign in with OpenRouter.
const OPENROUTER_KEY: ApiKeyMethod = {
  kind: "api-key",
  field: "openrouterApiKey",
  keyUrl: OPENROUTER_CREATE_KEY_URL,
  keyPattern: /^sk-or-[A-Za-z0-9-]{20,}$/,
  placeholder: "sk-or-v1-…",
};

function connectTitle(provider: Provider): string {
  return CONNECT_TITLES[provider.id] ?? `Connect ${provider.name}`;
}

// A fallback is a way in for when Connect can't reach a provider's login, such as a cookie the user copies by
// hand. Most providers have none.
function fallbackAction(
  provider: Provider,
  settings: Settings,
  onConnected: (connections: Connections) => void,
): JSX.Element | undefined {
  switch (provider.id) {
    case "claude":
      return (
        <Action.Push
          key="fallback"
          title="Use Claude Session Key"
          icon={Icon.Key}
          target={
            <SecretForm
              title="Claude Session Key"
              field="claudeSessionKey"
              placeholder="sk-ant-sid01-…"
              description="Copy the sessionKey cookie for claude.ai from your browser's developer tools. Use it only when Connect Claude Code can't find the login."
              onConnected={onConnected}
            />
          }
        />
      );
    case "cursor":
      return (
        <Action.Push
          key="fallback"
          title="Use Cursor Session Cookie"
          icon={Icon.Key}
          target={
            <SecretForm
              title="Cursor Session Cookie"
              field="cursorCookie"
              placeholder="user_…%3A%3AeyJ…"
              description="Copy the WorkosCursorSessionToken cookie for cursor.com from your browser's developer tools. Use it only when Connect Cursor can't find the login."
              onConnected={onConnected}
            />
          }
        />
      );
    case "openrouter":
      return (
        <Action.Push
          key="fallback"
          title="Enter API Key"
          icon={Icon.Key}
          target={
            <ApiKeyForm provider={provider} method={OPENROUTER_KEY} settings={settings} onConnected={onConnected} />
          }
        />
      );
    default:
      return undefined;
  }
}

interface ProviderItemProps {
  provider: Provider;
  state: ProviderState;
  mode: DisplayMode;
  now: number;
  // The settings the key form checks a key with, built from the preferences and the saved connections.
  settings: Settings;
  // Whether Connect saved something for this provider, so Disconnect has something to remove.
  connected: boolean;
  // Set only for Copilot when no token is in the preferences. undefined means the sign-in actions don't apply.
  gitHubSignedIn?: boolean;
  // Hides Connect when it would have no effect, such as Connect GitHub or an API key with one set in the preferences.
  connectHidden?: boolean;
  // Hides the fallback action (a session key or cookie) while the preference for the same value is set.
  fallbackHidden?: boolean;
  onRefresh: () => void;
  onConnect: () => void;
  onConnected: (connections: Connections) => void;
  onDisconnect: () => void;
  onSignOut: () => void;
}

function ProviderItem({
  provider,
  state,
  mode,
  now,
  settings,
  connected,
  gitHubSignedIn,
  connectHidden,
  fallbackHidden,
  onRefresh,
  onConnect,
  onConnected,
  onDisconnect,
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

  const connect = provider.connect;
  const connectAction =
    connect.kind === "api-key" ? (
      <Action.Push
        key="connect"
        title={connectTitle(provider)}
        icon={Icon.Plug}
        target={<ApiKeyForm provider={provider} method={connect} settings={settings} onConnected={onConnected} />}
      />
    ) : (
      <Action key="connect" title={connectTitle(provider)} icon={Icon.Plug} onAction={onConnect} />
    );
  const connectActions: JSX.Element[] = [];
  if (!connectHidden) {
    connectActions.push(connectAction);
    const fallback = fallbackAction(provider, settings, onConnected);
    if (fallback && !fallbackHidden) {
      connectActions.push(fallback);
    }
  }
  // Connect goes first when there is nothing to show, or when the saved login was rejected, since that is what the user
  // needs next. An account Google doesn't serve is not fixed by signing in again, so Connect stays after it. Otherwise
  // Connect sits after Copy Usage, so Enter still refreshes a working provider.
  const connectFirst = isNotConnected(state) || (failure?.kind === "auth" && failure.code !== "account-unsupported");

  return (
    <List.Item
      title={provider.name}
      subtitle={usage?.plan}
      icon={getFavicon(provider.iconUrl, { fallback: Icon.Gauge })}
      accessories={accessories}
      detail={<List.Item.Detail markdown={detailMarkdown(provider.name, state, mode, now)} metadata={metadata} />}
      actions={
        <ActionPanel>
          {connectFirst && connectActions}
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
          {!connectFirst && connectActions}
          {connected && (
            <Action
              title="Disconnect"
              icon={Icon.Logout}
              style={Action.Style.Destructive}
              shortcut={Keyboard.Shortcut.Common.Remove}
              onAction={onDisconnect}
            />
          )}
          {gitHubSignedIn === true && <Action title="Sign out of GitHub" icon={Icon.Logout} onAction={onSignOut} />}
          <Action title="Open Extension Preferences" icon={Icon.Gear} onAction={openExtensionPreferences} />
        </ActionPanel>
      }
    />
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The settings a Connect verifies with. Only the login it signs in to counts. For Claude that is Claude Code's login, so a
// working claude.ai session key can't make a broken one look fine. For Cursor it is the app's login, so a saved cookie
// can't make a missing one look fine.
function verifySettings(method: LocalConnectMethod, settings: Settings): Settings {
  switch (method.kind) {
    case "claude":
      return { ...settings, claudeSessionKey: undefined };
    case "cursor":
      return { ...settings, cursorCookie: undefined };
    default:
      return settings;
  }
}

// Whether the provider's saved login works, as Connect checks it. A success is "ok". See loginCheckFromError for the rest.
async function checkLogin(provider: Provider, settings: Settings): Promise<LoginCheck> {
  try {
    await provider.fetchUsage(realDeps(), settings);
    return "ok";
  } catch (error) {
    return loginCheckFromError(error);
  }
}

export default function Command() {
  const preferences = getPreferenceValues<Preferences.Usage>();
  const mode: DisplayMode = preferences.displayMode;

  // The GitHub token and the saved connections are kept in refs as well as in state. Connect can run for minutes, and
  // the callbacks it uses read the refs (see currentSettings), so they never refresh with values from an older render.
  const [gitHubToken, setGitHubToken] = useState<string>();
  const gitHubTokenRef = useRef<string | undefined>(undefined);
  const updateGitHubToken = useCallback((token: string | undefined) => {
    gitHubTokenRef.current = token;
    setGitHubToken(token);
  }, []);
  // The GitHub token from signing in is read before the first fetch, so Copilot's first request already has it.
  const [gitHubTokenChecked, setGitHubTokenChecked] = useState(false);
  useEffect(() => {
    let active = true;
    getGitHubToken()
      .catch(() => undefined)
      .then((token) => {
        if (active) {
          updateGitHubToken(token);
          setGitHubTokenChecked(true);
        }
      });
    return () => {
      active = false;
    };
  }, [updateGitHubToken]);

  // The connections Connect saved are read before the first fetch as well, so a provider connected earlier is fetched
  // with its key. A failed read counts as none saved, which only means the user connects again.
  const [connections, setConnections] = useState<Connections>();
  const connectionsRef = useRef<Connections | undefined>(undefined);
  const updateConnections = useCallback((next: Connections) => {
    connectionsRef.current = next;
    setConnections(next);
  }, []);
  useEffect(() => {
    let active = true;
    loadConnections()
      .catch((): Connections => ({}))
      .then((saved) => {
        if (active) {
          updateConnections(saved);
        }
      });
    return () => {
      active = false;
    };
  }, [updateConnections]);

  // A Connect still waiting for a browser or a CLI is stopped when the command closes, so it doesn't outlive the view.
  const closeRef = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    closeRef.current = controller;
    return () => controller.abort();
  }, []);

  // The Connect running for each provider, with its AbortController. Disconnect stops a Connect through that. An entry
  // whose controller has aborted is no longer running, so a new Connect may replace it.
  const connectAbortsRef = useRef(new Map<ProviderId, AbortController>());

  const settings = toSettings(preferences, connections, gitHubToken);
  // The settings from the latest GitHub token and connections. Connect and the refreshes after it use these, not the
  // settings of the render they were started in.
  function currentSettings(): Settings {
    return toSettings(preferences, connectionsRef.current, gitHubTokenRef.current);
  }

  // macOS refused the Keychain read during a refresh. The setting is turned off so later refreshes don't ask again, and
  // choosing Connect turns it on again. A Claude Connect that is running is left alone, since its own verify turns the
  // setting off when macOS refuses, and this would only save over that.
  const onKeychainDenied = useCallback(() => {
    const running = connectAbortsRef.current.get("claude");
    if (running && !running.signal.aborted) {
      return;
    }
    void saveConnections({ claudeKeychain: false }).then(updateConnections, () => undefined);
  }, [updateConnections]);
  const { states, refresh } = useUsage(onKeychainDenied);

  // The first refresh waits for the GitHub token and the saved connections, and then runs once.
  const startedRef = useRef(false);
  const ready = gitHubTokenChecked && connections !== undefined;
  useEffect(() => {
    if (ready && !startedRef.current) {
      startedRef.current = true;
      void refresh(settings, { force: false });
    }
  }, [ready, refresh, settings]);

  // Refreshes every provider with the latest token and connections. A forced refresh, so a new or removed login shows
  // at once.
  function refreshWith() {
    return refresh(currentSettings(), { force: true });
  }

  // Signs in with GitHub. `signOutFirst` removes the stored token before the sign-in, because the sign-in hands back
  // the stored token without asking when there is one.
  async function signIn(signOutFirst: boolean) {
    try {
      if (signOutFirst) {
        await signOutOfGitHub();
        updateGitHubToken(undefined);
      }
      updateGitHubToken(await signInWithGitHub());
      await refreshWith();
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Could not sign in with GitHub",
        message: errorMessage(error),
      });
    }
  }

  async function signOut() {
    try {
      await signOutOfGitHub();
      updateGitHubToken(undefined);
      await refreshWith();
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Could not sign out of GitHub",
        message: errorMessage(error),
      });
    }
  }

  // Claude, Codex, Cursor and Gemini sign in with their own CLI or app on this Mac. The toast shows what that is doing.
  // `signal` stops the Connect when Disconnect runs or the command closes.
  async function connectTool(provider: Provider, method: LocalConnectMethod, signal: AbortSignal) {
    const toast = await showToast({ style: Toast.Style.Animated, title: `Connecting ${provider.name}` });
    const outcome = await connectLocal(realDeps(), method, {
      progress: (title, message) => {
        toast.title = title;
        toast.message = message;
      },
      save: async (patch) => {
        const next = await saveConnections(patch);
        updateConnections(next);
        return next;
      },
      verify: () => checkLogin(provider, verifySettings(method, currentSettings())),
      signal,
    }).catch((error: unknown): ConnectOutcome => ({
      kind: "failed",
      title: `Could not connect ${provider.name}`,
      message: errorMessage(error),
    }));

    // A stopped Connect shows nothing, and neither a success nor a refresh follows it.
    if (signal.aborted) {
      await toast.hide();
      return;
    }
    if (outcome.kind === "connected") {
      toast.style = Toast.Style.Success;
      toast.title = `${provider.name} connected`;
      toast.message = undefined;
      // The saved connections are read again, so the refresh uses exactly what was stored. When that fails, the refresh
      // still runs with the connections already in memory.
      try {
        updateConnections(await loadConnections());
      } catch (error) {
        await showToast({
          style: Toast.Style.Failure,
          title: "Could not read saved connections",
          message: errorMessage(error),
        });
      }
      await refreshWith();
      return;
    }
    toast.style = Toast.Style.Failure;
    toast.title = outcome.title;
    toast.message = outcome.message;
    if (outcome.help) {
      const help = outcome.help;
      toast.primaryAction = { title: help.title, onAction: () => void open(help.url) };
    }
  }

  // OpenRouter's sign-in returns a key that OpenRouter made, which is saved like any other connection.
  async function connectOpenRouter(provider: Provider) {
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: `Connecting ${provider.name}`,
      message: "Finish in your browser",
    });
    try {
      const next = await saveConnections({ openrouterApiKey: await signInWithOpenRouter(realDeps()) });
      updateConnections(next);
      toast.style = Toast.Style.Success;
      toast.title = `${provider.name} connected`;
      toast.message = undefined;
      await refreshWith();
    } catch (error) {
      toast.style = Toast.Style.Failure;
      toast.title = `Could not connect ${provider.name}`;
      toast.message = errorMessage(error);
    }
  }

  // Connect GitHub signs in again when Copilot rejected the saved token, or the account has no Copilot. Other failures,
  // such as no network, keep the token, since it may be fine.
  async function connectGitHub(provider: Provider) {
    const kind = states[provider.id].failure?.kind;
    await signIn(kind === "auth" || kind === "not-connected");
  }

  // Runs the Connect action for a provider. API key providers never get here, since their action opens a form instead.
  // A second Connect for a provider that is still connecting is refused, so two sign-ins never run at once. A Connect
  // that was stopped no longer counts as running, so a new one replaces it. A local sign-in that is waiting can be
  // stopped from that refusal with Start Over, so a sign-in left waiting doesn't block the retry.
  async function connect(provider: Provider): Promise<void> {
    const running = connectAbortsRef.current.get(provider.id);
    if (running && !running.signal.aborted) {
      await showToast({
        title: `Already connecting ${provider.name}`,
        primaryAction: isStoppableConnect(provider.connect)
          ? {
              title: "Start Over",
              onAction: () => {
                running.abort();
                void connect(provider);
              },
            }
          : undefined,
      });
      return;
    }
    const controller = new AbortController();
    connectAbortsRef.current.set(provider.id, controller);
    const signal = AbortSignal.any([controller.signal, ...(closeRef.current ? [closeRef.current.signal] : [])]);
    try {
      const method = provider.connect;
      switch (method.kind) {
        case "claude":
        case "codex":
        case "gemini":
        case "cursor":
          await connectTool(provider, method, signal);
          return;
        case "github":
          await connectGitHub(provider);
          return;
        case "openrouter":
          await connectOpenRouter(provider);
          return;
        case "api-key":
          return;
      }
    } finally {
      // A stopped Connect can still be finishing when its replacement starts, so it only removes its own entry.
      if (connectAbortsRef.current.get(provider.id) === controller) {
        connectAbortsRef.current.delete(provider.id);
      }
    }
  }

  // Removes what Connect saved for this provider. Keys typed into the preferences stay, since the user owns those.
  async function disconnect(provider: Provider) {
    // A Connect still running for this provider is stopped first, so it can't save a login after the forget.
    connectAbortsRef.current.get(provider.id)?.abort();
    try {
      const next = await forgetConnections(provider.forget);
      updateConnections(next);
      await refreshWith();
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: `Could not disconnect ${provider.name}`,
        message: errorMessage(error),
      });
    }
  }

  const now = Date.now();
  const split = sections(states, PROVIDER_IDS, preferences.showNotConnected);
  const usageProviders = PROVIDERS.filter((provider) => split.usage.includes(provider.id));
  const notConnectedProviders = PROVIDERS.filter((provider) => split.notConnected.includes(provider.id));
  const isLoading = Object.values(states).some((state) => state.loading);
  const hasPreferenceToken = Boolean(preferences.githubToken?.trim());
  // The settings from the preferences alone. A key typed there hides Connect, since it would override the saved one.
  const preferenceSettings = toSettings(preferences);

  function itemFor(provider: Provider) {
    return (
      <ProviderItem
        key={provider.id}
        provider={provider}
        state={states[provider.id]}
        mode={mode}
        now={now}
        settings={settings}
        connected={provider.forget.some((key) => connections?.[key] !== undefined)}
        gitHubSignedIn={provider.id === "copilot" && !hasPreferenceToken ? gitHubToken !== undefined : undefined}
        connectHidden={isConnectOverridden(provider.connect, preferenceSettings)}
        fallbackHidden={isFallbackOverridden(provider.id, preferenceSettings)}
        onRefresh={() => refreshWith()}
        onConnect={() => void connect(provider)}
        onConnected={(next) => {
          updateConnections(next);
          void refreshWith();
        }}
        onDisconnect={() => void disconnect(provider)}
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
          description="Choose Connect on a provider to sign in or add its key. Turn on Providers in the extension preferences to list the ones that aren't connected."
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
