import { handleMcpRequest } from "@/src/server";

// The LearnHarness MCP endpoint (docs/harness-orchestration.md Phase 1):
// transport only — auth, scope and tools live in src/server/mcp/.
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
	return handleMcpRequest(req);
}

export async function GET(req: Request) {
	return handleMcpRequest(req);
}

export async function DELETE(req: Request) {
	return handleMcpRequest(req);
}
