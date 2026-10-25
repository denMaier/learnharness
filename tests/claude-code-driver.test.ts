/**
 * THE CLAUDE CODE DRIVER (harness orchestration Phase 2): ClaudeCodeAgent
 * behind the real chat-handler, with the Agent SDK's query() replaced by a
 * scripted fake that consumes the driver's streaming input and answers with
 * SDK-shaped messages. Pins the mapping (text, thinking, MCP tool names,
 * details, question stop), session resume and the portable handoff, steer
 * delivery, abort, and the lockdown options every real run gets.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { Options, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeCodeAgent, claudeCodeQuerySeam, renderTurnPrompt, type HarnessSessionRef, type QueryFn } from "../src/server/harness/claude-code.ts";
import { stashMcpDetails } from "../src/server/mcp/details.ts";
import { resolveMcpToken } from "../src/server/mcp/tokens.ts";
import { handleChatInput } from "../src/server/chat-handler.ts";
import { steerLiveChat } from "../src/server/jobs.ts";
import { abortTurn, runningTurn } from "../src/server/turn-runs.ts";
import { isTurnRunning } from "../src/server/turn-liveness.ts";
import { chatStore } from "../src/store/chats.ts";
import { buildAnswer, normalizeOptions, resolveCorrect, type QuestionData } from "../src/core/question-core.ts";
import { danglingQuestionOf, newUserSteer } from "../src/core/native-messages.ts";
import { PATHS } from "../config.ts";
import { parseSettingsBody } from "../src/server/settings-body.ts";

process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

// ─── The fake SDK ────────────────────────────────────────────────────────────

type SdkOut = Record<string, unknown>;
/** One Claude turn: receives the user text it was sent, yields SDK messages. */
type Script = (input: string, ctl: { interrupted: () => boolean; untilInterrupt: () => Promise<void> }) => AsyncGenerator<SdkOut> | SdkOut[];

interface FakeRun {
	options?: Options;
	inputs: string[];
	interrupts: number;
	closed: boolean;
}

function fakeQuery(scripts: Script[], run: FakeRun): QueryFn {
	return ({ prompt, options }) => {
		run.options = options;
		let interrupted = false;
		let onInterrupt: (() => void) | undefined;
		const ctl = {
			interrupted: () => interrupted,
			untilInterrupt: () => new Promise<void>((resolve) => (interrupted ? resolve() : (onInterrupt = resolve))),
		};
		async function* gen(): AsyncGenerator<SdkOut> {
			const inputs = prompt[Symbol.asyncIterator]();
			for (const script of scripts) {
				const next = await inputs.next();
				if (next.done) return;
				const text = String((next.value as SDKUserMessage).message.content);
				run.inputs.push(text);
				yield { type: "system", subtype: "init", session_id: "sess-1", parent_tool_use_id: null };
				const out = script(text, ctl);
				if (Symbol.asyncIterator in out) {
					for await (const m of out) {
						if (interrupted) return;
						yield m;
					}
				} else {
					for (const m of out) {
						if (interrupted) return;
						yield m;
					}
				}
			}
		}
		const g = gen() as unknown as Query;
		Object.assign(g, {
			interrupt: async () => {
				run.interrupts++;
				interrupted = true;
				onInterrupt?.();
				return undefined;
			},
			close: () => {
				run.closed = true;
			},
		});
		return g;
	};
}

const sdk = {
	assistant: (id: string, content: unknown[], stop_reason: string | null = null) => ({
		type: "assistant",
		parent_tool_use_id: null,
		session_id: "sess-1",
		message: { id, role: "assistant", content, stop_reason, usage: { input_tokens: 10, output_tokens: 5 } },
	}),
	toolResult: (tool_use_id: string, text: string, is_error = false) => ({
		type: "user",
		parent_tool_use_id: null,
		session_id: "sess-1",
		message: { role: "user", content: [{ type: "tool_result", tool_use_id, content: [{ type: "text", text }], is_error }] },
	}),
	result: (subtype = "success") => ({ type: "result", subtype, session_id: "sess-1", parent_tool_use_id: null }),
	stream: (event: unknown) => ({ type: "stream_event", event, parent_tool_use_id: null, session_id: "sess-1" }),
};

// ─── Fixtures ────────────────────────────────────────────────────────────────

