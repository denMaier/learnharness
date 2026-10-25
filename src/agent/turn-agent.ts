import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * THE TURN-AGENT SEAM (harness orchestration, docs/harness-orchestration.md
 * Phase 0): the exact surface of pi's `Agent` that the turn runner
 * (server/pi/ui-stream.ts runPiTurn), the wake/steer registry
 * (server/jobs.ts) and the chat-handler actually use — nothing more.
 *
 * pi's `Agent` satisfies it structurally (no wrapper, no cast), so the BYOK
 * path is unchanged. A harness driver (Claude Code first) implements the
 * same surface: it emits pi AgentEvents and accumulates pi-native messages,
 * so the record, the SSE wire, the client, plan derivation, coverage and
 * extraction never learn which engine ran the turn.
 *
 * The contract every implementation keeps (pinned by
 * tests/turn-agent-contract.test.ts):
 * - `continue()` runs from `state.messages` and resolves after `agent_end`
 *   has been emitted to every subscriber;
 * - `state.messages` is the full transcript afterwards (prior + new),
 *   pi-native, with no leading system message persisted by the caller;
 * - `steer()` queues a message for injection at the next turn boundary of
 *   the live run; `clearSteeringQueue()` drops what was not yet injected;
 * - `abort()` ends the run early — the final assistant message carries
 *   `stopReason: "aborted"` and `agent_end` still fires.
 */
export interface TurnAgent {
	readonly state: {
		messages: AgentMessage[];
		/** Read only for routing decisions (subscription consent). */
		readonly model?: { readonly provider: string };
	};
	subscribe(listener: (event: AgentEvent) => void): () => void;
	continue(): Promise<void>;
	abort(): void;
	steer(message: AgentMessage): void;
	clearSteeringQueue(): void;
}
