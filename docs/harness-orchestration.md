# Harness orchestration — design record

Status: PLANNED, 2026-10-25. Fork of `amosblomqvist/learnharness@b277ee3` (baseline: 2129/2129
tests, `tsc` and `eslint` clean). Reference projects: `pingdotgg/t3code@62eb35b1` (MIT) and
`maria-rcks/t1code@aeb4ce0` (a TUI fork of t3code).

## Decisions (owner, 2026-10-25)

- **Fork-first.** Phases 0–1 land on this fork. Upstreaming is optional later, so every change
  has to stay reviewable on its own terms: small diffs, LH's lint law intact, BYOK path byte-identical.
- **Port t3code's patterns, not its code.** t3code is built on Effect, a second programming
  model on top of LH's plain TypeScript. Read its adapters for the protocol traps, then build
  on the official SDKs (`@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk`).
- **Claude Code is the first harness.**

## The problem

LH *is* a harness. `pi-agent-core` runs in-process and calls model APIs with BYOK keys or three
hand-written subscription bridges. t3code is the opposite: it drives the user's installed
harnesses behind one adapter interface and gives them its own capabilities through an
app-owned MCP server. Goal: keep LH's pedagogy and UI, and let the conversation run on
whichever harness the learner already pays for.

## The key finding: the seam is pi's own vocabulary

Since Waves B/D, LH is pi-native end to end:

- the chat record stores pi `AgentMessage`s (`core/native-messages.ts`, plus an `id` field);
- the SSE wire is pi `AgentEvent`s verbatim (`server/pi/ui-stream.ts`);
- tools are pi `AgentTool`s: TypeBox parameters (that is, JSON Schema) and `execute`.

The turn runner (`runPiTurn`) and the steer registry (`server/jobs.ts`) use exactly five members
of `Agent`: `state.messages`, `subscribe`, `continue`, `abort`, `steer`.

So **there is no new event format to invent**. A harness driver is an object with that same
five-member surface. It emits pi `AgentEvent`s and accumulates pi-native messages. The record,
the wire, the client, plan derivation, coverage and extraction all stay untouched, and so does
the existing pi path.

```
components/  (unchanged)
   │ SSE: pi AgentEvents (unchanged)
src/server/pi/ui-stream.ts runPiTurn(TurnAgent)       ← typed against the interface, not pi's class
src/server/jobs.ts         registerLiveAgent(TurnAgent)
   │
   ├─ pi Agent                     (today, BYOK; satisfies TurnAgent as-is)
   └─ src/harness/claude/agent.ts  ClaudeCodeAgent implements TurnAgent       (Phase 2)
         │ claude-agent-sdk query(): systemPrompt = composed LH prompt, resume = native session id
         │ mcpServers.learnharness = http://127.0.0.1:<port>/api/mcp + scoped bearer token
         ▼
app/api/mcp/route.ts → src/server/mcp/  wraps the SAME AgentTool registries     (Phase 1)
```

## Phase 0: the TurnAgent seam (no behavior change)

1. `src/core`, or the agent layer, gets `TurnAgent`: the five-member interface, with
   `subscribe(fn: (e: AgentEvent) => void)` and `continue(): Promise<void>`. pi's `Agent`
   satisfies it structurally, with no wrapper.
2. `runPiTurn`, `PiTurnSpec.agent`, `registerLiveAgent`/`unregisterLiveAgent` and the handler's
   `TeachingAgent` plumbing take `TurnAgent` instead of `Agent`.
3. ~~Name the turn-engine choice in a `turnAgentFor` factory.~~ Deferred to Phase 2: with a
   single engine it would only add indirection. The factory lands together with the Claude driver.
4. Gate: the full suite passes unchanged and the diff touches only types plus one factory. Add a
   test that a scripted fake `TurnAgent` (not pi) drives `handleChatInput` end to end:
   persist, a question-pose stop, steer delivery, abort. That test is the contract every future
   driver must pass.

## Phase 1: the LH MCP server

