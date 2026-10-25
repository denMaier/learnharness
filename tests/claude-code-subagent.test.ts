/**
 * BACKGROUND AGENTS ON CLAUDE CODE (harness orchestration Phase 4):
 * runClaudeCodeSubagent against a scripted Agent SDK whose "Claude" calls
 * the agent's tools through a REAL MCP client against /api/mcp (in-process
 * fetch) with the token the run minted — so the background agent's own
 * AgentTool registry is what MCP serves. Plus the runSubagent dispatch and
 * the harness-slot settings rules.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Options, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { runClaudeCodeSubagent, claudeCodeEngine } from "../src/server/harness/claude-code-subagent.ts";
import type { QueryFn } from "../src/server/harness/claude-code.ts";
import { handleMcpRequest } from "../src/server/mcp/handler.ts";
import { resolveMcpToken } from "../src/server/mcp/tokens.ts";
import { runSubagent, type HarnessEngine } from "../src/agent/subagents/pi-run.ts";
import { serverExecute } from "../src/agent/tool-execute.ts";
import { parseModelsSettingsBody } from "../src/server/settings-body.ts";
import { clampModelsLevels } from "../src/server/model-catalog.ts";
import { slotsConfigured } from "../src/core/settings.ts";
import { resolveRoleHarness } from "../src/core/settings-resolution.ts";

// ─── A tiny submit-style agent registry (the extractor shape) ────────────────

const submitted: unknown[] = [];
const submitInput = Type.Object({ items: Type.Array(Type.String()) });
const submitTool: AgentTool<typeof submitInput> = {
	name: "submit",
	label: "submit",
	description: "Submit the findings.",
	parameters: submitInput,
	execute: serverExecute("submit", submitInput, (input) => {
		if (input.items.length === 0) return { error: "items must not be empty" };
		submitted.push(input);
		return { ok: true, count: input.items.length };
	}),
};

// ─── The scripted SDK, with "Claude" calling tools over real MCP ─────────────

interface Run {
	options?: Options;
	inputs: string[];
	interrupts: number;
}

type Turn = (ctx: { mcp: Client; interrupted: () => boolean; untilInterrupt: () => Promise<void> }) => AsyncGenerator<Record<string, unknown>>;

function fakeQuery(turn: Turn, run: Run): QueryFn {
	return ({ prompt, options }) => {
		run.options = options;
		let interrupted = false;
		let wake: (() => void) | undefined;
		async function* gen() {
			const first = await prompt[Symbol.asyncIterator]().next();
			run.inputs.push(String((first.value as SDKUserMessage).message.content));
			const server = options.mcpServers!.learnharness as { url: string; headers: Record<string, string> };
			const mcp = new Client({ name: "fake-claude", version: "1" });
			await mcp.connect(
				new StreamableHTTPClientTransport(new URL("http://lh.test/api/mcp"), {
					fetch: async (input: string | URL | Request, init?: RequestInit) => handleMcpRequest(new Request(input, init)),
					requestInit: { headers: server.headers },
				}),
			);
			try {
				for await (const m of turn({ mcp, interrupted: () => interrupted, untilInterrupt: () => new Promise<void>((r) => (interrupted ? r() : (wake = r))) })) {
					if (interrupted) return;
					yield m;
				}
			} finally {
				await mcp.close();
			}
		}
		const q = gen() as unknown as Query;
		Object.assign(q, {
			interrupt: async () => {
				run.interrupts++;
				interrupted = true;
				wake?.();
			},
			close: () => undefined,
		});
		return q;
	};
}

const assistant = (id: string, content: unknown[]) => ({ type: "assistant", parent_tool_use_id: null, session_id: "s", message: { id, content, usage: { input_tokens: 3, output_tokens: 2 } } });
const toolResult = (id: string, text: string, is_error = false) => ({
	type: "user",
	parent_tool_use_id: null,
	session_id: "s",
	message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }], is_error }] },
});
const result = (subtype = "success") => ({ type: "result", subtype, session_id: "s", parent_tool_use_id: null });

/** Claude calls `submit` through MCP and the tool_result mirrors the real reply. */
async function* callSubmit(mcp: Client, id: string, items: string[]) {
	yield assistant(`m_${id}`, [{ type: "tool_use", id, name: "mcp__learnharness__submit", input: { items } }]);
	const reply = await mcp.callTool({ name: "submit", arguments: { items }, _meta: { "claudecode/toolUseId": id } });
	const text = (reply.content as Array<{ text: string }>).map((c) => c.text).join("");
	yield toolResult(id, text, reply.isError === true);
}

