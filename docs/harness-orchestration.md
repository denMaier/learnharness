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

## Phase 2 preview: the Claude Code driver (design only, not started)

`ClaudeCodeAgent` implements `TurnAgent`:

- **`continue()`** sends the record's unsent tail to the Claude session. The tail is the
  learner's text, or quiz answers rendered as a user message tagged with the toolCallId. It uses
  `resume: nativeSessionId`, or starts fresh with a portable handoff built from the record when
  resume is impossible.
- **SDK messages to pi messages:** assistant text and thinking blocks, and `tool_use`
  `mcp__learnharness__X` → `toolCall X`. MCP tool results → `ToolResultMessage`, except that a
  question tool's posed result is dropped, as `persistTurn` already does. The learner's answer
  becomes that call's native result, exactly as today. Usage comes through in the subscription
  dialect LH already has (no dollars).
- **`steer()`** pushes a user message into the SDK's streaming-input queue.
  **`abort()`** calls `query.interrupt()`.
- **Lockdown:** `tools` allows only `mcp__learnharness__*`, Read/Glob/Grep (cwd = learner files
  dir) and WebSearch/WebFetch. A `canUseTool` hook denies everything else. `systemPrompt` is
  the composed LH prompt in replace mode, not the Claude Code preset.
- **Prober → teacher:** one Claude session per phase. `probe_done` ends the prober session, and
  the teacher session starts with the handoff marker text (already single-sourced as `HANDOFF_TEXT`).
- **Record additions:** `harness: {driver: "claude-code", sessionId, phase}`.
- **Auth:** the user's own `claude auth login`. The health probe must not open a session (t3code lesson).

Later phases are unchanged in spirit: background agents through a `runHarnessSubmitAgent` seam,
then Codex app-server, then ACP. Optionally, MCP Apps so a lesson can render inside t3code.

## Risks

- **Prompt fidelity** under a harness: measure with a golden-lesson eval before trusting it.
- **Shared rate limits** with the user's coding work: background roles default to a cheap model,
  and throttling is surfaced in the UI.
- **Two transcripts** (Claude's and LH's): LH's record stays the product truth. Claude's is
  resumable working memory and can be thrown away; when resume fails, the portable handoff rebuilds it.
