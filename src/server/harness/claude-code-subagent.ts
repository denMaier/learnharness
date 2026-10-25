import type { AgentEvent, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { HarnessEngine, SubagentRunOptions, SubagentRunResult } from "../../agent/subagents/pi-run.ts";
import type { HarnessSettings } from "../../core/contracts.ts";
import { CLAUDE_CODE_PROVIDER, ClaudeCodeAgent, type QueryFn } from "./claude-code.ts";
import { harnessCwd, harnessMcpUrl } from "./runtime.ts";

/**
 * BACKGROUND AGENTS ON CLAUDE CODE (harness orchestration Phase 4): the
 * runSubagent contract (agent/subagents/pi-run.ts) on the Claude Code
 * driver, for the researcher, demo-builder, extractor and auditor. The
 * agent's own AgentTool registry rides its MCP token (`tools` scope), so the
 * tools run in this process exactly as on the pi path; Claude only decides
 * when to call them.
 *
 * Contract parity with runSubagent:
 * - `prompt` (fresh run) or `messages` (continuation) in, `{newMessages,
 *   text}` out — text is the last assistant message's text;
 * - `maxTurns` caps the run and ends it normally; `shouldStop` is checked
 *   after each batch of tool results (the extractor's stop-after-submit);
 * - onUsage / onAssistantMessage(step) / onToolStart fire per message;
 * - an abort throws AbortError, a model/loop failure throws its message.
 * Background runs are one-shot: no Claude session is kept on disk.
 */

function toolNote(tools: AgentTool<any, any>[]): string {
	const names = tools.map((t) => `\`mcp__learnharness__${t.name}\``).join(", ");
	return [
		"## Tool access in this session",
		"",
		tools.length > 0
			? `Your tools come from the \`learnharness\` MCP server. Wherever these instructions name a tool (for example \`${tools[0]!.name}\`), call it as \`mcp__learnharness__<name>\`. Available: ${names}.`
			: "You have no tools in this session; answer in text.",
	].join("\n");
}

export async function runClaudeCodeSubagent(
	harness: HarnessSettings,
	tools: AgentTool<any, any>[],
	opts: SubagentRunOptions,
	queryFn?: QueryFn,
): Promise<SubagentRunResult> {
	const initial: AgentMessage[] = opts.messages ?? [{ role: "user", content: opts.prompt ?? "", timestamp: Date.now() }];
	const agent = new ClaudeCodeAgent({
		mcpScope: { kind: "tools", label: opts.role, tools: Object.fromEntries(tools.map((t) => [t.name, t])) },
		messages: initial,
		systemPrompt: opts.systemPrompt,
		toolNote: toolNote(tools),
		...(harness.model ? { model: harness.model } : {}),
		maxTurns: opts.maxTurns,
		persistSession: false,
		stopAfterToolResults: (assistant, results) =>
			assistant !== undefined && opts.shouldStop?.(assistant, results) === true,
		mcpUrl: harnessMcpUrl(),
		cwd: harnessCwd("claude-code"),
		...(process.env.LH_CLAUDE_CODE_PATH ? { claudePath: process.env.LH_CLAUDE_CODE_PATH } : {}),
		...(queryFn ? { queryFn } : {}),
	});

	let step = 0;
	let errorMessage: string | undefined;
	let aborted = false;
	agent.subscribe((event: AgentEvent) => {
		if (event.type === "message_end" && (event.message as { role?: string }).role === "assistant") {
			const m = event.message as AssistantMessage;
			if (m.stopReason === "aborted") {
				aborted = true;
				return;
			}
			if (m.stopReason === "error") {
				errorMessage = m.errorMessage ?? "Claude Code failed";
				return;
			}
			step++;
			opts.onUsage?.(m.usage);
			opts.onAssistantMessage?.(m, step);
		} else if (event.type === "tool_execution_start") {
			opts.onToolStart?.(event.toolName, event.args);
		}
	});

	const onAbort = () => agent.abort();
	if (opts.abortSignal?.aborted) onAbort();
	opts.abortSignal?.addEventListener("abort", onAbort, { once: true });
	try {
		await agent.continue();
	} finally {
		opts.abortSignal?.removeEventListener("abort", onAbort);
	}

	if (aborted || opts.abortSignal?.aborted) {
		const err = new Error("aborted");
		err.name = "AbortError";
		throw err;
	}
	if (errorMessage !== undefined) throw new Error(errorMessage);

	const newMessages = agent.state.messages.slice(initial.length);
	const assistants = newMessages.filter((m) => (m as { role?: string }).role === "assistant") as AssistantMessage[];
	const last = assistants.at(-1);
	const text = last ? last.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("") : "";
	return { newMessages, text };
}

/** The HarnessEngine the composition root hands the agent layer. */
export function claudeCodeEngine(harness: HarnessSettings): HarnessEngine {
	return {
		kind: "harness",
		model: { provider: CLAUDE_CODE_PROVIDER, id: harness.model ?? "default" },
		run: (tools, opts) => runClaudeCodeSubagent(harness, tools, opts),
	};
}
