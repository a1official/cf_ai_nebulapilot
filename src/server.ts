import { createWorkersAI } from "workers-ai-provider";
import { callable, routeAgentRequest, type Schedule } from "agents";
import {
  AgentWorkflow,
  type AgentWorkflowEvent,
  type AgentWorkflowStep
} from "agents/workflows";
import { getSchedulePrompt, scheduleSchema } from "agents/schedule";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { launch } from "@cloudflare/playwright";
import {
  convertToModelMessages,
  generateText,
  pruneMessages,
  stepCountIs,
  streamText,
  tool,
  type ModelMessage
} from "ai";
import { z } from "zod";

type CoachProfile = {
  name?: string;
  goal?: string;
  preferredCadence?: string;
  constraints?: string;
};

type GoalPlan = {
  workflowId: string;
  goal: string;
  status: "idle" | "running" | "complete" | "error";
  createdAt: string;
  completedAt?: string;
  summary?: string;
  plan?: string;
};

type WorkflowEvent = {
  timestamp: string;
  message: string;
};

type CoachState = {
  profile: CoachProfile;
  activePlan: GoalPlan | null;
  workflowEvents: WorkflowEvent[];
  toolkit?: {
    rssFeeds?: Record<
      string,
      { lastSeenGuids: string[]; lastCheckedAt: string }
    >;
    progressLog?: Array<{ date: string; completed: boolean; note?: string }>;
    integrationQueue?: Array<{
      id: string;
      provider: string;
      payload: Record<string, unknown>;
      queuedAt: string;
    }>;
    voiceMode?: {
      enableVoiceInput: boolean;
      enableTtsOutput: boolean;
      voice: string;
    };
    digestConfig?: {
      cadence: "daily" | "weekly";
      recipientEmail?: string;
      enabled: boolean;
    };
    usage?: {
      llmCalls: number;
      toolCalls: number;
      browserRuns: number;
      estimatedInputChars: number;
      limits: {
        maxLlmCalls: number;
        maxBrowserRuns: number;
        maxInputChars: number;
      };
    };
  };
};

type GoalPlanningPayload = {
  goal: string;
  userContext: CoachProfile;
};

type GoalPlanningProgress = {
  step: "drafting" | "finalizing";
  status: "running" | "complete";
  message: string;
};

const INITIAL_STATE: CoachState = {
  profile: {},
  activePlan: null,
  workflowEvents: [],
  toolkit: {
    rssFeeds: {},
    progressLog: [],
    integrationQueue: [],
    voiceMode: {
      enableVoiceInput: false,
      enableTtsOutput: false,
      voice: "default"
    },
    digestConfig: {
      cadence: "weekly",
      enabled: false
    },
    usage: {
      llmCalls: 0,
      toolCalls: 0,
      browserRuns: 0,
      estimatedInputChars: 0,
      limits: {
        maxLlmCalls: 300,
        maxBrowserRuns: 150,
        maxInputChars: 800_000
      }
    }
  }
};

function getStateSnapshot(state: unknown): CoachState {
  if (!state || typeof state !== "object") {
    return INITIAL_STATE;
  }

  return {
    profile:
      "profile" in state && state.profile && typeof state.profile === "object"
        ? (state.profile as CoachProfile)
        : {},
    activePlan:
      "activePlan" in state &&
      state.activePlan &&
      typeof state.activePlan === "object"
        ? (state.activePlan as GoalPlan)
        : null,
    workflowEvents:
      "workflowEvents" in state && Array.isArray(state.workflowEvents)
        ? (state.workflowEvents as WorkflowEvent[])
        : []
  };
}

function addWorkflowEvent(
  state: CoachState,
  message: string,
  maxEvents = 8
): CoachState {
  return {
    ...state,
    workflowEvents: [
      {
        timestamp: new Date().toISOString(),
        message
      },
      ...state.workflowEvents
    ].slice(0, maxEvents)
  };
}

function normalizeBrowsableUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  const withProtocol = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  const parsed = new URL(withProtocol);

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only http and https URLs are supported.");
  }

  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new Error("Localhost URLs are blocked.");
  }

  return parsed.toString();
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function getToolkit(state: CoachState) {
  return {
    rssFeeds: state.toolkit?.rssFeeds || {},
    progressLog: state.toolkit?.progressLog || [],
    integrationQueue: state.toolkit?.integrationQueue || [],
    voiceMode: state.toolkit?.voiceMode || INITIAL_STATE.toolkit!.voiceMode!,
    digestConfig:
      state.toolkit?.digestConfig || INITIAL_STATE.toolkit!.digestConfig!,
    usage: state.toolkit?.usage || INITIAL_STATE.toolkit!.usage!
  };
}

