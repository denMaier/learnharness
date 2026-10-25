/**
 * MCP RESULT DETAILS (harness orchestration Phase 2): an in-process tool
 * result carries `details` — the record-facing value the UI renders from
 * (a job ack's jobId, a read's file metadata) — but MCP returns `content`
 * only. Because this app serves its own MCP endpoint, the handler keeps
 * each call's details here, keyed by the harness's native tool-call id
 * (Claude Code: `_meta["claudecode/toolUseId"]`), and the harness driver
 * takes them when it maps the tool result into the record. Memory-only and
 * short-lived: an entry nobody takes expires.
 */

interface DetailsEntry {
	details: unknown;
	at: number;
}

const TTL_MS = 10 * 60_000;

interface LhMcpDetailsGlobal {
	__lhMcpDetails?: Map<string, DetailsEntry>;
}

function table(): Map<string, DetailsEntry> {
	const g = globalThis as typeof globalThis & LhMcpDetailsGlobal;
	return (g.__lhMcpDetails ??= new Map());
}

export function stashMcpDetails(toolCallId: string, details: unknown): void {
	const now = Date.now();
	for (const [id, entry] of table()) if (now - entry.at > TTL_MS) table().delete(id);
	table().set(toolCallId, { details, at: now });
}

/** The call's details (once — the entry is removed), or undefined. */
export function takeMcpDetails(toolCallId: string): unknown {
	const entry = table().get(toolCallId);
	table().delete(toolCallId);
	return entry?.details;
}
