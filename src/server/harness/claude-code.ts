import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent, Message, TextContent, ToolCall, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import type { Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { TurnAgent } from "../../agent/turn-agent.ts";
import { QUESTION_TOOLS } from "../../core/pending.ts";
import { toLlmMessages } from "../../core/native-messages.ts";
import { takeMcpDetails } from "../mcp/details.ts";
import { mintMcpToken, revokeMcpToken, type McpRole, type McpScope } from "../mcp/tokens.ts";

/**
 * THE CLAUDE CODE DRIVER (harness orchestration Phase 2,
 * docs/harness-orchestration.md): a TurnAgent that runs the turn on the
 * learner's own Claude Code (Agent SDK, their `claude` login) instead of
 * the in-process pi loop. It emits pi AgentEvents and accumulates
 * pi-native messages, so the turn runner, the record, the SSE wire and the
 * client never learn which engine ran.
 *
 * - TOOLS come from this app's MCP server (/api/mcp) under a per-turn token
 *   scoped to {chatId, role}; every built-in Claude Code tool is disabled
 *   and the learner's own Claude settings / MCP servers are not loaded.
 *   `mcp__learnharness__quiz` maps back to `quiz`, so the transcript holds
 *   exactly the tool calls the pi path would.
 * - THE CONVERSATION lives in Claude's own session (resumed by id). The LH
 *   record stays the product truth; each continue() sends only the
 *   record's tail since the last assistant message. A missing or
 *   other-role session starts fresh with a portable transcript of the
 *   record (the probe→teach switch, a model change, a lost session file).
 * - QUESTIONS (and practice problems) end the turn at the pose, as pi's
 *   `terminate: true` does: a question's posed result never enters the
 *   record (the answer becomes the call's result), a problem's does; either
 *   way the driver stops Claude from carrying on.
 * - STEERS queue locally and are delivered when Claude's current turn
 *   completes (the next boundary this driver can see). A run that ends on
 *   a question leaves them queued — the steer registry re-parks them.
 */

const MCP_SERVER = "learnharness";
/** Tools whose clean result ends the turn (pi's `terminate: true`): the
 *  question tools (result dropped — the answer becomes it) and practice's
 *  `problem` (result kept — submissions arrive as messages). */
const TURN_ENDING_TOOLS: readonly string[] = [...QUESTION_TOOLS, "problem"];
const MCP_PREFIX = `mcp__${MCP_SERVER}__`;
export const CLAUDE_CODE_PROVIDER = "claude-code";

/** The appendix every Claude Code system prompt gets: the composed LH
 *  prompts name tools bare (`quiz`), Claude sees them namespaced. */
export const CLAUDE_CODE_TOOL_NOTE = [
	"## Tool access in this session",
	"",
	`Your tools come from the \`${MCP_SERVER}\` MCP server. Wherever these instructions name a tool (for example \`quiz\`), call it as \`${MCP_PREFIX}<name>\` (for example \`${MCP_PREFIX}quiz\`).`,
	`After you pose a question (${TURN_ENDING_TOOLS.join(", ")}), end your turn immediately: the learner's answer arrives as your next message.`,
].join("\n");

export interface HarnessSessionRef {
	sessionId: string;
	role: McpRole;
}

export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query;

/** Test seam for drivers the handler builds itself (the runner.ts
 *  override idiom): when set, every ClaudeCodeAgent uses it. */
export const claudeCodeQuerySeam: { fn?: QueryFn } = {};

export interface ClaudeCodeAgentOptions {
	/** What the run's MCP token grants: a chat turn's role toolkit, or a
	 *  background agent's own registry. */
	mcpScope: McpScope;
	/** The conversation role, for session resume matching (chat turns only). */
	role?: McpRole;
	messages: AgentMessage[];
	/** The composed LH prompt (composeInstructions, or a sub-agent's prompt). */
	systemPrompt: string;
	/** The system-prompt appendix naming the tools (default: the chat note). */
	toolNote?: string;
	/** Stop after a batch of tool results when this says so (pi's
	 *  finishTurn / shouldStop). Default: the turn-ending tools rule. */
	stopAfterToolResults?: (assistant: AssistantMessage | undefined, results: ToolResultMessage[], posed: boolean) => boolean;
	/** Cap on Claude's agentic turns; reaching it ends the run normally (pi semantics). */
	maxTurns?: number;
	/** Keep Claude's session on disk for resume (chat turns). Default true. */
	persistSession?: boolean;
	/** Claude model alias or id ("sonnet", "opus", "haiku", a full id); absent = Claude Code's default. */
	model?: string;
	/** The chat's current Claude session, if any. */
	session?: HarnessSessionRef;
	/** Called once per run with the session id Claude reports. */
	onSession?: (session: HarnessSessionRef) => void;
	/** Money channel: one call per finalized assistant message. */
	onUsage?: (usage: Usage) => void;
	/** Where /api/mcp is reachable from the Claude Code process. */
	mcpUrl: string;
	/** The Claude Code process cwd (an app-owned scratch dir, never a project). */
	cwd: string;
	/** An installed `claude` to run instead of the SDK's bundled binary. */
	claudePath?: string;
	/** Test seam: the SDK's query(). */
	queryFn?: QueryFn;
}

// ─── Small pieces ────────────────────────────────────────────────────────────

/** An async iterable the driver pushes user messages into (the SDK's
 *  streaming-input mode keeps the session open until it ends). */
class InputQueue<T> implements AsyncIterable<T> {
	private items: T[] = [];
	private waiters: Array<(r: IteratorResult<T>) => void> = [];
	private ended = false;
	push(item: T): void {
		if (this.ended) return;
		const waiter = this.waiters.shift();
		if (waiter) waiter({ value: item, done: false });
		else this.items.push(item);
	}
	end(): void {
		this.ended = true;
		for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
	}
	[Symbol.asyncIterator](): AsyncIterator<T> {
		return {
			next: () => {
				if (this.items.length > 0) return Promise.resolve({ value: this.items.shift()!, done: false });
				if (this.ended) return Promise.resolve({ value: undefined, done: true });
				return new Promise((resolve) => this.waiters.push(resolve));
			},
		};
	}
}

function userInput(text: string): SDKUserMessage {
	return {
		type: "user",
		message: { role: "user", content: text },
		parent_tool_use_id: null,
		origin: { kind: "human" },
	};
}

export function lhToolName(claudeName: string): string {
	return claudeName.startsWith(MCP_PREFIX) ? claudeName.slice(MCP_PREFIX.length) : claudeName;
}

function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

/** Claude's per-message usage → pi Usage. Cost stays 0: the run is billed
 *  to the learner's subscription, and the price table has no claude-code
 *  rows, so read-time pricing renders it as absent, never as $0. */
function usageOf(raw: unknown): Usage {
	const u = (raw ?? {}) as Record<string, unknown>;
	const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
	const usage = emptyUsage();
	usage.input = n("input_tokens");
	usage.output = n("output_tokens");
	usage.cacheRead = n("cache_read_input_tokens");
	usage.cacheWrite = n("cache_creation_input_tokens");
	// Claude Code writes with 1h retention; pi's Usage carries that split
	// as a subset of cacheWrite.
	const creation = (u.cache_creation ?? {}) as Record<string, unknown>;
	if (typeof creation.ephemeral_1h_input_tokens === "number") usage.cacheWrite1h = creation.ephemeral_1h_input_tokens;
	usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	return usage;
}

type Block = TextContent | AssistantMessage["content"][number];

/** One Claude content block → its pi twin (null for block kinds the record
 *  does not carry). */
function blockOf(raw: Record<string, unknown>): Block | null {
	switch (raw.type) {
		case "text":
			return { type: "text", text: String(raw.text ?? "") };
		case "thinking":
			// Signature-only thinking (display omitted) carries nothing the
			// learner can read, and the record never replays to Claude.
			if (!raw.thinking) return null;
			return {
				type: "thinking",
				thinking: String(raw.thinking ?? ""),
				...(typeof raw.signature === "string" && raw.signature ? { thinkingSignature: raw.signature } : {}),
			};
		case "tool_use":
			return {
				type: "toolCall",
				id: String(raw.id),
				name: lhToolName(String(raw.name)),
				arguments: (raw.input ?? {}) as ToolCall["arguments"],
			};
		default:
			return null;
	}
}

function resultContent(raw: unknown): (TextContent | ImageContent)[] {
	if (typeof raw === "string") return [{ type: "text", text: raw }];
	if (!Array.isArray(raw)) return [];
	const out: (TextContent | ImageContent)[] = [];
	for (const part of raw as Array<Record<string, unknown>>) {
		if (part.type === "text") out.push({ type: "text", text: String(part.text ?? "") });
		else if (part.type === "image") {
			const source = (part.source ?? {}) as Record<string, unknown>;
			if (typeof source.data === "string") out.push({ type: "image", data: source.data, mimeType: String(source.media_type ?? "image/png") });
		}
	}
	return out;
}

// ─── Prompt rendering (record → what Claude is sent) ─────────────────────────

function textOfContent(content: Message["content"]): string {
	if (typeof content === "string") return content;
	return content
		.map((c) => (c.type === "text" ? c.text : c.type === "thinking" ? "" : c.type === "toolCall" ? `[called ${c.name} ${JSON.stringify(c.arguments)}]` : ""))
		.filter(Boolean)
		.join("\n");
}

function renderInput(message: Message): string {
	if (message.role === "toolResult") {
		return `[Result of your \`${message.toolName}\` call ${message.toolCallId}]\n${textOfContent(message.content)}`;
	}
	return textOfContent(message.content);
}

function renderTranscript(messages: readonly Message[]): string {
	return messages
		.map((m) => (m.role === "assistant" ? `TEACHER:\n${textOfContent(m.content)}` : m.role === "user" ? `LEARNER:\n${textOfContent(m.content)}` : renderInput(m)))
		.filter((t) => t.trim())
		.join("\n\n");
}

/** What a continue() sends: the tail since the last assistant message
 *  (resumed session), or — fresh session over existing history — the whole
 *  model-facing transcript as a portable handoff, then the tail. */
export function renderTurnPrompt(record: readonly AgentMessage[], resumed: boolean): string {
	const llm = toLlmMessages(record);
	let lastAssistant = -1;
	for (let i = llm.length - 1; i >= 0; i--) {
		if (llm[i]!.role === "assistant") {
			lastAssistant = i;
			break;
		}
	}
	const tail = llm.slice(lastAssistant + 1).map(renderInput).filter((t) => t.trim()).join("\n\n") || "Continue.";
	if (resumed || lastAssistant === -1) return tail;
	return [
		"You are continuing a lesson already in progress. Here is the conversation so far:",
		"",
		renderTranscript(llm.slice(0, lastAssistant + 1)),
		"",
		"---",
		"",
		tail,
	].join("\n");
}

// ─── The driver ──────────────────────────────────────────────────────────────

interface Partial_ {
	id: string;
	streamed: Block[];
	authoritative: Block[];
	usage: Usage;
	stopReason?: string;
	started: boolean;
}

export class ClaudeCodeAgent implements TurnAgent {
	readonly state: { messages: AgentMessage[]; readonly model: { readonly provider: string } };
	private readonly listeners = new Set<(event: AgentEvent) => void>();
	private steering: AgentMessage[] = [];
	private query?: Query;
	private input?: InputQueue<SDKUserMessage>;
	private partial?: Partial_;
	private aborted = false;
	private wake?: () => void;
	private readonly toolNames = new Map<string, string>();

	constructor(private readonly opts: ClaudeCodeAgentOptions) {
		this.state = { messages: [...opts.messages], model: { provider: CLAUDE_CODE_PROVIDER } };
	}

	subscribe(listener: (event: AgentEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	steer(message: AgentMessage): void {
		this.steering.push(message);
	}
	clearSteeringQueue(): void {
		this.steering = [];
	}
	abort(): void {
		if (this.aborted) return;
		this.aborted = true;
		this.query?.interrupt().catch(() => undefined);
		this.wake?.();
	}

	private emit(event: AgentEvent): void {
		for (const listener of [...this.listeners]) listener(event);
	}
	private append(message: AgentMessage): void {
		this.state.messages.push(message);
		this.emit({ type: "message_start", message });
		this.emit({ type: "message_end", message });
	}

	private snapshot(p: Partial_, stopReason: AssistantMessage["stopReason"]): AssistantMessage {
		const content = (p.authoritative.length > 0 ? p.authoritative : p.streamed).filter(
			(b): b is AssistantMessage["content"][number] => b !== undefined,
		);
		return {
			role: "assistant",
			content,
			api: CLAUDE_CODE_PROVIDER,
			provider: CLAUDE_CODE_PROVIDER,
			model: this.opts.model ?? "default",
			responseId: p.id,
			usage: p.usage,
			stopReason,
			timestamp: Date.now(),
		};
	}

	private open(id: string): Partial_ {
		if (this.partial && this.partial.id !== id) this.finalize();
		if (!this.partial) {
			this.partial = { id, streamed: [], authoritative: [], usage: emptyUsage(), started: false };
		}
		const p = this.partial;
		if (!p.started) {
			p.started = true;
			this.emit({ type: "message_start", message: this.snapshot(p, "pending") });
		}
		return p;
	}

	private update(p: Partial_): void {
		const message = this.snapshot(p, "pending");
		this.emit({ type: "message_update", message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "", partial: message } } as AgentEvent);
	}

	/** Close the in-flight assistant message into the transcript. */
	private finalize(stopOverride?: AssistantMessage["stopReason"]): AssistantMessage | undefined {
		const p = this.partial;
		if (!p) return undefined;
		this.partial = undefined;
		const draft = this.snapshot(p, "stop");
		const hasCall = draft.content.some((c) => c.type === "toolCall");
		const stopReason: AssistantMessage["stopReason"] =
			stopOverride ?? (hasCall ? "toolUse" : p.stopReason === "max_tokens" ? "length" : "stop");
		const message: AssistantMessage = { ...draft, stopReason };
		if (!p.started) this.emit({ type: "message_start", message });
		this.state.messages.push(message);
		this.emit({ type: "message_end", message });
		this.opts.onUsage?.(message.usage);
		for (const c of message.content) {
			if (c.type !== "toolCall") continue;
			this.toolNames.set(c.id, c.name);
			this.emit({ type: "tool_execution_start", toolCallId: c.id, toolName: c.name, args: c.arguments });
		}
		return message;
	}

	/** The live preview from the SDK's raw stream events. */
	private onStreamEvent(event: Record<string, unknown>): void {
		if (event.type === "message_start") {
			const msg = (event.message ?? {}) as Record<string, unknown>;
			const p = this.open(String(msg.id ?? `msg_${Date.now()}`));
			p.usage = usageOf(msg.usage);
			return;
		}
		const p = this.partial;
		if (!p) return;
		const index = typeof event.index === "number" ? event.index : 0;
		if (event.type === "content_block_start") {
			const block = blockOf((event.content_block ?? {}) as Record<string, unknown>);
			if (block) p.streamed[index] = block.type === "toolCall" ? { ...block, arguments: {} } : block;
			this.update(p);
		} else if (event.type === "content_block_delta") {
			const delta = (event.delta ?? {}) as Record<string, unknown>;
			const block = p.streamed[index];
			if (!block) return;
			if (delta.type === "text_delta" && block.type === "text") block.text += String(delta.text ?? "");
			else if (delta.type === "thinking_delta" && block.type === "thinking") block.thinking += String(delta.thinking ?? "");
			else if (delta.type === "signature_delta" && block.type === "thinking") block.thinkingSignature = String(delta.signature ?? "");
			else return; // tool-input JSON deltas: the authoritative block carries the input
			this.update(p);
		} else if (event.type === "message_delta") {
			const delta = (event.delta ?? {}) as Record<string, unknown>;
			if (typeof delta.stop_reason === "string") p.stopReason = delta.stop_reason;
			const usage = (event.usage ?? {}) as Record<string, unknown>;
			if (typeof usage.output_tokens === "number") {
				p.usage = { ...p.usage, output: usage.output_tokens, totalTokens: p.usage.totalTokens - p.usage.output + usage.output_tokens };
			}
		}
	}

	/** The SDK's complete assistant message(s) — authoritative content. */
	private onAssistant(message: Record<string, unknown>): void {
		const p = this.open(String(message.id ?? `msg_${Date.now()}`));
		const blocks = ((message.content ?? []) as Array<Record<string, unknown>>).map(blockOf).filter((b): b is Block => b !== null);
		if (blocks.length > 1 || p.authoritative.length === 0) p.authoritative = blocks;
		else {
			for (const block of blocks) {
				const dup = p.authoritative.some((b) => JSON.stringify(b) === JSON.stringify(block));
				if (!dup) p.authoritative.push(block);
			}
		}
		if (message.usage) p.usage = usageOf(message.usage);
		if (typeof message.stop_reason === "string") p.stopReason = message.stop_reason;
		this.update(p);
	}

	/** Tool results Claude Code returns to the model. True = the run should
	 *  stop here (default rule: a turn-ending tool — a question, a practice
	 *  problem — was posed; a sub-agent passes its own rule). */
	private onToolResults(content: unknown): boolean {
		if (!Array.isArray(content)) return false;
		let posed = false;
		const results: ToolResultMessage[] = [];
		for (const part of content as Array<Record<string, unknown>>) {
			if (part.type !== "tool_result") continue;
			if (this.partial) this.finalize();
			const toolCallId = String(part.tool_use_id);
			const toolName = this.toolNames.get(toolCallId) ?? "unknown";
			const isError = part.is_error === true;
			const details = takeMcpDetails(toolCallId);
			const resultParts = resultContent(part.content);
			this.emit({ type: "tool_execution_end", toolCallId, toolName, result: { content: resultParts, details }, isError });
			if (!isError && TURN_ENDING_TOOLS.includes(toolName)) posed = true;
			if (!isError && (QUESTION_TOOLS as readonly string[]).includes(toolName)) continue; // the placeholder never enters the record
			const result: ToolResultMessage = {
				role: "toolResult",
				toolCallId,
				toolName,
				content: resultParts,
				details: (details ?? null) as ToolResultMessage["details"],
				isError,
				timestamp: Date.now(),
			};
			this.append(result);
			results.push(result);
		}
		const stop = this.opts.stopAfterToolResults;
		if (!stop) return posed;
		const lastAssistant = [...this.state.messages].reverse().find((m) => (m as { role?: string }).role === "assistant") as AssistantMessage | undefined;
		return stop(lastAssistant, results, posed);
	}

	private async loadQuery(): Promise<QueryFn> {
		const injected = this.opts.queryFn ?? claudeCodeQuerySeam.fn;
		if (injected) return injected;
		const sdk = await import("@anthropic-ai/claude-agent-sdk");
		return sdk.query as QueryFn;
	}

	async continue(): Promise<void> {
		this.aborted = false;
		this.emit({ type: "agent_start" });
		const { role } = this.opts;
		const resume = role && this.opts.session && this.opts.session.role === role ? this.opts.session.sessionId : undefined;
		const token = mintMcpToken(this.opts.mcpScope);
		const input = (this.input = new InputQueue<SDKUserMessage>());
		input.push(userInput(renderTurnPrompt(this.state.messages, resume !== undefined)));
		let sessionReported = false;
		try {
			const queryFn = await this.loadQuery();
			const q = (this.query = queryFn({
				prompt: input,
				options: {
					cwd: this.opts.cwd,
					...(this.opts.model ? { model: this.opts.model } : {}),
					...(resume ? { resume } : {}),
					...(this.opts.claudePath ? { pathToClaudeCodeExecutable: this.opts.claudePath } : {}),
					systemPrompt: `${this.opts.systemPrompt}\n\n---\n\n${this.opts.toolNote ?? CLAUDE_CODE_TOOL_NOTE}`,
					...(this.opts.maxTurns ? { maxTurns: this.opts.maxTurns } : {}),
					...(this.opts.persistSession === false ? { persistSession: false } : {}),
					tools: [],
					mcpServers: { [MCP_SERVER]: { type: "http", url: this.opts.mcpUrl, headers: { Authorization: `Bearer ${token}` } } },
					strictMcpConfig: true,
					settingSources: [],
					// The gate: only this app's MCP tools run (an allowedTools
					// wildcard would bypass this callback entirely).
					canUseTool: async (name, toolInput) =>
						name.startsWith(MCP_PREFIX)
							? { behavior: "allow", updatedInput: toolInput }
							: { behavior: "deny", message: "That tool is not available in LearnHarness." },
					includePartialMessages: true,
					// The reasoning the transcript shows: summarized thinking
					// (Claude Code's default omits it — signature only).
					thinking: { type: "adaptive", display: "summarized" },
					env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "learnharness" },
				},
			}));
			const iterator = q[Symbol.asyncIterator]();
			const woken = () => new Promise<"woken">((resolve) => (this.wake = () => resolve("woken")));
			for (;;) {
				const next = await Promise.race([iterator.next(), woken()]);
				if (next === "woken" || this.aborted) break;
				if (next.done) break;
				const message = next.value as SDKMessage & Record<string, unknown>;
				if (!sessionReported && role && typeof message.session_id === "string") {
					sessionReported = true;
					this.opts.onSession?.({ sessionId: message.session_id, role });
				}
				if (message.parent_tool_use_id) continue; // sub-agent traffic, not this conversation
				if (message.type === "stream_event") this.onStreamEvent(message.event as unknown as Record<string, unknown>);
				else if (message.type === "assistant") this.onAssistant(message.message as unknown as Record<string, unknown>);
				else if (message.type === "user") {
					const content = (message.message as { content?: unknown } | undefined)?.content;
					if (this.onToolResults(content)) {
						// THE QUESTION STOP: the pose ends the turn — Claude must not
						// carry on talking past a question the learner hasn't seen.
						q.interrupt().catch(() => undefined);
						break;
					}
				} else if (message.type === "result") {
					this.finalize();
					// pi's maxTurns ends a run normally; so does the SDK's cap here.
					if (message.subtype === "error_max_turns") break;
					if (message.subtype !== "success" && !this.aborted) {
						this.appendError(`Claude Code ended the turn: ${String(message.subtype)}`);
						break;
					}
					if (this.steering.length === 0) break;
					const steers = this.steering.splice(0);
					for (const steer of steers) this.append(steer);
					input.push(userInput(renderTurnPrompt(this.state.messages, true)));
				}
			}
		} catch (err) {
			if (!this.aborted) this.appendError(err instanceof Error ? err.message : String(err));
		} finally {
			if (this.aborted) {
				const last = this.finalize("aborted");
				if (!last) this.appendAborted();
			} else {
				this.finalize();
			}
			input.end();
			this.query?.close();
			this.query = undefined;
			this.wake = undefined;
			revokeMcpToken(token);
		}
		this.emit({ type: "agent_end", messages: [...this.state.messages] });
	}

	private appendError(text: string): void {
		this.finalize();
		const message: AssistantMessage = { ...this.snapshot({ id: "error", streamed: [], authoritative: [], usage: emptyUsage(), started: true }, "error"), errorMessage: text };
		this.append(message);
	}

	private appendAborted(): void {
		this.append(this.snapshot({ id: "aborted", streamed: [], authoritative: [], usage: emptyUsage(), started: true }, "aborted"));
	}
}
