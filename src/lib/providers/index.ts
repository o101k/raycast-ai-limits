import { Deps } from "../deps";
import { ProviderId, ProviderUsage, Settings } from "../types";
import { fetchClaudeUsage } from "./claude";
import { fetchCodexUsage } from "./codex";
import { fetchCopilotUsage } from "./copilot";
import { fetchCursorUsage } from "./cursor";
import { fetchDeepSeekUsage } from "./deepseek";
import { fetchGeminiUsage } from "./gemini";
import { fetchKimiUsage } from "./kimi";
import { fetchMoonshotUsage } from "./moonshot";
import { fetchOpenRouterUsage } from "./openrouter";
import { fetchZaiUsage } from "./zai";

export interface Provider {
  id: ProviderId;
  name: string;
  // Where the user sees the same numbers on the web.
  dashboardUrl: string;
  // Site used for the list icon (via Raycast's favicon helper).
  iconUrl: string;
  // Throws a ProviderError with kind "not-connected" when no credentials are found.
  fetchUsage(deps: Deps, settings: Settings): Promise<ProviderUsage>;
}

// Display order in the list.
export const PROVIDERS: Provider[] = [
  {
    id: "claude",
    name: "Claude",
    dashboardUrl: "https://claude.ai/settings/usage",
    iconUrl: "https://claude.ai",
    fetchUsage: fetchClaudeUsage,
  },
  {
    id: "codex",
    name: "Codex",
    dashboardUrl: "https://chatgpt.com/codex/settings/usage",
    iconUrl: "https://chatgpt.com",
    fetchUsage: fetchCodexUsage,
  },
  {
    id: "cursor",
    name: "Cursor",
    dashboardUrl: "https://cursor.com/dashboard?tab=usage",
    iconUrl: "https://cursor.com",
    fetchUsage: fetchCursorUsage,
  },
  {
    id: "gemini",
    name: "Gemini",
    dashboardUrl: "https://aistudio.google.com/usage",
    iconUrl: "https://gemini.google.com",
    fetchUsage: fetchGeminiUsage,
  },
  {
    id: "copilot",
    name: "GitHub Copilot",
    dashboardUrl: "https://github.com/settings/copilot",
    iconUrl: "https://github.com",
    fetchUsage: fetchCopilotUsage,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    dashboardUrl: "https://openrouter.ai/settings/credits",
    iconUrl: "https://openrouter.ai",
    fetchUsage: fetchOpenRouterUsage,
  },
  {
    id: "zai",
    name: "z.ai",
    dashboardUrl: "https://z.ai/manage-apikey/subscription",
    iconUrl: "https://z.ai",
    fetchUsage: fetchZaiUsage,
  },
  {
    id: "kimi",
    name: "Kimi Code",
    dashboardUrl: "https://www.kimi.com/code",
    iconUrl: "https://www.kimi.com",
    fetchUsage: fetchKimiUsage,
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    dashboardUrl: "https://platform.deepseek.com/usage",
    iconUrl: "https://www.deepseek.com",
    fetchUsage: fetchDeepSeekUsage,
  },
  {
    id: "moonshot",
    name: "Moonshot",
    dashboardUrl: "https://platform.moonshot.ai/console/account",
    iconUrl: "https://www.moonshot.ai",
    fetchUsage: fetchMoonshotUsage,
  },
];