const QUIZ_INPUT = {
	question: "Which planet is closest to the sun?",
	options: [{ label: "Venus" }, { label: "Mercury" }, { label: "Mars" }],
	correctAnswer: "Mercury",
	explanation: "Mercury is the innermost planet.",
	type: "check",
	nodeId: "planet-order",
};

function gradedAnswer(toolCallId: string, values: string[]) {
	const options = normalizeOptions(QUIZ_INPUT.options);
	const qd: QuestionData = {
		id: toolCallId,
		kind: "quiz",
		question: QUIZ_INPUT.question,
		mode: "single-select",
		options,
		correctIndices: resolveCorrect(QUIZ_INPUT.correctAnswer, options).indices,
		explanation: QUIZ_INPUT.explanation,
		createdAt: new Date().toISOString(),
	};
	return buildAnswer(qd, { values });
}

const createdChats: string[] = [];
after(() => {
	for (const id of createdChats) {
		try {
			fs.unlinkSync(path.join(PATHS.chats, `${id}.json`));
		} catch {
			/* already gone */
		}
	}
});

function configuredChat(title: string) {
	const chat = chatStore.createChat(title);
	createdChats.push(chat.id);
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	chatStore.saveTree(chat.id, { nodes: [{ id: "planet-order", title: "Planet order" }], edges: [], version: 1 });
	return chat;
}

interface Built {
	agent?: ClaudeCodeAgent;
	sessions: HarnessSessionRef[];
}

function claudeDriver(
	scripts: Script[],
	run: FakeRun,
	built: Built,
	extra: { session?: HarnessSessionRef; role?: "prober" | "teacher" } = {},
): NonNullable<Parameters<typeof handleChatInput>[2]> {
	return (opts) => {
		const role = extra.role ?? (opts.teaching ? "teacher" : "prober");
		const agent = new ClaudeCodeAgent({
			mcpScope: { kind: "turn", chatId: opts.chatId!, role },
			role,
			messages: opts.messages ?? [],
			systemPrompt: "LH TEST PROMPT",
			model: "haiku",
			...(extra.session ? { session: extra.session } : {}),
			onSession: (s) => built.sessions.push(s),
			mcpUrl: "http://127.0.0.1:9/api/mcp",
			cwd: "/tmp",
			queryFn: fakeQuery(scripts, run),
		});
		built.agent = agent;
		return agent;
	};
}

const newRun = (): FakeRun => ({ inputs: [], interrupts: 0, closed: false });

async function runTurn(chatId: string, input: Parameters<typeof handleChatInput>[1], build: Parameters<typeof handleChatInput>[2]): Promise<void> {
	const ack = await handleChatInput(chatId, input, build);
	assert.equal(ack.status, 200, `expected 200 ack, got ${ack.status}`);
	const handle = runningTurn(chatId);
	if (handle) await new Response(handle.subscribe()).text();
	await waitFor(() => !isTurnRunning(chatId), "turn settle");
}

function waitFor(cond: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const tick = () => {
			if (cond()) return resolve();
			if (Date.now() - started > timeoutMs) return reject(new Error(`timeout waiting for ${what}`));
			setTimeout(tick, 10);
		};
		tick();
	});
}

// ─── The suite ───────────────────────────────────────────────────────────────