function compactStateForPrompt(state: CoachState) {
  const toolkit = getToolkit(state);
  return JSON.stringify({
    profile: state.profile,
    activePlan: state.activePlan
      ? {
          goal: state.activePlan.goal,
          status: state.activePlan.status,
          summary: state.activePlan.summary
        }
      : null,
    voiceMode: toolkit.voiceMode,
    digestConfig: toolkit.digestConfig,
    usage: toolkit.usage,
    recentProgress: toolkit.progressLog.slice(0, 7),
    recentEvents: state.workflowEvents.slice(0, 3).map((event) => event.message)
  }).slice(0, 1800);
}

function estimateLastUserChars(messages: ModelMessage[]) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "user") continue;
    if (typeof message.content === "string") return message.content.length;
    return message.content
      .map((part) => (part.type === "text" ? part.text.length : 0))
      .reduce((a, b) => a + b, 0);
  }
  return 0;
}

function shouldBlockExpensiveTools(state: CoachState) {
  const usage = getToolkit(state).usage;
  return (
    usage.browserRuns >= usage.limits.maxBrowserRuns ||
    usage.llmCalls >= usage.limits.maxLlmCalls ||
    usage.estimatedInputChars >= usage.limits.maxInputChars
  );
}

function parseJsonLoose(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```json([\s\S]*?)```/i)?.[1];
    if (fenced) return JSON.parse(fenced.trim());
    const objectMatch = text.match(/\{[\s\S]*\}/);
    if (objectMatch) return JSON.parse(objectMatch[0]);
    throw new Error("Could not parse JSON output.");
  }
}

function extractTag(xml: string, tagName: string): string | undefined {
  const match = xml.match(
    new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "i")
  );
  return match?.[1]?.trim();
}

function parseRssItems(xml: string) {
  const itemMatches = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  return itemMatches.map((itemXml) => ({
    title: extractTag(itemXml, "title"),
    link: extractTag(itemXml, "link"),
    guid: extractTag(itemXml, "guid") || extractTag(itemXml, "link"),
    pubDate: extractTag(itemXml, "pubDate")
  }));
}

function computeStreak(
  progressLog: Array<{ date: string; completed: boolean }>
) {
  const doneDays = new Set(
    progressLog.filter((entry) => entry.completed).map((entry) => entry.date)
  );
  let streak = 0;
  const now = new Date();
  for (let i = 0; i < 365; i += 1) {
    const probe = new Date(now);
    probe.setDate(now.getDate() - i);
    const key = probe.toISOString().slice(0, 10);
    if (doneDays.has(key)) {
      streak += 1;
    } else {
      break;
    }
  }
  return streak;
}

/**
 * The AI SDK's downloadAssets step runs `new URL(data)` on every file
 * part's string data. Data URIs parse as valid URLs, so it tries to
 * HTTP-fetch them and fails. Decode to Uint8Array so the SDK treats
 * them as inline data instead.
 */
function inlineDataUrls(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "user" || typeof msg.content === "string") return msg;
    return {
      ...msg,
      content: msg.content.map((part) => {
        if (part.type !== "file" || typeof part.data !== "string") return part;
        const match = part.data.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) return part;
        const bytes = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0));
        return { ...part, data: bytes, mediaType: match[1] };
      })
    };
  });
}

export class GoalPlanningWorkflow extends AgentWorkflow<
  ChatAgent,
  GoalPlanningPayload,
  GoalPlanningProgress,
  Env
> {
  async run(
    event: AgentWorkflowEvent<GoalPlanningPayload>,
    step: AgentWorkflowStep
  ) {
    const createdAt = new Date().toISOString();
    const basePlan: GoalPlan = {
      workflowId: this.workflowId,
      goal: event.payload.goal,
      status: "running",
      createdAt,
      summary: "Drafting a focused weekly action plan."
    };

    await step.mergeAgentState({ activePlan: basePlan });
    await this.reportProgress({
      step: "drafting",
      status: "running",
      message: `Drafting a plan for "${event.payload.goal}".`
    });

    const workersai = createWorkersAI({ binding: this.env.AI });
    const draft = await step.do("generate-goal-plan", async () => {
      const result = await generateText({
        model: workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
        prompt: `You are helping a user turn a goal into a practical seven-day action plan.

Goal:
${event.payload.goal}

Known user context:
${JSON.stringify(event.payload.userContext, null, 2)}

Write:
1. A one-sentence summary.
2. A 7-day action plan with one concrete step per day.
3. Two likely risks.
4. A short encouragement line.

Keep it concise, supportive, and practical.`
      });

      return result.text;
    });

    await this.reportProgress({
      step: "finalizing",
      status: "running",
      message: "Finishing the plan and saving it to memory."
    });

    const completedPlan: GoalPlan = {
      ...basePlan,
      status: "complete",
      completedAt: new Date().toISOString(),
      summary: "Your seven-day action plan is ready.",
      plan: draft
    };

    await step.mergeAgentState({ activePlan: completedPlan });
    await step.reportComplete({
      goal: event.payload.goal,
      plan: draft
    });

    this.broadcastToClients({
      type: "workflow-complete",
      goal: event.payload.goal,
      workflowId: this.workflowId
    });

    return completedPlan;
  }
}

