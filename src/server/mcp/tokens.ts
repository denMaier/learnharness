import { randomBytes } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";

/**
 * MCP SESSION TOKENS (harness orchestration Phase 1, docs/harness-orchestration.md):
 * every harness session the app opens gets its own opaque bearer token,
 * scoped to one chat and one agent role — the token, not the request, decides
 * which tools /api/mcp lists and which chat they act on. The rules are
 * t3code's McpSessionRegistry: memory-only (never persisted, never logged),
 * an idle expiry, a hard maximum lifetime, and revocation when the session
 * that minted it is released.
 *
 * Scopes:
 * - `prober` / `teacher` / `practice`: one chat's turn toolkit (the same
 *   registry the in-process agent gets — chat-handler's toolsForRole);
 * - `graph`: the read-only outside-agent scope (list_sessions /
 *   list_propositions over the learner's knowledge graph), not tied to a
 *   chat;
 * - `tools`: a background agent's registry, carried by the token itself
 *   (researcher, demo-builder, extractor, auditor on a harness).
 *
 * The registry lives on globalThis (the module-instance idiom the turn and
 * wake registries use) so Next's per-entry module copies share one table.
 */

export type McpRole = "prober" | "teacher" | "practice";

export type McpScope =
	| { kind: "turn"; chatId: string; role: McpRole }
	| { kind: "graph" }
	/** A background agent's own registry (Phase 4): the run that minted the
	 *  token hands over exactly the tools it would give a pi loop. */
	| { kind: "tools"; label: string; tools: Record<string, AgentTool<any>> };

interface TokenEntry {
	scope: McpScope;
	createdAt: number;
	lastUsedAt: number;
	idleMs: number;
	maxMs: number;
}

export const MCP_TOKEN_IDLE_MS = 30 * 60_000;
export const MCP_TOKEN_MAX_MS = 12 * 60 * 60_000;

interface LhMcpGlobal {
	__lhMcpTokens?: Map<string, TokenEntry>;
}

function tokens(): Map<string, TokenEntry> {
	const g = globalThis as typeof globalThis & LhMcpGlobal;
	return (g.__lhMcpTokens ??= new Map());
}

/** Test seam: the clock the expiry rules read. */
export const mcpClock = { now: () => Date.now() };

export function mintMcpToken(
	scope: McpScope,
	limits: { idleMs?: number; maxMs?: number } = {},
): string {
	const token = `lhmcp_${randomBytes(32).toString("base64url")}`;
	const now = mcpClock.now();
	tokens().set(token, {
		scope,
		createdAt: now,
		lastUsedAt: now,
		idleMs: limits.idleMs ?? MCP_TOKEN_IDLE_MS,
		maxMs: limits.maxMs ?? MCP_TOKEN_MAX_MS,
	});
	return token;
}

/** The scope a live token grants (touching its idle clock), or null when
 *  the token is unknown, idle-expired, past its maximum, or revoked. An
 *  expired token is deleted on sight. */
export function resolveMcpToken(token: string): McpScope | null {
	const entry = tokens().get(token);
	if (!entry) return null;
	const now = mcpClock.now();
	if (now - entry.lastUsedAt > entry.idleMs || now - entry.createdAt > entry.maxMs) {
		tokens().delete(token);
		return null;
	}
	entry.lastUsedAt = now;
	return entry.scope;
}

export function revokeMcpToken(token: string): void {
	tokens().delete(token);
}

/** Release every token minted for one chat (the chat's harness session
 *  ended, or the chat was deleted). */
export function revokeMcpTokensForChat(chatId: string): void {
	for (const [token, entry] of tokens()) {
		if (entry.scope.kind === "turn" && entry.scope.chatId === chatId) tokens().delete(token);
	}
}
