import { NextResponse, type NextRequest } from "next/server";
import { desktopAPIAuthorized } from "./src/server/desktop-access.ts";

/** Applies to every API method, including SSE and spending/settings routes.
 * No public callback or worker bypass: internal jobs call server functions,
 * and any legitimate self-HTTP request must carry the private capability. */
export function proxy(request: NextRequest) {
	// THE ONE EXEMPTION (harness orchestration Phase 1): /api/mcp is called by
	// harness processes (Claude Code, outside agents), never the app window, so
	// it cannot carry the window capability. It authenticates itself: every
	// request needs a 256-bit, scope-bound bearer token that only the server
	// mints (src/server/mcp/tokens.ts). Exact path only — the token-minting
	// route below it stays behind the window capability.
	if (request.nextUrl.pathname === "/api/mcp") return NextResponse.next();
	if (!desktopAPIAuthorized(request.headers)) {
		return NextResponse.json(
			{ error: "Desktop API access requires the trusted LearnHarness window." },
			{ status: 403, headers: { "Cache-Control": "no-store" } },
		);
	}
	return NextResponse.next();
}

export const config = { matcher: "/api/:path*" };