1. `app/api/mcp/route.ts`: Streamable HTTP via `@modelcontextprotocol/sdk`, stateless per request.
2. `src/server/mcp/`:
   - `tokens.ts`: a registry of opaque bearer tokens. Each is scoped to
     `{chatId, role: prober|teacher|practice|job, jobId?}`, has an idle and a max lifetime,
     lives in memory only (on `globalThis`, like the other registries), and is revoked at
     session release. These are the rules of t3code's `McpSessionRegistry`.
   - `toolkit.ts`: `agentToolToMcp(tool)`. The name stays verbatim, `parameters` is already JSON
     Schema, and `execute` is called through the existing `prepareArguments`/heal and validation
     path. `content` maps text and image parts to MCP content, and `isError` maps to MCP
     `isError`. The registry for a token comes from the same factories the handler uses
     (`createProberTools`/`createTeacherTools`/`practiceTools`), so there is one tool
     implementation for both transports.
   - Question tools (`quiz`, `ask_user_question`, `problem`) return their posed text (*"…the
     turn ends here"*). Over MCP the "end the turn" part is the **driver's** job, because MCP
     has no `terminate`. Phase 2 interrupts the Claude turn after the result goes out, which is
     the same rule `makeQuestionStopper` enforces in-process.
3. **Outside-agent mode** (a free by-product). A read-only `graph` scope (`list_sessions`,
   `list_propositions`; `find` is auditor-only) behind a token minted by `POST /api/mcp/token`
   (window-gated; a Settings button is still to come), so a learner can point
   their own Claude Code, t1code or t3code at their knowledge graph. Off by default, localhost only.
4. Gate: MCP contract tests list tools per scope; call `quiz` with valid input (posed text) and
   invalid input (`isError` plus the problem list); confirm a token for chat A cannot touch
   chat B; expiry; and confirm the BYOK path is untouched.

### Phase 1 as built (2026-10-25)

- `src/server/mcp/{tokens,handler}.ts`, `app/api/mcp/route.ts`, `app/api/mcp/token/route.ts`.
- The registry comes from `toolsForRole(chatId, role)` in `chat-handler.ts`. The three per-role
  tool contexts were pulled out of the agent-construction branch into named builders, so the
  turn and MCP share one wiring.
- **The proxy has one exemption.** In the desktop app, every `/api/*` call needs the window's
  per-launch capability header, which a harness process cannot have. `/api/mcp` (exact path)
  bypasses that check and authenticates with its own bearer token instead. `/api/mcp/token` does not.
- **Verified live:** the Claude Code 2.1.285 CLI (`claude -p --mcp-config`, HTTP transport,
  bearer header) connects, lists the tools and calls them. It sends
  `_meta["claudecode/toolUseId"]` with its native `toolu_…` id, which the handler uses as the
  `toolCallId`, so job records line up with the transcript's tool calls.

## Phase 2: the Claude Code driver (as built, 2026-10-25)

**Selecting it.** A chat opts in with `PUT /api/chats/:id/settings`
`{"harness": {"driver": "claude-code", "model": "sonnet"}}`. `model` is any Claude Code model
name and is optional. There is no picker UI yet. Harness chats skip the pi-only steps: the
model chain, the provider-key gate, the subscription request cycle and LH compaction (Claude
Code manages its own context). Everything after those gates is shared: appends, liveness,
write-ahead persist, steers, settle and extraction.

**Files.**
- `src/server/harness/claude-code.ts`: `ClaudeCodeAgent implements TurnAgent`.
- `src/server/harness/runtime.ts`: the MCP URL comes from `PORT`, overridable with `LH_MCP_URL`.
  The cwd is `<data>/harness/claude-code`.
- `src/server/mcp/details.ts`: tool `details` travel out of band, keyed by Claude's tool-use id.
- The handler branch is `claudeCodeAgent()` in `chat-handler.ts`.
- The record gets `harnessSession {driver, sessionId, role}`, written only through
  `ChatStore.saveHarnessSession`.

**Mapping.**
- SDK `stream_event`s drive the live `message_update` preview. The SDK's `assistant`
  messages are the authoritative content.
- `tool_use mcp__learnharness__X` becomes `toolCall X`, keeping Claude's `toolu_…` id.
- `tool_result` becomes a `ToolResultMessage` with its MCP-side `details`, plus
  `tool_execution_start`/`end` events (the dock mounts on `end`).
- Usage is stamped `claude-code:<model>` with tokens only. The price table has no such rows,
  so cost renders as absent.

**Turn-ending tools.** `QUESTION_TOOLS` (result dropped, so the answer becomes it) and
`problem` (result kept) interrupt Claude right after the result, which is pi's `terminate: true`.

**Sessions.** A same-role session resumes, and Claude gets only the record's tail since its
last assistant message. A different role or a missing session starts fresh, with the
model-facing transcript (`toLlmMessages`) as a portable handoff. This is the probe→teach switch.

**Lockdown.**
- `tools: []`: no built-ins.
- `strictMcpConfig`, `settingSources: []`: none of the learner's Claude settings, CLAUDE.md or
  MCP servers.
- `canUseTool` allows only `mcp__learnharness__*`. An `allowedTools` wildcard would bypass the
  callback, so there is none.
- A per-run MCP token, revoked when the run ends.

**Live-verified** on Claude Code with Haiku, through the dev server. A full probe ran: five
questions (`probe`, `ask_user_question`, open text), then `probe_done`. The handoff wake
started a new teacher session, which called `plan_init`. Two findings from that run:
- Claude Code omits thinking text by default. Requesting
  `thinking: {type: "adaptive", display: "summarized"}` restores readable reasoning.
- Empty signature-only blocks are dropped.

**Known limits / next.**
- Steers are delivered when Claude's current turn completes, not mid-run.
- There is no model picker UI.
- Background roles (research/demo/visual, extraction, practice generation) still need pi
  model slots. That is Phase 4.
- A desktop package would need the SDK's native binary or `LH_CLAUDE_CODE_PATH` pointing at
  an installed `claude`.
- `next dev -p` alone does not set `PORT`. Set `PORT` (or `LH_MCP_URL`) when the dev port isn't 3000.

**Caching (verified from the live run's usage).**
- Each resumed turn reads the whole earlier prefix from cache and writes only the new messages.
- Claude Code writes with 1-hour retention (`ephemeral_1h`), recorded as `cacheWrite1h`.
- One cold write per new session (the probe→teach switch), per model change, or per pause
  longer than an hour.
- Side effect: Claude Code snapshots the system prompt per session, so an LH prompt-override
  edit mid-lesson takes effect from the next session, not the current one.

## Phase 4: background agents on Claude Code (as built, 2026-10-25)

**Selecting it.** A model slot can name a harness instead of a model:
`PUT /api/settings/models {"strong": {"harness": {...}}, "cheap": {"harness": {"driver": "claude-code", "model": "haiku"}}}`.
- Only `strong` and `cheap` may (`HARNESS_SLOTS`). A harness slot takes no model or thinking level.
- Every role on a harness slot runs on Claude Code. An explicit per-role pi override still
  wins (`resolveRoleHarness`).
- A harness `strong` slot stamps new chats with `settings.harness`, and is the fallback for
  chats with no conversation pin.
- `slotsConfigured` counts harness slots. `vision` still needs a pi model.

**Seam.** `runSubagent` (agent layer) takes a `BackgroundEngine = PiEngine | HarnessEngine`.
A `HarnessEngine` carries its own `run`, built by the composition root
(`claudeCodeEngine`), so the agent layer still never imports server code. The tool registry
rides the run's MCP token (`McpScope` kind `tools`), so the background agent's AgentTools run
in-process exactly as on pi; Claude only chooses the calls. Contract parity with `runSubagent`:
- `maxTurns` ends the run normally;
- `shouldStop` is checked after each tool-result batch (the extractor's stop-after-submit);
- the step and usage callbacks fire per message;
- an abort throws `AbortError`.

Background runs keep no Claude session (`persistSession: false`). Key-presence refusals skip
`claude-code`.

**Covered roles.** researcher, demoBuilder, extractor and auditor, everything on
`runSubagent`/`runSubmitAgent`. visualMaker and pdfReader drive single model calls by hand
and refuse honestly on a harness engine (`piOnly` in `runner.ts`). Validation already keeps
them off one, because `vision` can't be a harness slot.

**Live-verified.** With no API key configured at all: `POST /api/graph/import` of a short
note ran the extractor and auditor on Claude Code (Haiku) in about 20 s, giving 10
propositions and 4 sound chains. A new chat was stamped with the harness. Not live-verified:
researcher (needs a search key) and demo-builder.

## Risks

- **Prompt fidelity** under a harness: measure with a golden-lesson eval before trusting it.
- **Shared rate limits** with the user's coding work: background roles default to a cheap model,
  and throttling is surfaced in the UI.
- **Two transcripts** (Claude's and LH's): LH's record stays the product truth. Claude's is
  resumable working memory and can be thrown away; when resume fails, the portable handoff rebuilds it.
