# cf_ai_goal_coach

`cf_ai_goal_coach` now runs as **NebulaPilot**, an AI-powered execution copilot built for the Cloudflare internship assignment. It gives users a chat interface, remembers durable profile details, and can start a background workflow that generates a practical seven-day action plan for a goal.

## Assignment checklist

- `LLM`: Llama 3.3 on Workers AI
- `Workflow / coordination`: Cloudflare Workflows
- `User input`: chat UI built with Cloudflare Agents + React
- `Memory or state`: Durable Object agent state

## What the app does

Users can chat with NebulaPilot, save stable context like their name, goal, study cadence, and constraints, then ask the app to create a seven-day plan. The plan is generated in a background workflow and stored back into durable state so the UI can show workflow progress and the final result.

The bot also has web browsing capability using Cloudflare Browser Rendering + Playwright through a `browseAndSummarize` tool, so it can fetch up-to-date public page content when users ask for current information.
It also supports `browseWithScreenshot` to capture a visual snapshot of a page alongside extracted text.
In the UI, a `+` button in the input area opens quick tool prompts across all major tools so users can trigger tool-focused flows faster.

## Toolset

- `extractStructuredData(url, schema)` for schema-based JSON extraction from webpages
- `factCheckClaim(claim)` with source links and confidence scoring
- `rssMonitor(feedUrl)` to track and summarize feed deltas
- `pdfReader(url)` to summarize public PDF content
- `calendarSync(...)` for Google/Outlook scheduling handoff (webhook-enabled or queued fallback)
- `createWorkItem(...)` for Notion/Jira task handoff (webhook-enabled or queued fallback)
- `voiceMode(...)` to configure voice input and TTS preferences
- `goalProgressTracker(...)` for weekly metrics and streak tracking
- `emailDigest(...)` for digest configuration, preview, and send-now flows
- `costGuard(...)` for model/browser usage limits and budget protection

## Context Window Strategy

- The worker stores durable tool outputs and user profile state in compact form.
- Each model turn injects a **compact state snapshot** instead of replaying large raw histories.
- Expensive tools are gated with `costGuard` limits to avoid runaway context/cost growth.

## Tech stack

- Cloudflare Agents SDK
- Workers AI
- Cloudflare Workflows
- Durable Objects
- Browser Rendering + Playwright (`@cloudflare/playwright`)
- React + Vite
- Wrangler

## Local development

1. Install dependencies:

```bash
npm install
```

2. Generate types:

```bash
npm run types
```

3. Start the app locally:

```bash
npm run dev
```

4. Open the local URL shown by Vite, usually [http://localhost:5173](http://localhost:5173).

## How to try it

Use prompts like:

- `My name is Akash and I want to improve my system design skills.`
- `I can study for 45 minutes on weekdays and 2 hours on weekends.`
- `Create a seven-day action plan for interview prep.`
- `Remind me tomorrow at 7 PM to review day 1.`
- `Browse https://blog.cloudflare.com and summarize the latest AI announcements.`
- `Browse https://blog.cloudflare.com and include a screenshot preview of the homepage.`

You should see:

- Chat-based input and responses
- Saved durable memory in the top panel
- Workflow status updates while the plan is being generated
- The completed plan rendered back in the UI

## Deploy

```bash
npm run deploy
```

This deploys the Worker and static assets using the `cf-ai-goal-coach` Wrangler name.

## Project structure

```text
src/
  app.tsx       React chat UI and state panels
  client.tsx    React entry point
  server.ts     Agent, tools, durable state, and workflow class
```

## Notes

- No external LLM API key is required because the app uses Workers AI.
- Durable memory is stored in the agent's Durable Object state.
- The workflow implementation is in the same file as the agent for easier review.
- AI prompts used during development are documented in [PROMPTS.md](./PROMPTS.md).