export class ChatAgent extends AIChatAgent<Env, CoachState> {
  initialState = INITIAL_STATE;
  maxPersistedMessages = 100;

  onStart() {
    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        if (result.authSuccess) {
          return new Response("<script>window.close();</script>", {
            headers: { "content-type": "text/html" },
            status: 200
          });
        }
        return new Response(
          `Authentication Failed: ${result.authError || "Unknown error"}`,
          { headers: { "content-type": "text/plain" }, status: 400 }
        );
      }
    });
  }

  @callable()
  async addServer(name: string, url: string) {
    return await this.addMcpServer(name, url);
  }

  @callable()
  async removeServer(serverId: string) {
    await this.removeMcpServer(serverId);
  }

  @callable()
  async getCoachState() {
    return getStateSnapshot(this.state);
  }

  async onWorkflowProgress(
    _workflowName: string,
    _workflowId: string,
    progress: unknown
  ) {
    const state = getStateSnapshot(this.state);
    const next = addWorkflowEvent(
      state,
      typeof progress === "object" &&
        progress &&
        "message" in progress &&
        typeof progress.message === "string"
        ? progress.message
        : "Workflow updated."
    );

    this.setState(next);
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const mcpTools = this.mcp.getAITools();
    const workersai = createWorkersAI({ binding: this.env.AI });
    const modelMessages = inlineDataUrls(
      await convertToModelMessages(this.messages)
    );
    const currentState = getStateSnapshot(this.state);
    const toolkit = getToolkit(currentState);
    const nextState: CoachState = {
      ...currentState,
      toolkit: {
        ...toolkit,
        usage: {
          ...toolkit.usage,
          llmCalls: toolkit.usage.llmCalls + 1,
          estimatedInputChars:
            toolkit.usage.estimatedInputChars +
            estimateLastUserChars(modelMessages)
        }
      }
    };
    this.setState(nextState);
    const compactState = compactStateForPrompt(nextState);

    const result = streamText({
      model: workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        sessionAffinity: this.sessionAffinity
      }),
      system: `You are NebulaPilot, an AI execution copilot built on Cloudflare.

You help users turn goals into realistic next steps. You have durable memory, workflows, and advanced tools.

Context window policy:
- Keep responses concise.
- Do not restate long raw tool outputs.
- Use this compact state as source of truth for memory continuity.

Compact state:
${compactState}

Behavior rules:
- When a user shares stable personal context such as their name, main goal, preferred cadence, or constraints, use rememberUserPreferences.
- When the user asks for a plan, roadmap, or breakdown of a goal, use createActionPlan.
- If a workflow is still running, say that the plan is being prepared and avoid pretending it is already complete.
- Use viewSavedMemory when you need to quote stored context back to the user.
- When users ask for fresh web information, use browseAndSummarize.
- When users ask for visual proof of a page, use browseWithScreenshot.
- Use extractStructuredData for schema-based extraction.
- Use factCheckClaim for verification with confidence.
- Use rssMonitor for feed deltas.
- Use pdfReader for PDF summaries.
- Use calendarSync for Google/Outlook task scheduling handoff.
- Use createWorkItem for Notion/Jira task handoff.
- Use voiceMode for voice input/output preferences.
- Use goalProgressTracker for weekly metrics and streaks.
- Use emailDigest for digest setup and send-now.
- Use costGuard to inspect limits and block expensive calls if needed.
- Keep replies warm, concise, and practical.
- Never output raw tool/function schemas, JSON argument templates, or internal function names unless the user explicitly asks for technical schema output.
- When users ask what you can do, answer in natural language with a short, practical capability list and 3-5 example prompts.

${getSchedulePrompt({ date: new Date() })}

If the user asks to schedule a reminder or check-in, use the schedule tool.`,
      messages: pruneMessages({
        messages: modelMessages,
        toolCalls: "before-last-2-messages"
      }),
      tools: {
        ...mcpTools,

        rememberUserPreferences: tool({
          description:
            "Save durable user memory like name, goal, preferred cadence, or constraints.",
          inputSchema: z.object({
            name: z.string().optional(),
            goal: z.string().optional(),
            preferredCadence: z.string().optional(),
            constraints: z.string().optional()
          }),
          execute: async (input) => {
            const current = getStateSnapshot(this.state);
            const next: CoachState = {
              ...current,
              profile: {
                ...current.profile,
                ...Object.fromEntries(
                  Object.entries(input).filter(([, value]) => Boolean(value))
                )
              }
            };

            this.setState(next);
            return next.profile;
          }
        }),

        viewSavedMemory: tool({
          description:
            "Read the saved user profile and current workflow-backed plan state.",
          inputSchema: z.object({}),
          execute: async () => {
            const state = getStateSnapshot(this.state);
            return {
              profile: state.profile,
              activePlan: state.activePlan,
              workflowEvents: state.workflowEvents
            };
          }
        }),

        createActionPlan: tool({
          description:
            "Start a background workflow that generates a seven-day action plan for the user's goal.",
          inputSchema: z.object({
            goal: z.string().describe("The goal to break down into a plan")
          }),
          execute: async ({ goal }) => {
            const current = getStateSnapshot(this.state);
            const workflowId = await this.runWorkflow(
              "GOAL_PLANNING_WORKFLOW",
              {
                goal,
                userContext: {
                  ...current.profile,
                  goal: current.profile.goal || goal
                }
              }
            );

            const next = addWorkflowEvent(
              {
                ...current,
                activePlan: {
                  workflowId,
                  goal,
                  status: "running",
                  createdAt: new Date().toISOString(),
                  summary: "Workflow started. Building your seven-day plan."
                }
              },
              `Started planning workflow for "${goal}".`
            );

            this.setState(next);

            return {
              workflowId,
              status: "running",
              message: "Action plan workflow started."
            };
          }
        }),

        browseAndSummarize: tool({
          description:
            "Browse a public URL with Playwright and return a concise page snapshot for up-to-date web research.",
          inputSchema: z.object({
            url: z
              .string()
              .describe(
                "The webpage URL to browse, for example blog.cloudflare.com"
              ),
            focus: z
              .string()
              .optional()
              .describe(
                "Optional extraction focus, like pricing, release notes, or requirements"
              )
          }),
          execute: async ({ url, focus }) => {
            const before = getStateSnapshot(this.state);
            const beforeToolkit = getToolkit(before);
            if (shouldBlockExpensiveTools(before)) {
              throw new Error("CostGuard limit reached for expensive tools.");
            }
            this.setState({
              ...before,
              toolkit: {
                ...beforeToolkit,
                usage: {
                  ...beforeToolkit.usage,
                  toolCalls: beforeToolkit.usage.toolCalls + 1,
                  browserRuns: beforeToolkit.usage.browserRuns + 1
                }
              }
            });
            const targetUrl = normalizeBrowsableUrl(url);
            const browser = await launch(this.env.BROWSER);

            try {
              const page = await browser.newPage();
              await page.goto(targetUrl, {
                waitUntil: "domcontentloaded",
                timeout: 45_000
              });

              const finalUrl = page.url();
              const title = await page.title();
              const extractedText = await page
                .locator("body")
                .innerText()
                .catch(() => "");
              const excerpt = extractedText
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 7000);

              const links = await page.locator("a").evaluateAll((anchors) =>
                anchors
                  .map((anchor) => {
                    const href = anchor.getAttribute("href");
                    const text = anchor.textContent?.trim();
                    return href && text ? { href, text } : null;
                  })
                  .filter((value): value is { href: string; text: string } =>
                    Boolean(value)
                  )
                  .slice(0, 12)
              );

              return {
                finalUrl,
                title,
                focus: focus || null,
                excerpt,
                topLinks: links
              };
            } finally {
              await browser.close();
            }
          }
        }),

        browseWithScreenshot: tool({
          description:
            "Browse a public URL and return both a concise content snapshot and a screenshot preview.",
          inputSchema: z.object({
            url: z
              .string()
              .describe(
                "The webpage URL to browse, for example blog.cloudflare.com"
              ),
            fullPage: z
              .boolean()
              .optional()
              .describe("Whether to capture a full-page screenshot")
          }),
          execute: async ({ url, fullPage }) => {
            const targetUrl = normalizeBrowsableUrl(url);
            const before = getStateSnapshot(this.state);
            const beforeToolkit = getToolkit(before);
            if (shouldBlockExpensiveTools(before)) {
              throw new Error("CostGuard limit reached for expensive tools.");
            }
            this.setState({
              ...before,
              toolkit: {
                ...beforeToolkit,
                usage: {
                  ...beforeToolkit.usage,
                  toolCalls: beforeToolkit.usage.toolCalls + 1,
                  browserRuns: beforeToolkit.usage.browserRuns + 1
                }
              }
            });
            const browser = await launch(this.env.BROWSER);

            try {
              const page = await browser.newPage();
              await page.setViewportSize({ width: 1280, height: 720 });
              await page.goto(targetUrl, {
                waitUntil: "domcontentloaded",
                timeout: 45_000
              });

              const finalUrl = page.url();
              const title = await page.title();
              const extractedText = await page
                .locator("body")
                .innerText()
                .catch(() => "");
              const excerpt = extractedText
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 3000);

              const screenshot = (await page.screenshot({
                type: "jpeg",
                quality: 65,
                fullPage: Boolean(fullPage)
              })) as Uint8Array;

              return {
                finalUrl,
                title,
                excerpt,
                screenshotDataUrl: `data:image/jpeg;base64,${bytesToBase64(screenshot)}`,
                capturedAt: new Date().toISOString()
              };
            } finally {
              await browser.close();
            }
          }
        }),

        extractStructuredData: tool({
          description:
            "Extract structured JSON data from a webpage using a schema description.",
          inputSchema: z.object({
            url: z.string().describe("Web page URL"),
            schema: z
              .string()
              .describe(
                "Schema description, e.g. {title:string, price:number, points:string[]}"
              )
          }),
          execute: async ({ url, schema }) => {
            const before = getStateSnapshot(this.state);
            const beforeToolkit = getToolkit(before);
            if (shouldBlockExpensiveTools(before)) {
              throw new Error("CostGuard limit reached for expensive tools.");
            }
            this.setState({
              ...before,
              toolkit: {
                ...beforeToolkit,
                usage: {
                  ...beforeToolkit.usage,
                  toolCalls: beforeToolkit.usage.toolCalls + 1,
                  browserRuns: beforeToolkit.usage.browserRuns + 1
                }
              }
            });
            const targetUrl = normalizeBrowsableUrl(url);
            const browser = await launch(this.env.BROWSER);
            try {
              const page = await browser.newPage();
              await page.goto(targetUrl, {
                waitUntil: "domcontentloaded",
                timeout: 45_000
              });
              const title = await page.title();
              const bodyText = await page
                .locator("body")
                .innerText()
                .catch(() => "");
              const excerpt = bodyText
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 6000);
              const extracted = await generateText({
                model: workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
                prompt: `Extract structured JSON from this page.

Schema:
${schema}

Title:
${title}

Excerpt:
${excerpt}

Return strict JSON only.`
              });
              return {
                finalUrl: page.url(),
                title,
                schema,
                data: parseJsonLoose(extracted.text)
              };
            } finally {
              await browser.close();
            }
          }
        }),

        factCheckClaim: tool({
          description: "Fact-check a claim with sources and confidence.",
          inputSchema: z.object({
            claim: z.string().describe("Claim to check")
          }),
          execute: async ({ claim }) => {
            const before = getStateSnapshot(this.state);
            const beforeToolkit = getToolkit(before);
            if (shouldBlockExpensiveTools(before)) {
              throw new Error("CostGuard limit reached for expensive tools.");
            }
            this.setState({
              ...before,
              toolkit: {
                ...beforeToolkit,
                usage: {
                  ...beforeToolkit.usage,
                  toolCalls: beforeToolkit.usage.toolCalls + 1,
                  browserRuns: beforeToolkit.usage.browserRuns + 1
                }
              }
            });

            const queryUrl = `https://duckduckgo.com/?q=${encodeURIComponent(claim)}`;
            const browser = await launch(this.env.BROWSER);
            try {
              const page = await browser.newPage();
              await page.goto(queryUrl, {
                waitUntil: "domcontentloaded",
                timeout: 45_000
              });
              const excerpt = (
                await page
                  .locator("body")
                  .innerText()
                  .catch(() => "")
              )
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 7000);
              const links = await page.locator("a").evaluateAll((anchors) =>
                anchors
                  .map((anchor) => {
                    const href = anchor.getAttribute("href");
                    const text = anchor.textContent?.trim();
                    return href && text ? { href, text } : null;
                  })
                  .filter((value): value is { href: string; text: string } =>
                    Boolean(value)
                  )
                  .filter((item) => /^https?:\/\//i.test(item.href))
                  .slice(0, 8)
              );

              const analysis = await generateText({
                model: workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
                prompt: `Fact-check this claim and return strict JSON with keys:
verdict, confidence (0..1), reasoning, sources (array of URLs).

Claim:
${claim}

Search excerpt:
${excerpt}

Candidate links:
${JSON.stringify(links.map((link) => link.href))}
`
              });

              return {
                claim,
                ...parseJsonLoose(analysis.text)
              };
            } finally {
              await browser.close();
            }
          }
        }),

        rssMonitor: tool({
          description:
            "Monitor an RSS feed and summarize newly detected items since last check.",
          inputSchema: z.object({
            feedUrl: z.string().describe("RSS feed URL")
          }),
          execute: async ({ feedUrl }) => {
            const normalized = normalizeBrowsableUrl(feedUrl);
            const response = await fetch(normalized);
            if (!response.ok) {
              throw new Error(`Failed to fetch RSS feed: ${response.status}`);
            }
            const xml = await response.text();
            const items = parseRssItems(xml).filter(
              (item) => item.guid && item.title
            );
            const current = getStateSnapshot(this.state);
            const toolkit = getToolkit(current);
            const previous = toolkit.rssFeeds[normalized];
            const seenSet = new Set(previous?.lastSeenGuids || []);
            const newItems = items.filter(
              (item) => !seenSet.has(item.guid as string)
            );
            const updatedState: CoachState = {
              ...current,
              toolkit: {
                ...toolkit,
                usage: {
                  ...toolkit.usage,
                  toolCalls: toolkit.usage.toolCalls + 1
                },
                rssFeeds: {
                  ...toolkit.rssFeeds,
                  [normalized]: {
                    lastSeenGuids: items
                      .map((item) => item.guid as string)
                      .filter(Boolean)
                      .slice(0, 40),
                    lastCheckedAt: new Date().toISOString()
                  }
                }
              }
            };
            this.setState(updatedState);
            return {
              feedUrl: normalized,
              checkedAt: new Date().toISOString(),
              newItemsCount: newItems.length,
              newItems: newItems.slice(0, 8)
            };
          }
        }),

        pdfReader: tool({
          description: "Read a public PDF URL and return a concise summary.",
          inputSchema: z.object({
            url: z.string().describe("Public PDF URL"),
            focus: z.string().optional()
          }),
          execute: async ({ url, focus }) => {
            const before = getStateSnapshot(this.state);
            const beforeToolkit = getToolkit(before);
            if (shouldBlockExpensiveTools(before)) {
              throw new Error("CostGuard limit reached for expensive tools.");
            }
            this.setState({
              ...before,
              toolkit: {
                ...beforeToolkit,
                usage: {
                  ...beforeToolkit.usage,
                  toolCalls: beforeToolkit.usage.toolCalls + 1,
                  browserRuns: beforeToolkit.usage.browserRuns + 1
                }
              }
            });
            const targetUrl = normalizeBrowsableUrl(url);
            const browser = await launch(this.env.BROWSER);
            try {
              const page = await browser.newPage();
              await page.goto(targetUrl, {
                waitUntil: "domcontentloaded",
                timeout: 45_000
              });
              const text = (
                await page
                  .locator("body")
                  .innerText()
                  .catch(() => "")
              )
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 7000);
              const summary = await generateText({
                model: workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
                prompt: `Summarize this PDF excerpt. Focus: ${focus || "general"}\n\n${text}`
              });
              return {
                finalUrl: page.url(),
                title: await page.title(),
                summary: summary.text
              };
            } finally {
              await browser.close();
            }
          }
        }),

        calendarSync: tool({
          description:
            "Create Google/Outlook calendar tasks via webhook when configured, otherwise queue locally.",
          inputSchema: z.object({
            provider: z.enum(["google", "outlook"]),
            title: z.string(),
            when: z.string(),
            notes: z.string().optional()
          }),
          execute: async ({ provider, title, when, notes }) => {
            const payload = { provider, title, when, notes: notes || "" };
            const current = getStateSnapshot(this.state);
            const toolkit = getToolkit(current);
            const webhook = (this.env as unknown as Record<string, unknown>)
              .CALENDAR_SYNC_WEBHOOK;
            if (typeof webhook === "string" && webhook) {
              await fetch(webhook, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(payload)
              });
              this.setState({
                ...current,
                toolkit: {
                  ...toolkit,
                  usage: {
                    ...toolkit.usage,
                    toolCalls: toolkit.usage.toolCalls + 1
                  }
                }
              });
              return { synced: true, payload };
            }
            const queuedItem = {
              id: crypto.randomUUID(),
              provider,
              payload,
              queuedAt: new Date().toISOString()
            };
            this.setState({
              ...current,
              toolkit: {
                ...toolkit,
                usage: {
                  ...toolkit.usage,
                  toolCalls: toolkit.usage.toolCalls + 1
                },
                integrationQueue: [
                  queuedItem,
                  ...toolkit.integrationQueue
                ].slice(0, 50)
              }
            });
            return {
              synced: false,
              reason: "CALENDAR_SYNC_WEBHOOK not configured",
              queuedItem
            };
          }
        }),

        createWorkItem: tool({
          description:
            "Create Notion/Jira tasks via webhook when configured, otherwise queue locally.",
          inputSchema: z.object({
            provider: z.enum(["notion", "jira"]),
            title: z.string(),
            description: z.string().optional(),
            priority: z.enum(["low", "medium", "high"]).default("medium")
          }),
          execute: async ({ provider, title, description, priority }) => {
            const payload = {
              provider,
              title,
              description: description || "",
              priority
            };
            const current = getStateSnapshot(this.state);
            const toolkit = getToolkit(current);
            const webhook = (this.env as unknown as Record<string, unknown>)
              .WORK_ITEM_SYNC_WEBHOOK;
            if (typeof webhook === "string" && webhook) {
              await fetch(webhook, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(payload)
              });
              this.setState({
                ...current,
                toolkit: {
                  ...toolkit,
                  usage: {
                    ...toolkit.usage,
                    toolCalls: toolkit.usage.toolCalls + 1
                  }
                }
              });
              return { created: true, payload };
            }
            const queuedItem = {
              id: crypto.randomUUID(),
              provider,
              payload,
              queuedAt: new Date().toISOString()
            };
            this.setState({
              ...current,
              toolkit: {
                ...toolkit,
                usage: {
                  ...toolkit.usage,
                  toolCalls: toolkit.usage.toolCalls + 1
                },
                integrationQueue: [
                  queuedItem,
                  ...toolkit.integrationQueue
                ].slice(0, 50)
              }
            });
            return {
              created: false,
              reason: "WORK_ITEM_SYNC_WEBHOOK not configured",
              queuedItem
            };
          }
        }),

        voiceMode: tool({
          description:
            "Set voice input / TTS preferences and selected voice style.",
          inputSchema: z.object({
            enableVoiceInput: z.boolean().optional(),
            enableTtsOutput: z.boolean().optional(),
            voice: z.string().optional()
          }),
          execute: async (input) => {
            const current = getStateSnapshot(this.state);
            const toolkit = getToolkit(current);
            const nextVoiceMode = {
              enableVoiceInput:
                input.enableVoiceInput ?? toolkit.voiceMode.enableVoiceInput,
              enableTtsOutput:
                input.enableTtsOutput ?? toolkit.voiceMode.enableTtsOutput,
              voice: input.voice || toolkit.voiceMode.voice
            };
            this.setState({
              ...current,
              toolkit: {
                ...toolkit,
                usage: {
                  ...toolkit.usage,
                  toolCalls: toolkit.usage.toolCalls + 1
                },
                voiceMode: nextVoiceMode
              }
            });
            return nextVoiceMode;
          }
        }),

        goalProgressTracker: tool({
          description:
            "Log progress and return weekly completion plus streak insights.",
          inputSchema: z.object({
            action: z.enum(["log", "summary", "reset"]),
            completed: z.boolean().optional(),
            note: z.string().optional(),
            date: z.string().optional().describe("YYYY-MM-DD")
          }),
          execute: async ({ action, completed, note, date }) => {
            const current = getStateSnapshot(this.state);
            const toolkit = getToolkit(current);
            if (action === "reset") {
              this.setState({
                ...current,
                toolkit: {
                  ...toolkit,
                  usage: {
                    ...toolkit.usage,
                    toolCalls: toolkit.usage.toolCalls + 1
                  },
                  progressLog: []
                }
              });
              return { status: "reset", streak: 0 };
            }
            if (action === "log") {
              const entry = {
                date: date || new Date().toISOString().slice(0, 10),
                completed: Boolean(completed),
                note
              };
              const nextLog = [entry, ...toolkit.progressLog].slice(0, 120);
              this.setState({
                ...current,
                toolkit: {
                  ...toolkit,
                  usage: {
                    ...toolkit.usage,
                    toolCalls: toolkit.usage.toolCalls + 1
                  },
                  progressLog: nextLog
                }
              });
              return {
                status: "logged",
                latest: entry,
                streak: computeStreak(nextLog)
              };
            }
            const recent = toolkit.progressLog.slice(0, 7);
            this.setState({
              ...current,
              toolkit: {
                ...toolkit,
                usage: {
                  ...toolkit.usage,
                  toolCalls: toolkit.usage.toolCalls + 1
                }
              }
            });
            return {
              streak: computeStreak(toolkit.progressLog),
              weeklyCompleted: recent.filter((entry) => entry.completed).length,
              weeklyTotal: recent.length,
              recent
            };
          }
        }),

        emailDigest: tool({
          description:
            "Configure digest mode, preview digest, or send digest through webhook.",
          inputSchema: z.object({
            action: z.enum(["configure", "preview", "send-now"]),
            cadence: z.enum(["daily", "weekly"]).optional(),
            recipientEmail: z.string().optional()
          }),
          execute: async ({ action, cadence, recipientEmail }) => {
            const current = getStateSnapshot(this.state);
            const toolkit = getToolkit(current);
            const summary = await generateText({
              model: workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
              prompt: `Create a short progress digest.

Profile: ${JSON.stringify(current.profile)}
Active plan: ${JSON.stringify(
                current.activePlan
                  ? {
                      goal: current.activePlan.goal,
                      status: current.activePlan.status,
                      summary: current.activePlan.summary
                    }
                  : null
              )}
Recent progress: ${JSON.stringify(toolkit.progressLog.slice(0, 10))}
`
            });

            if (action === "configure") {
              const nextDigestConfig = {
                cadence: cadence || toolkit.digestConfig.cadence,
                recipientEmail:
                  recipientEmail || toolkit.digestConfig.recipientEmail,
                enabled: true
              };
              this.setState({
                ...current,
                toolkit: {
                  ...toolkit,
                  usage: {
                    ...toolkit.usage,
                    toolCalls: toolkit.usage.toolCalls + 1
                  },
                  digestConfig: nextDigestConfig
                }
              });
              return nextDigestConfig;
            }

            if (action === "preview") {
              this.setState({
                ...current,
                toolkit: {
                  ...toolkit,
                  usage: {
                    ...toolkit.usage,
                    toolCalls: toolkit.usage.toolCalls + 1
                  }
                }
              });
              return {
                preview: summary.text,
                digestConfig: toolkit.digestConfig
              };
            }

            const payload = {
              to: recipientEmail || toolkit.digestConfig.recipientEmail,
              cadence: cadence || toolkit.digestConfig.cadence,
              summary: summary.text
            };
            const webhook = (this.env as unknown as Record<string, unknown>)
              .EMAIL_DIGEST_WEBHOOK;
            if (typeof webhook === "string" && webhook) {
              await fetch(webhook, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(payload)
              });
              this.setState({
                ...current,
                toolkit: {
                  ...toolkit,
                  usage: {
                    ...toolkit.usage,
                    toolCalls: toolkit.usage.toolCalls + 1
                  }
                }
              });
              return { sent: true, payload };
            }
            const queuedItem = {
              id: crypto.randomUUID(),
              provider: "emailDigest",
              payload,
              queuedAt: new Date().toISOString()
            };
            this.setState({
              ...current,
              toolkit: {
                ...toolkit,
                usage: {
                  ...toolkit.usage,
                  toolCalls: toolkit.usage.toolCalls + 1
                },
                integrationQueue: [
                  queuedItem,
                  ...toolkit.integrationQueue
                ].slice(0, 50)
              }
            });
            return {
              sent: false,
              reason: "EMAIL_DIGEST_WEBHOOK not configured",
              queuedItem
            };
          }
        }),

        costGuard: tool({
          description:
            "Inspect, set, or reset usage limits for model and browser usage.",
          inputSchema: z.object({
            action: z.enum(["status", "set-limits", "reset"]),
            maxLlmCalls: z.number().int().positive().optional(),
            maxBrowserRuns: z.number().int().positive().optional(),
            maxInputChars: z.number().int().positive().optional()
          }),
          execute: async ({
            action,
            maxLlmCalls,
            maxBrowserRuns,
            maxInputChars
          }) => {
            const current = getStateSnapshot(this.state);
            const toolkit = getToolkit(current);
            if (action === "reset") {
              const resetUsage = {
                ...INITIAL_STATE.toolkit!.usage!,
                limits: toolkit.usage.limits
              };
              this.setState({
                ...current,
                toolkit: {
                  ...toolkit,
                  usage: resetUsage
                }
              });
              return resetUsage;
            }
            if (action === "set-limits") {
              const nextUsage = {
                ...toolkit.usage,
                toolCalls: toolkit.usage.toolCalls + 1,
                limits: {
                  maxLlmCalls: maxLlmCalls || toolkit.usage.limits.maxLlmCalls,
                  maxBrowserRuns:
                    maxBrowserRuns || toolkit.usage.limits.maxBrowserRuns,
                  maxInputChars:
                    maxInputChars || toolkit.usage.limits.maxInputChars
                }
              };
              this.setState({
                ...current,
                toolkit: {
                  ...toolkit,
                  usage: nextUsage
                }
              });
              return nextUsage;
            }
            const nextUsage = {
              ...toolkit.usage,
              toolCalls: toolkit.usage.toolCalls + 1
            };
            this.setState({
              ...current,
              toolkit: {
                ...toolkit,
                usage: nextUsage
              }
            });
            return {
              ...nextUsage,
              expensiveToolsBlocked: shouldBlockExpensiveTools({
                ...current,
                toolkit: { ...toolkit, usage: nextUsage }
              })
            };
          }
        }),

        getUserTimezone: tool({
          description:
            "Get the user's timezone from their browser. Use this when you need to know the user's local time.",
          inputSchema: z.object({})
        }),

        scheduleTask: tool({
          description:
            "Schedule a reminder or check-in for the user at a later time.",
          inputSchema: scheduleSchema,
          execute: async ({ when, description }) => {
            if (when.type === "no-schedule") {
              return "Not a valid schedule input";
            }
            const input =
              when.type === "scheduled"
                ? when.date
                : when.type === "delayed"
                  ? when.delayInSeconds
                  : when.type === "cron"
                    ? when.cron
                    : null;
            if (!input) return "Invalid schedule type";
            try {
              this.schedule(input, "executeTask", description, {
                idempotent: true
              });
              return `Reminder scheduled: "${description}" (${when.type}: ${input})`;
            } catch (error) {
              return `Error scheduling task: ${error}`;
            }
          }
        }),

        getScheduledTasks: tool({
          description: "List all reminders that have been scheduled",
          inputSchema: z.object({}),
          execute: async () => {
            const tasks = this.getSchedules();
            return tasks.length > 0 ? tasks : "No scheduled tasks found.";
          }
        })
      },
      stopWhen: stepCountIs(6),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }

  async executeTask(description: string, _task: Schedule<string>) {
    this.broadcast(
      JSON.stringify({
        type: "scheduled-task",
        description,
        timestamp: new Date().toISOString()
      })
    );
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) {
      return agentResponse;
    }

    const assets = (env as Env & { ASSETS?: Fetcher }).ASSETS;
    if (assets) {
      return assets.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;
