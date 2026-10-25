/**
 * THE TURN-AGENT CONTRACT (harness orchestration Phase 0,
 * docs/harness-orchestration.md): the chat-handler, the turn runner and the
 * steer registry are typed against src/agent/turn-agent.ts, not pi's Agent.
 * This suite drives handleChatInput end to end with a hand-written,
 * NON-pi TurnAgent — the shape every harness driver (Claude Code first)
 * implements — and pins what the rest of the app relies on:
 *
 *   - a text turn persists the driver's pi-native messages;
 *   - a question pose ends the turn at the call; the answer lands as the
 *     call's tool result and the next turn sees it;
 *   - a learner steer handed to the live run is injected at a boundary and
 *     persisted;
 *   - abort settles the turn with an aborted final message.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxText, fauxToolCall, type AssistantMessage } from "@earendil-works/pi-ai";
import type { TurnAgent } from "../src/agent/turn-agent.ts";
import { handleChatInput } from "../src/server/chat-handler.ts";
import { steerLiveChat } from "../src/server/jobs.ts";
import { abortTurn, runningTurn } from "../src/server/turn-runs.ts";
import { isTurnRunning } from "../src/server/turn-liveness.ts";
import { chatStore } from "../src/store/chats.ts";
import { buildAnswer, normalizeOptions, resolveCorrect, type QuestionData } from "../src/core/question-core.ts";
import { danglingQuestionOf, newUserSteer } from "../src/core/native-messages.ts";
import { PATHS } from "../config.ts";

process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

// ─── A non-pi TurnAgent ──────────────────────────────────────────────────────

type Step = (ctx: { messages: readonly AgentMessage[]; signal: AbortSignal }) => AssistantMessage | Promise<AssistantMessage>;

/** A scripted driver with no pi loop behind it: one step per model turn,
 *  steers drained at boundaries, a question call or an empty steering queue
 *  ends the run. Exactly the obligations a harness driver carries. */
class ScriptedTurnAgent implements TurnAgent {
	readonly state: { messages: AgentMessage[]; readonly model: { readonly provider: string } };
	readonly seen: AgentMessage[][] = [];
	private readonly listeners = new Set<(event: AgentEvent) => void>();
	private steering: AgentMessage[] = [];
	private controller?: AbortController;

	constructor(messages: AgentMessage[], private readonly steps: Step[]) {
		this.state = { messages: [...messages], model: { provider: "openrouter" } };
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
		this.controller?.abort();
	}

	private emit(event: AgentEvent): void {
		for (const listener of [...this.listeners]) listener(event);
	}
	private append(message: AgentMessage): void {
		this.state.messages.push(message);
		this.emit({ type: "message_start", message });
		this.emit({ type: "message_end", message });
	}

	async continue(): Promise<void> {
		const controller = (this.controller = new AbortController());
		this.emit({ type: "agent_start" });
		for (;;) {
			for (const message of this.steering.splice(0)) this.append(message);
			const step = this.steps.shift();
			if (!step) break;
			this.emit({ type: "turn_start" });
			this.seen.push([...this.state.messages]);
			let reply = await step({ messages: this.state.messages, signal: controller.signal });
			if (controller.signal.aborted) reply = { ...reply, stopReason: "aborted" };
			this.append(reply);
			this.emit({ type: "turn_end", message: reply, toolResults: [] });
			const posed = reply.content.some((c) => c.type === "toolCall");
			if (controller.signal.aborted || posed || this.steering.length === 0) break;
		}
		this.emit({ type: "agent_end", messages: [...this.state.messages] });
	}
}

