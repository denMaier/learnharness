import { MCP_TOKEN_MAX_MS, mintMcpToken } from "@/src/server";

// Outside-agent access (docs/harness-orchestration.md Phase 1): the app
// window mints a read-only `graph` token for an agent the learner runs
// themselves (their own Claude Code, t1code, t3code). This route stays
// behind the window capability (proxy.ts); only /api/mcp itself is exempt.
// Tokens are memory-only: a server restart revokes them.
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
	const token = mintMcpToken({ kind: "graph" });
	return Response.json(
		{ token, url: new URL("/api/mcp", req.url).toString(), scope: "graph", expiresInMs: MCP_TOKEN_MAX_MS },
		{ headers: { "Cache-Control": "no-store" } },
	);
}
