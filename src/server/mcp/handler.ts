import { randomUUID } from "node:crypto";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { validateToolArguments, type ToolCall } from "@earendil-works/pi-ai";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { proberGraphTools } from "../../agent/tools/graph.ts";
import { toolsForRole } from "../chat-handler.ts";
import { stores } from "../stores.ts";
import { resolveMcpToken, type McpScope } from "./tokens.ts";

/**
 * THE LEARNHARNESS MCP SERVER (harness orchestration Phase 1,
 * docs/harness-orchestration.md): the app's own tools, served over MCP
 * Streamable HTTP to the harness sessions the app opens (Claude Code first)
 * and, under the read-only `graph` scope, to outside agents.
 *
 * ONE IMPLEMENTATION PER TOOL: the registry is the exact AgentTool record a
 * turn builds (chat-handler's toolsForRole), and a call runs the same
 * three steps pi's loop runs in-process — prepareArguments (the heal),
 * validateToolArguments (the TypeBox schema), execute — with a throw at any
 * step becoming an error result the model retries on, as pi does.
 *
 * Stateless by design: one Server + transport per HTTP request (JSON
 * responses, no MCP session id). Identity and scope ride the bearer token
 * alone (tokens.ts), so nothing here outlives the request.
 *
 * QUESTION TOOLS over MCP (quiz / ask_user_question / problem): the call
 * returns the posed text ("…the turn ends here"). MCP has no `terminate`,
 * so ending the harness turn after a pose is the DRIVER's obligation
 * (Phase 2) — the same rule makeQuestionStopper enforces in-process.
 */

const SERVER_INFO = { name: "learnharness", version: "1" } as const;

/** The tools a scope may see — the scope decides, never the request. */
function toolsForScope(scope: McpScope): Record<string, AgentTool<any>> {
	if (scope.kind === "graph") return proberGraphTools({ chatStore: stores.chatStore, graphStore: stores.graphStore });
	return toolsForRole(scope.chatId, scope.role);
}

/** MCP carries no tool-call id of its own. A harness that forwards its
 *  native call id in `_meta` (key ending in toolUseId / toolCallId) keeps
 *  job records correlated with the transcript; otherwise a fresh id is
 *  minted. Verified 2026-10-25: Claude Code 2.1.285 sends
 *  `_meta["claudecode/toolUseId"]` (its native `toolu_…` id). */
function toolCallIdOf(meta: Record<string, unknown> | undefined): string {
	for (const [key, value] of Object.entries(meta ?? {})) {
		if (typeof value === "string" && value && /tool(Use|Call)Id$/i.test(key)) return value;
	}
	return `mcp_${randomUUID()}`;
}

function errorResult(text: string): CallToolResult {
	return { content: [{ type: "text", text }], isError: true };
}

function toMcpResult(result: AgentToolResult<unknown>): CallToolResult {
	return {
		content: result.content.map((part) =>
			part.type === "image"
				? { type: "image" as const, data: part.data, mimeType: part.mimeType }
				: { type: "text" as const, text: part.text },
		),
		...(result.isError ? { isError: true } : {}),
	};
}

/** Run one call exactly as pi's loop would: heal → validate → execute. */
export async function callAgentTool(
	tools: Record<string, AgentTool<any>>,
	name: string,
	args: unknown,
	toolCallId: string,
	signal?: AbortSignal,
): Promise<CallToolResult> {
	const tool = tools[name];
	if (!tool) return errorResult(`Tool ${name} not found`);
	try {
		const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
		const validated = validateToolArguments(tool, {
			type: "toolCall",
			id: toolCallId,
			name,
			arguments: prepared as ToolCall["arguments"],
		});
		return toMcpResult(await tool.execute(toolCallId, validated, signal));
	} catch (err) {
		return errorResult(err instanceof Error ? err.message : String(err));
	}
}

function unauthorized(): Response {
	return Response.json(
		{ error: "unauthorized" },
		{ status: 401, headers: { "WWW-Authenticate": 'Bearer realm="learnharness-mcp"' } },
	);
}

/** POST/GET/DELETE /api/mcp — the route is a one-line wrapper over this. */
export async function handleMcpRequest(req: Request): Promise<Response> {
	const auth = req.headers.get("authorization") ?? "";
	const match = /^Bearer\s+(\S+)$/i.exec(auth);
	const scope = match ? resolveMcpToken(match[1]!) : null;
	if (!scope) return unauthorized();

	const tools = toolsForScope(scope);
	const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });
	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: Object.values(tools).map((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema: tool.parameters as { type: "object"; [key: string]: unknown },
		})),
	}));
	server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
		callAgentTool(tools, request.params.name, request.params.arguments ?? {}, toolCallIdOf(request.params._meta), extra.signal),
	);

	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	});
	await server.connect(transport);
	try {
		return await transport.handleRequest(req);
	} finally {
		await server.close();
	}
}