describe("ClaudeCodeAgent — Claude Code behind the chat-handler", () => {
	it("a text turn: thinking + text land as one native assistant message; the session is reported", async () => {
		const chat = configuredChat("Claude: text");
		const run = newRun();
		const built: Built = { sessions: [] };
		const events: string[] = [];
		await runTurn(
			chat.id,
			{ type: "text", text: "hello" },
			(opts) => {
				const agent = claudeDriver(
					[
						() => [
							sdk.stream({ type: "message_start", message: { id: "m1", usage: { input_tokens: 10 } } }),
							sdk.stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
							sdk.stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi " } }),
							sdk.assistant("m1", [{ type: "thinking", thinking: "greet", signature: "sig" }, { type: "text", text: "Hi there." }], "end_turn"),
							sdk.result(),
						],
					],
					run,
					built,
				)(opts);
				agent.subscribe((e) => events.push(e.type));
				return agent;
			},
		);

		const saved = chatStore.getChat(chat.id)!;
		assert.deepEqual(saved.messages.map((m) => m.role), ["user", "assistant"]);
		const reply = saved.messages[1] as { content: Array<{ type: string; text?: string; thinking?: string; thinkingSignature?: string }>; provider: string; stopReason: string };
		assert.equal(reply.provider, "claude-code");
		assert.equal(reply.stopReason, "stop");
		assert.deepEqual(reply.content.map((c) => c.type), ["thinking", "text"]);
		assert.equal(reply.content[0]!.thinkingSignature, "sig");
		assert.equal(reply.content[1]!.text, "Hi there.");
		assert.ok(events.includes("message_update"), "the live preview streams");
		assert.deepEqual(built.sessions, [{ sessionId: "sess-1", role: "prober" }]);
		assert.equal(run.inputs[0], "hello", "a fresh chat sends just the learner's text");
	});

	it("runs locked down: no built-ins, no user config, MCP-only tools under a live scoped token", async () => {
		const chat = configuredChat("Claude: lockdown");
		const run = newRun();
		let scopeDuringRun: unknown;
		await runTurn(
			chat.id,
			{ type: "text", text: "hi" },
			claudeDriver(
				[
					() => {
						const header = (run.options!.mcpServers!.learnharness as { headers: Record<string, string> }).headers.Authorization!;
						scopeDuringRun = resolveMcpToken(header.replace("Bearer ", ""));
						return [sdk.assistant("m1", [{ type: "text", text: "ok" }]), sdk.result()];
					},
				],
				run,
				{ sessions: [] },
			),
		);
		const o = run.options!;
		assert.deepEqual(o.tools, [], "every built-in tool is off");
		assert.equal(o.strictMcpConfig, true);
		assert.deepEqual(o.settingSources, [], "the learner's Claude settings and CLAUDE.md are not loaded");
		assert.equal(o.allowedTools, undefined, "no allow rule shadows the canUseTool gate");
		assert.deepEqual(o.thinking, { type: "adaptive", display: "summarized" });
		assert.equal(o.model, "haiku");
		assert.match(String(o.systemPrompt), /^LH TEST PROMPT[\s\S]*mcp__learnharness__quiz/);
		const allow = await o.canUseTool!("mcp__learnharness__quiz", {}, { signal: new AbortController().signal } as never);
		const deny = await o.canUseTool!("Bash", { command: "rm -rf /" }, { signal: new AbortController().signal } as never);
		assert.equal(allow?.behavior, "allow");
		assert.equal(deny?.behavior, "deny");
		assert.deepEqual(scopeDuringRun, { kind: "turn", chatId: chat.id, role: "prober" });
		const header = (o.mcpServers!.learnharness as { headers: Record<string, string> }).headers.Authorization!;
		assert.equal(resolveMcpToken(header.replace("Bearer ", "")), null, "the token dies with the run");
		assert.equal(run.closed, true);
	});

	it("a quiz pose ends the turn at the call; the answer resumes the session as a tagged result", async () => {
		const chat = configuredChat("Claude: quiz");
		const run = newRun();
		const built: Built = { sessions: [] };
		await runTurn(
			chat.id,
			{ type: "text", text: "teach me planets" },
			claudeDriver(
				[
					() => [
						sdk.assistant("m1", [{ type: "tool_use", id: "toolu_q1", name: "mcp__learnharness__quiz", input: QUIZ_INPUT }], "tool_use"),
						sdk.toolResult("toolu_q1", "Question posed — the turn ends here."),
						sdk.assistant("m2", [{ type: "text", text: "SHOULD NEVER BE RECORDED" }]),
						sdk.result(),
					],
				],
				run,
				built,
			),
		);
		const posed = chatStore.getChat(chat.id)!;
		assert.deepEqual(posed.messages.map((m) => m.role), ["user", "assistant"], "the record ends at the unanswered call");
		const pending = danglingQuestionOf(posed.messages);
		assert.equal(pending?.tool, "quiz", "the MCP name maps back to the LH tool");
		assert.equal(pending?.toolCallId, "toolu_q1");
		assert.equal(run.interrupts, 1, "Claude is stopped right after the pose");
		assert.ok(!JSON.stringify(posed.messages).includes("SHOULD NEVER"), "nothing after the pose is kept");

		const run2 = newRun();
		await runTurn(
			chat.id,
			{ type: "answer", toolCallId: "toolu_q1", answer: gradedAnswer("toolu_q1", ["Mercury"]) },
			claudeDriver([() => [sdk.assistant("m3", [{ type: "text", text: "Right — Mercury." }]), sdk.result()]], run2, built, {
				session: built.sessions[0]!,
			}),
		);
		assert.equal(run2.options!.resume, "sess-1", "the same-role session resumes");
		assert.match(run2.inputs[0]!, /^\[Result of your `quiz` call toolu_q1\]/);
		assert.ok(!run2.inputs[0]!.includes("teach me planets"), "a resumed session gets only the tail");
		const answered = chatStore.getChat(chat.id)!;
		assert.deepEqual(answered.messages.map((m) => m.role), ["user", "assistant", "toolResult", "assistant"]);
	});

	it("a practice problem ends the turn but keeps its result (pi's terminate)", async () => {
		const chat = configuredChat("Claude: problem");
		const run = newRun();
		await runTurn(
			chat.id,
			{ type: "text", text: "practice" },
			claudeDriver(
				[
					() => [
						sdk.assistant("m1", [{ type: "tool_use", id: "toolu_p1", name: "mcp__learnharness__problem", input: { statement: "x" } }], "tool_use"),
						sdk.toolResult("toolu_p1", "Problem posed — the turn ends here."),
						sdk.assistant("m2", [{ type: "text", text: "SHOULD NEVER BE RECORDED" }]),
						sdk.result(),
					],
				],
				run,
				{ sessions: [] },
				{ role: "teacher" },
			),
		);
		const saved = chatStore.getChat(chat.id)!;
		assert.deepEqual(saved.messages.map((m) => m.role), ["user", "assistant", "toolResult"]);
		assert.equal((saved.messages[2] as { toolName: string }).toolName, "problem");
		assert.equal(run.interrupts, 1);
	});

	it("a server tool's result carries its details from the MCP side", async () => {
		const chat = configuredChat("Claude: details");
		const run = newRun();
		await runTurn(
			chat.id,
			{ type: "text", text: "research it" },
			claudeDriver(
				[
					() => {
						stashMcpDetails("toolu_r1", { jobId: "job_123", status: "running" });
						return [
							sdk.assistant("m1", [{ type: "tool_use", id: "toolu_r1", name: "mcp__learnharness__list_sessions", input: {} }], "tool_use"),
							sdk.toolResult("toolu_r1", "no sessions"),
							sdk.assistant("m2", [{ type: "text", text: "Nothing yet." }]),
							sdk.result(),
						];
					},
				],
				run,
				{ sessions: [] },
			),
		);
		const saved = chatStore.getChat(chat.id)!;
		assert.deepEqual(saved.messages.map((m) => m.role), ["user", "assistant", "toolResult", "assistant"]);
		const result = saved.messages[2] as { toolName: string; details: unknown; content: unknown };
		assert.equal(result.toolName, "list_sessions");
		assert.deepEqual(result.details, { jobId: "job_123", status: "running" });
		assert.deepEqual(result.content, [{ type: "text", text: "no sessions" }]);
	});

	it("a session from another role is not resumed: the new role gets the transcript as a handoff", async () => {
		const chat = configuredChat("Claude: handoff");
		const run = newRun();
		const built: Built = { sessions: [] };
		await runTurn(chat.id, { type: "text", text: "start" }, claudeDriver([() => [sdk.assistant("m1", [{ type: "text", text: "Probing first." }]), sdk.result()]], run, built));
		const run2 = newRun();
		await runTurn(
			chat.id,
			{ type: "text", text: "go on" },
			claudeDriver([() => [sdk.assistant("m2", [{ type: "text", text: "Teaching now." }]), sdk.result()]], run2, built, {
				session: { sessionId: "sess-prober", role: "prober" },
				role: "teacher",
			}),
		);
		assert.equal(run2.options!.resume, undefined);
		assert.match(run2.inputs[0]!, /continuing a lesson[\s\S]*LEARNER:\nstart[\s\S]*TEACHER:\nProbing first\.[\s\S]*go on$/);
	});

	it("a learner steer is delivered when Claude's turn completes, and persisted", async () => {
		const chat = configuredChat("Claude: steer");
		const run = newRun();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const ack = await handleChatInput(
			chat.id,
			{ type: "text", text: "start" },
			claudeDriver(
				[
					async function* () {
						await gate;
						yield sdk.assistant("m1", [{ type: "text", text: "First thought." }]);
						yield sdk.result();
					},
					(input) => [sdk.assistant("m2", [{ type: "text", text: `Noted: ${input}` }]), sdk.result()],
				],
				run,
				{ sessions: [] },
			),
		);
		assert.equal(ack.status, 200);
		assert.equal(steerLiveChat(chat.id, newUserSteer("go slower", "steer_claude_1")), true);
		release();
		await waitFor(() => !isTurnRunning(chat.id), "turn settle");
		const saved = chatStore.getChat(chat.id)!;
		assert.ok(saved.messages.some((m) => (m as { id?: string }).id === "steer_claude_1"), "the steer persisted");
		assert.equal(run.inputs[1], "go slower", "Claude received the steer as its next input");
		assert.match(JSON.stringify(saved.messages.at(-1)), /Noted: go slower/);
	});

	it("abort interrupts Claude and settles with an aborted final message", async () => {
		const chat = configuredChat("Claude: abort");
		const run = newRun();
		const ack = await handleChatInput(
			chat.id,
			{ type: "text", text: "go" },
			claudeDriver(
				[
					async function* (_input, ctl) {
						yield sdk.stream({ type: "message_start", message: { id: "m1" } });
						yield sdk.stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
						yield sdk.stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } });
						await ctl.untilInterrupt();
					},
				],
				run,
				{ sessions: [] },
			),
		);
		assert.equal(ack.status, 200);
		await waitFor(() => runningTurn(chat.id) !== undefined, "turn registered");
		await new Promise((r) => setTimeout(r, 20));
		assert.deepEqual(abortTurn(chat.id), { ok: true });
		await waitFor(() => !isTurnRunning(chat.id), "turn settle");
		const last = chatStore.getChat(chat.id)!.messages.at(-1) as { role: string; stopReason: string; content: Array<{ text?: string }> };
		assert.equal(last.role, "assistant");
		assert.equal(last.stopReason, "aborted");
		assert.equal(last.content[0]?.text, "partial", "the streamed partial is kept");
		assert.equal(run.interrupts, 1);
	});

	it("the handler's harness branch: no pi model needed; the Claude session persists and resumes", async () => {
		const chat = chatStore.createChat("Claude: handler branch");
		createdChats.push(chat.id);
		chatStore.saveSettings(chat.id, { harness: { driver: "claude-code", model: "haiku" } });
		const run = newRun();
		claudeCodeQuerySeam.fn = fakeQuery([() => [sdk.assistant("m1", [{ type: "text", text: "Hello from Claude." }]), sdk.result()]], run);
		try {
			await runTurn(chat.id, { type: "text", text: "hi" }, undefined);
			const run2 = newRun();
			claudeCodeQuerySeam.fn = fakeQuery([() => [sdk.assistant("m2", [{ type: "text", text: "Again." }]), sdk.result()]], run2);
			await runTurn(chat.id, { type: "text", text: "more" }, undefined);
			assert.equal(run2.options!.resume, "sess-1", "the persisted session resumes on the next turn");
		} finally {
			claudeCodeQuerySeam.fn = undefined;
		}
		const saved = chatStore.getChat(chat.id)!;
		assert.deepEqual(saved.harnessSession, { driver: "claude-code", sessionId: "sess-1", role: "prober" });
		assert.equal(run.options!.model, "haiku");
		assert.match(String(run.options!.systemPrompt), /mcp__learnharness__/);
		assert.ok(String(run.options!.systemPrompt).length > 2000, "the composed prober prompt, not a stub");
		assert.deepEqual(saved.messages.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
		assert.equal(saved.turns?.[0]?.model, "claude-code:haiku", "usage is stamped with the harness model");
	});

	it("settings accept {harness: {driver: claude-code, model?}} and refuse anything else", () => {
		assert.deepEqual(parseSettingsBody({ harness: { driver: "claude-code", model: " sonnet " } }), { ok: true, settings: { harness: { driver: "claude-code", model: "sonnet" } } });
		assert.deepEqual(parseSettingsBody({ harness: { driver: "claude-code" } }), { ok: true, settings: { harness: { driver: "claude-code" } } });
		for (const harness of [{ driver: "codex" }, "claude-code", null, { driver: "claude-code", model: "" }, { driver: "claude-code", model: 4 }]) {
			assert.equal(parseSettingsBody({ harness }).ok, false, JSON.stringify(harness));
		}
	});

	it("renderTurnPrompt: an empty record sends a bare continue", () => {
		assert.equal(renderTurnPrompt([], false), "Continue.");
	});
});