const isCleanSubmit = (_m: unknown, results: Array<{ toolName: string; isError?: boolean; content: Array<{ type: string; text?: string }> }>) =>
	results.some((r) => r.toolName === "submit" && !r.isError && !JSON.stringify(r.content).includes("error"));

// ─── The suite ───────────────────────────────────────────────────────────────

describe("runClaudeCodeSubagent — background agents on Claude Code", () => {
	it("serves the agent's own tools over MCP, retries on an error-back, stops after a clean submit", async () => {
		submitted.length = 0;
		const run: Run = { inputs: [], interrupts: 0 };
		let scopeKind: string | undefined;
		const tools: string[] = [];
		const steps: number[] = [];
		const toolStarts: string[] = [];
		const out = await runClaudeCodeSubagent(
			{ driver: "claude-code", model: "haiku" },
			[submitTool],
			{
				role: "extractor",
				systemPrompt: "EXTRACT",
				prompt: "Extract from this stretch.",
				maxTurns: 4,
				shouldStop: isCleanSubmit as never,
				onAssistantMessage: (_m, step) => steps.push(step),
				onToolStart: (name) => toolStarts.push(name),
			},
			fakeQuery(async function* ({ mcp }) {
				const token = (run.options!.mcpServers!.learnharness as { headers: Record<string, string> }).headers.Authorization!.replace("Bearer ", "");
				scopeKind = resolveMcpToken(token)?.kind;
				tools.push(...(await mcp.listTools()).tools.map((t) => t.name));
				yield* callSubmit(mcp, "toolu_bad", []); // error-back: the model retries
				yield* callSubmit(mcp, "toolu_good", ["a", "b"]);
				yield assistant("m_after", [{ type: "text", text: "SHOULD NOT RUN" }]);
				yield result();
			}, run),
		);
		assert.equal(scopeKind, "tools", "the token carries the agent's registry");
		assert.deepEqual(tools, ["submit"], "MCP lists exactly the agent's tools");
		assert.deepEqual(submitted, [{ items: ["a", "b"] }], "the tool ran in-process, once, with valid input");
		assert.equal(run.interrupts, 1, "a clean submit stops the run (shouldStop)");
		assert.deepEqual(toolStarts, ["submit", "submit"]);
		assert.deepEqual(steps, [1, 2]);
		assert.deepEqual(
			out.newMessages.map((m) => (m as { role: string }).role),
			["assistant", "toolResult", "assistant", "toolResult"],
		);
		assert.equal(out.text, "", "the deliverable is the submit, not prose");
		assert.equal(run.options!.persistSession, false, "background runs keep no session");
		assert.equal(run.options!.maxTurns, 4);
		assert.match(String(run.options!.systemPrompt), /^EXTRACT[\s\S]*mcp__learnharness__submit/);
		assert.equal(run.inputs[0], "Extract from this stretch.");
	});

	it("returns the final text; reaching maxTurns ends normally (pi semantics)", async () => {
		const run: Run = { inputs: [], interrupts: 0 };
		const out = await runClaudeCodeSubagent(
			{ driver: "claude-code" },
			[],
			{ role: "researcher", systemPrompt: "RESEARCH", prompt: "brief", maxTurns: 2 },
			fakeQuery(async function* () {
				yield assistant("m1", [{ type: "text", text: "The brief." }]);
				yield result("error_max_turns");
			}, run),
		);
		assert.equal(out.text, "The brief.");
	});

	it("an abort throws AbortError; a failed run throws its reason", async () => {
		const controller = new AbortController();
		const run: Run = { inputs: [], interrupts: 0 };
		const pending = runClaudeCodeSubagent(
			{ driver: "claude-code" },
			[],
			{ role: "researcher", systemPrompt: "R", prompt: "p", maxTurns: 3, abortSignal: controller.signal },
			fakeQuery(async function* ({ untilInterrupt }) {
				yield assistant("m1", [{ type: "text", text: "working" }]);
				await untilInterrupt();
			}, run),
		);
		setTimeout(() => controller.abort(), 20);
		await assert.rejects(pending, (err: Error) => err.name === "AbortError");

		await assert.rejects(
			runClaudeCodeSubagent(
				{ driver: "claude-code" },
				[],
				{ role: "researcher", systemPrompt: "R", prompt: "p", maxTurns: 3 },
				fakeQuery(async function* () {
					yield result("error_during_execution");
				}, { inputs: [], interrupts: 0 }),
			),
			/Claude Code ended the turn: error_during_execution/,
		);
	});

	it("runSubagent hands a harness engine the whole run; the engine stamps claude-code coordinates", async () => {
		const calls: Array<{ tools: string[]; prompt?: string }> = [];
		const engine: HarnessEngine = {
			kind: "harness",
			model: { provider: "claude-code", id: "haiku" },
			run: async (tools, opts) => {
				calls.push({ tools: tools.map((t) => t.name), prompt: opts.prompt });
				return { newMessages: [], text: "from harness" };
			},
		};
		const out = await runSubagent([submitTool], { role: "extractor", engine, systemPrompt: "S", prompt: "go", maxTurns: 2 });
		assert.equal(out.text, "from harness");
		assert.deepEqual(calls, [{ tools: ["submit"], prompt: "go" }]);
		assert.deepEqual(claudeCodeEngine({ driver: "claude-code", model: "sonnet" }).model, { provider: "claude-code", id: "sonnet" });
	});
});