/** The handler's build seam, returning the scripted driver. */
function driver(steps: Step[], built: ScriptedTurnAgent[] = []): NonNullable<Parameters<typeof handleChatInput>[2]> {
	return (opts) => {
		const agent = new ScriptedTurnAgent(opts.messages ?? [], steps);
		built.push(agent);
		return agent;
	};
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const QUIZ_INPUT = {
	question: "Which planet is closest to the sun?",
	options: [{ label: "Venus" }, { label: "Mercury" }, { label: "Mars" }],
	correctAnswer: "Mercury",
	explanation: "Mercury is the innermost planet.",
	type: "check",
	nodeId: "planet-order",
};

function gradedAnswer(values: string[]) {
	const options = normalizeOptions(QUIZ_INPUT.options);
	const qd: QuestionData = {
		id: "call-1",
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

/** Ack, then drain the running turn's wire (the chat-flow drainTurn shape). */
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

const textOf = (m: AgentMessage | undefined) =>
	JSON.stringify((m as { content?: unknown } | undefined)?.content ?? "");

// ─── The contract ────────────────────────────────────────────────────────────

describe("TurnAgent contract — a non-pi driver behind the chat-handler", () => {
	it("a text turn persists the driver's native messages", async () => {
		const chat = configuredChat("Contract: text");
		await runTurn(chat.id, { type: "text", text: "hello" }, driver([() => fauxAssistantMessage([fauxText("Hi there.")])]));

		const saved = chatStore.getChat(chat.id)!;
		assert.deepEqual(saved.messages.map((m) => m.role), ["user", "assistant"]);
		assert.match(textOf(saved.messages[1]), /Hi there\./);
	});

	it("a question pose ends the turn at the call; the answer is the call's result next turn", async () => {
		const chat = configuredChat("Contract: quiz");
		const built: ScriptedTurnAgent[] = [];
		const steps: Step[] = [
			() => fauxAssistantMessage([fauxToolCall("quiz", QUIZ_INPUT, { id: "call-1" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxText("Right — Mercury.")]),
		];

		await runTurn(chat.id, { type: "text", text: "teach me the planets" }, driver(steps, built));
		const posed = chatStore.getChat(chat.id)!;
		assert.equal(posed.messages.length, 2, "the record ends at the unanswered call");
		assert.equal(danglingQuestionOf(posed.messages)?.toolCallId, "call-1");

		await runTurn(chat.id, { type: "answer", toolCallId: "call-1", answer: gradedAnswer(["Mercury"]) }, driver(steps, built));
		const answered = chatStore.getChat(chat.id)!;
		assert.deepEqual(answered.messages.map((m) => m.role), ["user", "assistant", "toolResult", "assistant"]);
		assert.equal(danglingQuestionOf(answered.messages), null);

		const second = built[1]!;
		const lastSeen = second.seen[0]!.at(-1) as { role?: string; toolCallId?: string };
		assert.equal(lastSeen.role, "toolResult", "the driver received the graded answer as the call's result");
		assert.equal(lastSeen.toolCallId, "call-1");
	});

	it("a learner steer handed to the live run is injected at a boundary and persisted", async () => {
		const chat = configuredChat("Contract: steer");
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const steps: Step[] = [
			async () => {
				await gate;
				return fauxAssistantMessage([fauxText("First thought.")]);
			},
			() => fauxAssistantMessage([fauxText("Noted your steer.")]),
		];

		const ack = await handleChatInput(chat.id, { type: "text", text: "start" }, driver(steps));
		assert.equal(ack.status, 200);
		const steer = newUserSteer("actually, go slower", "steer_contract_1");
		assert.equal(steerLiveChat(chat.id, steer), true, "the live TurnAgent accepts the steer");
		release();
		const handle = runningTurn(chat.id);
		if (handle) await new Response(handle.subscribe()).text();
		await waitFor(() => !isTurnRunning(chat.id), "turn settle");

		const saved = chatStore.getChat(chat.id)!;
		const ids = saved.messages.map((m) => (m as { id?: string }).id);
		assert.ok(ids.includes("steer_contract_1"), "the steer persisted in the record");
		assert.match(textOf(saved.messages.at(-1)), /Noted your steer/);
	});

	it("abort settles the turn with an aborted final message", async () => {
		const chat = configuredChat("Contract: abort");
		const steps: Step[] = [
			({ signal }) =>
				new Promise((resolve) => {
					const done = () => resolve(fauxAssistantMessage([fauxText("partial")]));
					if (signal.aborted) done();
					else signal.addEventListener("abort", done, { once: true });
				}),
		];

		const ack = await handleChatInput(chat.id, { type: "text", text: "go" }, driver(steps));
		assert.equal(ack.status, 200);
		await waitFor(() => runningTurn(chat.id) !== undefined, "turn registered");
		assert.deepEqual(abortTurn(chat.id), { ok: true });
		await waitFor(() => !isTurnRunning(chat.id), "turn settle");

		const saved = chatStore.getChat(chat.id)!;
		const last = saved.messages.at(-1) as { role?: string; stopReason?: string };
		assert.equal(last.role, "assistant");
		assert.equal(last.stopReason, "aborted");
	});
});
