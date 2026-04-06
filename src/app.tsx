import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import type { ChatAgent } from "./server";
import {
  Badge,
  Button,
  Empty,
  InputArea,
  Surface,
  Switch,
  Text
} from "@cloudflare/kumo";
import { Toasty, useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import {
  ChatCircleDotsIcon,
  CircleIcon,
  MoonIcon,
  PaperPlaneRightIcon,
  PaperclipIcon,
  PlusIcon,
  StopIcon,
  SunIcon,
  TrashIcon,
  XIcon
} from "@phosphor-icons/react";

type CoachState = Awaited<ReturnType<ChatAgent["getCoachState"]>>;

type Attachment = {
  id: string;
  file: File;
  preview: string;
  mediaType: string;
};

type ToolTemplate = {
  label: string;
  prompt: string;
};

const TOOL_TEMPLATES: ToolTemplate[] = [
  {
    label: "Save memory",
    prompt:
      "Save this to memory: My name is Akash, my main goal is cracking system design interviews, and I prefer daily 45-minute sessions."
  },
  {
    label: "Create action plan",
    prompt: "Create a seven-day action plan for my system design prep."
  },
  {
    label: "Browse and summarize",
    prompt:
      "Browse https://blog.cloudflare.com and summarize the latest AI announcements."
  },
  {
    label: "Browse with screenshot",
    prompt:
      "Browse https://blog.cloudflare.com and include a screenshot preview of the homepage."
  },
  {
    label: "Schedule reminder",
    prompt: "Remind me tomorrow at 7 PM to review day 1."
  },
  {
    label: "Read saved memory",
    prompt: "Show me everything you currently have in saved memory."
  },
  {
    label: "Extract structured data",
    prompt:
      "Extract structured data from https://blog.cloudflare.com according to schema {headline:string, publish_date:string, key_points:string[]}."
  },
  {
    label: "Fact-check claim",
    prompt: "Fact-check this claim: Cloudflare Workers AI supports Llama 3.3."
  },
  {
    label: "Monitor RSS feed",
    prompt:
      "Monitor this RSS feed and show new items: https://blog.cloudflare.com/rss/"
  },
  {
    label: "Read PDF",
    prompt:
      "Read this PDF and summarize key points: https://www.rfc-editor.org/rfc/rfc2616.pdf"
  },
  {
    label: "Calendar sync",
    prompt:
      "Create a Google calendar event for tomorrow 7 PM titled 'Review system design notes'."
  },
  {
    label: "Notion/Jira task",
    prompt:
      "Create a Jira task with high priority: Finish mock interview prep checklist."
  },
  {
    label: "Voice mode",
    prompt: "Enable voice input and text-to-speech output with a calm voice."
  },
  {
    label: "Progress tracker",
    prompt: "Log that I completed today's prep and show my current streak."
  },
  {
    label: "Email digest",
    prompt: "Configure a weekly email digest and send me a preview now."
  },
  {
    label: "Cost guard",
    prompt: "Show current cost guard status and set max browser runs to 80."
  }
];

function isImagePart(
  part: UIMessage["parts"][number]
): part is Extract<UIMessage["parts"][number], { type: "file"; url: string }> {
  return part.type === "file" && part.mediaType?.startsWith("image/") === true;
}

function isTextPart(
  part: UIMessage["parts"][number]
): part is Extract<UIMessage["parts"][number], { type: "text"; text: string }> {
  return part.type === "text" && typeof part.text === "string";
}

function createAttachment(file: File): Attachment {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    file,
    preview: URL.createObjectURL(file),
    mediaType: file.type || "application/octet-stream"
  };
}

function fileToDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function ThemeToggle() {
  const [dark, setDark] = useState(
    () => document.documentElement.getAttribute("data-mode") === "dark"
  );

  const toggle = useCallback(() => {
    const next = !dark;
    setDark(next);
    const mode = next ? "dark" : "light";
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [dark]);

  return (
    <Button
      variant="secondary"
      shape="square"
      icon={dark ? <SunIcon size={16} /> : <MoonIcon size={16} />}
      onClick={toggle}
      aria-label="Toggle theme"
    />
  );
}

function MemoryPanel({ state }: { state?: CoachState }) {
  const profile = state?.profile;
  const plan = state?.activePlan;
  const events = state?.workflowEvents ?? [];

  return (
    <Surface className="rounded-2xl ring ring-kumo-line p-4 bg-kumo-base">
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Text size="sm" bold>
            Durable memory
          </Text>
          <Text size="xs" variant="secondary">
            Saved in agent state so the chat can remember user context.
          </Text>
          <div className="space-y-1 text-sm text-kumo-default">
            <div>Name: {profile?.name || "Not saved yet"}</div>
            <div>Goal: {profile?.goal || "Not saved yet"}</div>
            <div>Cadence: {profile?.preferredCadence || "Not saved yet"}</div>
            <div>Constraints: {profile?.constraints || "Not saved yet"}</div>
          </div>
        </div>

        <div className="space-y-2">
          <Text size="sm" bold>
            Workflow status
          </Text>
          <Text size="xs" variant="secondary">
            Background plan generation running on Cloudflare Workflows.
          </Text>
          <div className="space-y-1 text-sm text-kumo-default">
            <div>Status: {plan?.status || "idle"}</div>
            <div>Goal: {plan?.goal || "No active workflow"}</div>
            <div>
              Summary:{" "}
              {plan?.summary || "Ask for a seven-day plan to start one."}
            </div>
          </div>
        </div>
      </div>

      {events.length > 0 && (
        <div className="mt-4 border-t border-kumo-line pt-4">
          <Text size="xs" variant="secondary">
            Recent workflow events
          </Text>
          <div className="mt-2 space-y-1 text-sm text-kumo-default">
            {events.slice(0, 3).map((event) => (
              <div key={`${event.timestamp}-${event.message}`}>
                {event.message}
              </div>
            ))}
          </div>
        </div>
      )}

      {plan?.plan && (
        <div className="mt-4 border-t border-kumo-line pt-4">
          <Text size="xs" variant="secondary">
            Latest generated plan
          </Text>
          <div className="mt-2 rounded-xl bg-kumo-control p-3 text-sm text-kumo-default">
            <Streamdown plugins={{ code }} controls={false}>
              {plan.plan}
            </Streamdown>
          </div>
        </div>
      )}
    </Surface>
  );
}

function MessageBubble({
  message,
  isStreaming
}: {
  message: UIMessage;
  isStreaming: boolean;
}) {
  const isUser = message.role === "user";

  return (
    <div className="space-y-2">
      {message.parts.filter(isToolUIPart).map((part) => {
        const toolName = getToolName(part);
        const id = `${message.id}-tool-${part.toolCallId}`;

        if (
          part.state === "input-available" ||
          part.state === "input-streaming"
        ) {
          return (
            <div key={id} className="flex justify-start">
              <Surface className="max-w-[90%] rounded-xl ring ring-kumo-line px-3 py-2">
                <Text size="xs" variant="secondary">
                  Running tool: {toolName}
                </Text>
              </Surface>
            </div>
          );
        }

        if (part.state === "output-available") {
          const output = part.output as Record<string, unknown> | undefined;
          const screenshotDataUrl =
            output && typeof output.screenshotDataUrl === "string"
              ? output.screenshotDataUrl
              : undefined;

          return (
            <div key={id} className="flex justify-start">
              <Surface className="max-w-[90%] rounded-xl ring ring-kumo-line px-3 py-2.5">
                <Text size="xs" variant="secondary" bold>
                  Tool output: {toolName}
                </Text>
                {screenshotDataUrl && (
                  <img
                    src={screenshotDataUrl}
                    alt={`Screenshot from ${toolName}`}
                    className="mt-2 max-h-72 rounded-lg border border-kumo-line object-contain"
                  />
                )}
                <pre className="mt-2 max-h-56 overflow-auto rounded-md bg-kumo-control p-2 text-[11px] text-kumo-subtle">
                  {JSON.stringify(part.output, null, 2)}
                </pre>
              </Surface>
            </div>
          );
        }

        if (part.state === "output-error") {
          return (
            <div key={id} className="flex justify-start">
              <Surface className="max-w-[90%] rounded-xl ring ring-kumo-danger px-3 py-2">
                <Text size="xs" variant="secondary">
                  Tool error: {toolName}
                </Text>
              </Surface>
            </div>
          );
        }

        if (
          part.state === "output-denied" ||
          part.state === "approval-requested"
        ) {
          return (
            <div key={id} className="flex justify-start">
              <Surface className="max-w-[90%] rounded-xl ring ring-kumo-line px-3 py-2">
                <Text size="xs" variant="secondary">
                  Tool status: {toolName} ({part.state})
                </Text>
              </Surface>
            </div>
          );
        }

        return null;
      })}

      {message.parts.filter(isImagePart).map((part, index) => (
        <div
          key={`${message.id}-file-${index}`}
          className={`flex ${isUser ? "justify-end" : "justify-start"}`}
        >
          <img
            src={part.url}
            alt="Attachment"
            className="max-h-64 rounded-xl border border-kumo-line object-contain"
          />
        </div>
      ))}

      {message.parts.filter(isTextPart).map((part, index) => (
        <div
          key={`${message.id}-text-${index}`}
          className={`flex ${isUser ? "justify-end" : "justify-start"}`}
        >
          {isUser ? (
            <div className="max-w-[85%] rounded-2xl rounded-br-md bg-kumo-contrast px-4 py-2.5 text-kumo-inverse">
              {part.text}
            </div>
          ) : (
            <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-kumo-base">
              <Streamdown
                className="sd-theme rounded-2xl rounded-bl-md p-3"
                plugins={{ code }}
                controls={false}
                isAnimating={isStreaming}
              >
                {part.text}
              </Streamdown>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function Chat() {
  const [connected, setConnected] = useState(false);
  const [input, setInput] = useState("");
  const [showDebug, setShowDebug] = useState(false);
  const [showToolMenu, setShowToolMenu] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [coachState, setCoachState] = useState<CoachState>();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const toolMenuRef = useRef<HTMLDivElement>(null);
  const toasts = useKumoToastManager();

  const agent = useAgent<ChatAgent>({
    agent: "ChatAgent",
    onOpen: useCallback(async () => {
      setConnected(true);
      const state = await agent.stub.getCoachState();
      setCoachState(state);
    }, []),
    onClose: useCallback(() => setConnected(false), []),
    onError: useCallback(
      (error: Event) => console.error("WebSocket error:", error),
      []
    ),
    onStateUpdate: useCallback((state) => {
      setCoachState(state as unknown as CoachState | undefined);
    }, []),
    onMessage: useCallback(
      (message: MessageEvent) => {
        try {
          const data = JSON.parse(String(message.data));
          if (data.type === "scheduled-task") {
            toasts.add({
              title: "Reminder fired",
              description: data.description,
              timeout: 0
            });
          }

          if (data.type === "workflow-complete") {
            toasts.add({
              title: "Action plan ready",
              description: `Finished plan for ${data.goal}`,
              timeout: 0
            });
          }
        } catch {
          // ignore non-JSON messages
        }
      },
      [toasts]
    )
  });

  const { messages, sendMessage, clearHistory, stop, status } = useAgentChat({
    agent,
    onToolCall: async (event) => {
      if (
        "addToolOutput" in event &&
        event.toolCall.toolName === "getUserTimezone"
      ) {
        event.addToolOutput({
          toolCallId: event.toolCall.toolCallId,
          output: {
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            localTime: new Date().toLocaleTimeString()
          }
        });
      }
    }
  });

  const isStreaming = status === "streaming" || status === "submitted";

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!isStreaming) {
      textareaRef.current?.focus();
    }
  }, [isStreaming]);

  useEffect(() => {
    if (!showToolMenu) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (
        toolMenuRef.current &&
        !toolMenuRef.current.contains(event.target as Node)
      ) {
        setShowToolMenu(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showToolMenu]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const found = prev.find((item) => item.id === id);
      if (found) URL.revokeObjectURL(found.preview);
      return prev.filter((item) => item.id !== id);
    });
  }, []);

  const addFiles = useCallback((files: FileList | File[]) => {
    const images = Array.from(files).filter((file) =>
      file.type.startsWith("image/")
    );
    if (images.length === 0) return;
    setAttachments((prev) => [...prev, ...images.map(createAttachment)]);
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if ((!text && attachments.length === 0) || isStreaming) return;

    const parts: Array<
      | { type: "text"; text: string }
      | { type: "file"; mediaType: string; url: string }
    > = [];

    if (text) parts.push({ type: "text", text });

    for (const attachment of attachments) {
      const dataUri = await fileToDataUri(attachment.file);
      parts.push({
        type: "file",
        mediaType: attachment.mediaType,
        url: dataUri
      });
      URL.revokeObjectURL(attachment.preview);
    }

    setAttachments([]);
    setInput("");
    sendMessage({ role: "user", parts });

    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [attachments, input, isStreaming, sendMessage]);

  return (
    <div className="flex min-h-screen flex-col bg-kumo-elevated">
      <header className="border-b border-kumo-line bg-kumo-base px-5 py-4">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div>
              <Text size="sm" bold>
                NebulaPilot
              </Text>
              <Text size="xs" variant="secondary">
                Execution copilot with memory, workflows, browser tooling, and
                guardrails
              </Text>
            </div>
            <Badge variant="secondary">
              <ChatCircleDotsIcon size={12} className="mr-1" />
              Cloudflare Agents
            </Badge>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <CircleIcon
                size={8}
                weight="fill"
                className={connected ? "text-kumo-success" : "text-kumo-danger"}
              />
              <Text size="xs" variant="secondary">
                {connected ? "Connected" : "Disconnected"}
              </Text>
            </div>
            <div className="flex items-center gap-2">
              <Text size="xs" variant="secondary">
                Debug
              </Text>
              <Switch
                checked={showDebug}
                onCheckedChange={setShowDebug}
                size="sm"
                aria-label="Toggle debug mode"
              />
            </div>
            <ThemeToggle />
            <Button
              variant="secondary"
              icon={<TrashIcon size={16} />}
              onClick={clearHistory}
            >
              Clear chat
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 px-5 py-6">
        <MemoryPanel state={coachState} />

        <div className="flex-1 overflow-y-auto">
          <div className="space-y-5">
            {messages.length === 0 && (
              <Empty
                icon={<ChatCircleDotsIcon size={32} />}
                title="Start a conversation"
                contents={
                  <div className="flex flex-wrap justify-center gap-2">
                    {[
                      "My name is Akash and I want to improve my system design skills.",
                      "Create a seven-day action plan for interview prep.",
                      "Fact-check this claim: Workers AI supports Llama 3.3.",
                      "Show my cost guard status and current streak."
                    ].map((prompt) => (
                      <Button
                        key={prompt}
                        variant="outline"
                        size="sm"
                        disabled={isStreaming}
                        onClick={() =>
                          sendMessage({
                            role: "user",
                            parts: [{ type: "text", text: prompt }]
                          })
                        }
                      >
                        {prompt}
                      </Button>
                    ))}
                  </div>
                }
              />
            )}

            {messages.map((message, index) => (
              <div key={message.id} className="space-y-2">
                {showDebug && (
                  <pre className="max-h-64 overflow-auto rounded-lg bg-kumo-control p-3 text-[11px] text-kumo-subtle">
                    {JSON.stringify(message, null, 2)}
                  </pre>
                )}
                <MessageBubble
                  message={message}
                  isStreaming={
                    message.role === "assistant" &&
                    index === messages.length - 1 &&
                    isStreaming
                  }
                />
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
          className="border-t border-kumo-line bg-kumo-base px-1 pt-4"
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*"
            className="hidden"
            onChange={(event) => {
              if (event.target.files) addFiles(event.target.files);
              event.target.value = "";
            }}
          />

          {attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {attachments.map((attachment) => (
                <div
                  key={attachment.id}
                  className="relative overflow-hidden rounded-lg border border-kumo-line bg-kumo-control"
                >
                  <img
                    src={attachment.preview}
                    alt={attachment.file.name}
                    className="h-16 w-16 object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => removeAttachment(attachment.id)}
                    className="absolute right-0.5 top-0.5 rounded-full bg-kumo-contrast/80 p-0.5 text-kumo-inverse"
                    aria-label={`Remove ${attachment.file.name}`}
                  >
                    <XIcon size={10} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-end gap-3 rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-sm">
            <div className="relative" ref={toolMenuRef}>
              <Button
                type="button"
                variant="secondary"
                shape="square"
                aria-label="Open tools menu"
                icon={<PlusIcon size={18} />}
                onClick={() => setShowToolMenu((prev) => !prev)}
                disabled={!connected || isStreaming}
              />
              {showToolMenu && (
                <Surface className="absolute bottom-12 left-0 z-20 w-64 rounded-xl ring ring-kumo-line p-2 shadow-lg">
                  <div className="px-2 py-1">
                    <Text size="xs" variant="secondary">
                      Quick tool prompts
                    </Text>
                  </div>
                  <div className="space-y-1">
                    {TOOL_TEMPLATES.map((template) => (
                      <Button
                        key={template.label}
                        variant="ghost"
                        size="sm"
                        className="w-full justify-start"
                        onClick={() => {
                          setInput(template.prompt);
                          setShowToolMenu(false);
                          textareaRef.current?.focus();
                        }}
                      >
                        {template.label}
                      </Button>
                    ))}
                  </div>
                </Surface>
              )}
            </div>
            <Button
              type="button"
              variant="ghost"
              shape="square"
              aria-label="Attach images"
              icon={<PaperclipIcon size={18} />}
              onClick={() => fileInputRef.current?.click()}
              disabled={!connected || isStreaming}
            />
            <InputArea
              ref={textareaRef}
              value={input}
              onValueChange={setInput}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
              onInput={(event) => {
                const target = event.currentTarget;
                target.style.height = "auto";
                target.style.height = `${target.scrollHeight}px`;
              }}
              placeholder="Ask NebulaPilot, or use + for tool-specific prompts..."
              disabled={!connected || isStreaming}
              rows={1}
              className="max-h-40 flex-1 resize-none bg-transparent! shadow-none! ring-0! outline-none! focus:ring-0!"
            />
            {isStreaming ? (
              <Button
                type="button"
                variant="secondary"
                shape="square"
                aria-label="Stop generation"
                icon={<StopIcon size={18} />}
                onClick={stop}
              />
            ) : (
              <Button
                type="submit"
                variant="primary"
                shape="square"
                aria-label="Send message"
                disabled={
                  (!input.trim() && attachments.length === 0) || !connected
                }
                icon={<PaperPlaneRightIcon size={18} />}
              />
            )}
          </div>
        </form>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <Toasty>
      <Suspense
        fallback={
          <div className="flex h-screen items-center justify-center text-kumo-inactive">
            Loading...
          </div>
        }
      >
        <Chat />
      </Suspense>
    </Toasty>
  );
}