describe("harness model slots (settings)", () => {
	it("strong/cheap accept a harness; vision and mixed slots refuse", () => {
		assert.deepEqual(parseModelsSettingsBody({ cheap: { harness: { driver: "claude-code", model: "haiku" } } }), {
			ok: true,
			settings: { cheap: { harness: { driver: "claude-code", model: "haiku" } } },
		});
		assert.equal(parseModelsSettingsBody({ vision: { harness: { driver: "claude-code" } } }).ok, false);
		assert.equal(parseModelsSettingsBody({ cheap: { harness: { driver: "claude-code" }, model: { provider: "openrouter", id: "x" } } }).ok, false);
		assert.equal(parseModelsSettingsBody({ strong: { harness: { driver: "codex" } } }).ok, false);
	});

	it("the write clamp keeps harness slots; the first-run gate counts them", () => {
		const models = { strong: { harness: { driver: "claude-code" as const } }, cheap: { harness: { driver: "claude-code" as const, model: "haiku" } } };
		assert.deepEqual(clampModelsLevels(models), models);
		assert.equal(slotsConfigured(models), false, "vision still needs a pi model");
		assert.equal(slotsConfigured({ ...models, vision: { model: { provider: "openrouter", id: "v" } } }), true);
	});

	it("resolveRoleHarness: slot harness applies to its roles; a per-role pi override wins", () => {
		const record = {
			models: { cheap: { harness: { driver: "claude-code" as const, model: "haiku" } }, vision: { model: { provider: "openrouter", id: "v" } } },
			agent: { models: { auditor: { model: { provider: "openrouter", id: "a" } } } },
		};
		assert.deepEqual(resolveRoleHarness("extractor", record as never), { driver: "claude-code", model: "haiku" });
		assert.deepEqual(resolveRoleHarness("researcher", record as never), { driver: "claude-code", model: "haiku" });
		assert.equal(resolveRoleHarness("auditor", record as never), undefined, "explicit pi override");
		assert.equal(resolveRoleHarness("visualMaker", record as never), undefined, "vision tier is pi");
		assert.equal(resolveRoleHarness("teacher", record as never), undefined, "strong slot unset");
	});
});
