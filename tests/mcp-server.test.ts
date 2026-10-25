/**
 * THE LEARNHARNESS MCP SERVER (harness orchestration Phase 1,
 * docs/harness-orchestration.md): a real MCP client (the official SDK)
 * talks to handleMcpRequest through an in-process fetch — no port, no
 * network. Pins: bearer auth, scope-decided tool lists, the in-process
 * tools' validation and results surviving the MCP hop, and token expiry.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { handleMcpRequest } from "../src/server/mcp/handler.ts";
import { mcpClock, mintMcpToken, revokeMcpToken, revokeMcpTokensForChat } from "../src/server/mcp/tokens.ts";
import { chatStore } from "../src/store/chats.ts";
import { PATHS } from "../config.ts";

const URL_ = new URL("http://lh.test/api/mcp");

/** fetch → handleMcpRequest, in process. */
const inProcessFetch = async (input: string | URL | Request, init?: RequestInit) =>
	handleMcpRequest(new Request(input, init));

async function connect(token?: string): Promise<Client> {
	const client = new Client({ name: "lh-test", version: "1" });
	const transport = new StreamableHTTPClientTransport(URL_, {
		fetch: inProcessFetch,
		...(token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : {}),
	});
	await client.connect(transport);
	return client;
}

const QUIZ_INPUT = {
	question: "Which planet is closest to the sun?",
	options: [{ label: "Venus" }, { label: "Mercury" }, { label: "Mars" }],
	correctAnswer: "Mercury",
	explanation: "Mercury is the innermost planet.",
	type: "check",
	nodeId: "planet-order",
};

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

const realNow = mcpClock.now;
afterEach(() => {
	mcpClock.now = realNow;
});

function chatWithTree(title: string) {
	const chat = chatStore.createChat(title);
	createdChats.push(chat.id);
	chatStore.saveTree(chat.id, { nodes: [{ id: "planet-order", title: "Planet order" }], edges: [], version: 1 });
	return chat;
}

const textOf = (result: Record<string, unknown>) =>
	((result.content as Array<{ type: string; text?: string }>) ?? []).map((c) => c.text ?? "").join("\n");

describe("LearnHarness MCP server", () => {
	it("refuses requests without a live bearer token", async () => {
		const res = await handleMcpRequest(
			new Request(URL_, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }),
		);
		assert.equal(res.status, 401);
		assert.match(res.headers.get("www-authenticate") ?? "", /^Bearer/);
		await assert.rejects(connect("lhmcp_not-a-real-token"));
	});

	it("the token's role decides the tool list", async () => {
		const chat = chatWithTree("MCP: roles");
		const prober = await connect(mintMcpToken({ kind: "turn", chatId: chat.id, role: "prober" }));
		const teacher = await connect(mintMcpToken({ kind: "turn", chatId: chat.id, role: "teacher" }));
		const graph = await connect(mintMcpToken({ kind: "graph" }));

		const names = async (c: Client) => (await c.listTools()).tools.map((t) => t.name).sort();
		const proberTools = await names(prober);
		const teacherTools = await names(teacher);
		const graphTools = await names(graph);

		assert.ok(proberTools.includes("probe_done") && !proberTools.includes("plan_init"), `prober: ${proberTools}`);
		assert.ok(teacherTools.includes("plan_init") && teacherTools.includes("quiz") && !teacherTools.includes("probe_done"), `teacher: ${teacherTools}`);
		assert.deepEqual(graphTools, ["list_propositions", "list_sessions"], "the outside-agent scope is read-only graph tools");

		const quiz = (await teacher.listTools()).tools.find((t) => t.name === "quiz")!;
		assert.equal(quiz.inputSchema.type, "object", "the TypeBox parameters ship as the JSON Schema");
		assert.ok("question" in (quiz.inputSchema.properties ?? {}));
		await Promise.all([prober.close(), teacher.close(), graph.close()]);
	});

	it("a valid quiz is posed; an invalid one returns the in-process problem list", async () => {
		const chat = chatWithTree("MCP: quiz");
		const teacher = await connect(mintMcpToken({ kind: "turn", chatId: chat.id, role: "teacher" }));

		const posed = await teacher.callTool({ name: "quiz", arguments: QUIZ_INPUT });
		assert.notEqual(posed.isError, true, textOf(posed));
		assert.match(textOf(posed), /Question posed/);

		const badNode = await teacher.callTool({ name: "quiz", arguments: { ...QUIZ_INPUT, nodeId: "no-such-node" } });
		assert.equal(badNode.isError, true, "the live-tree nodeId check runs over MCP too");
		assert.match(textOf(badNode), /nodeId/);

		const badSchema = await teacher.callTool({ name: "quiz", arguments: { question: 42 } });
		assert.equal(badSchema.isError, true, "schema validation runs before execute");

		const unknown = await teacher.callTool({ name: "rm_rf", arguments: {} });
		assert.equal(unknown.isError, true);
		assert.match(textOf(unknown), /not found/);
		await teacher.close();
	});

	it("tokens expire when idle or past their maximum, and revoke cleanly", async () => {
		const chat = chatWithTree("MCP: expiry");
		let now = 1_000_000;
		mcpClock.now = () => now;

		const idle = mintMcpToken({ kind: "turn", chatId: chat.id, role: "teacher" }, { idleMs: 1_000, maxMs: 60_000 });
		now += 500;
		await (await connect(idle)).close(); // use refreshes the idle clock
		now += 900;
		await (await connect(idle)).close(); // 900ms since last use: still live
		now += 1_001;
		await assert.rejects(connect(idle), "idle past the limit");

		const capped = mintMcpToken({ kind: "turn", chatId: chat.id, role: "teacher" }, { idleMs: 60_000, maxMs: 2_000 });
		now += 2_001;
		await assert.rejects(connect(capped), "past the hard maximum even when recently used");

		const revoked = mintMcpToken({ kind: "graph" });
		revokeMcpToken(revoked);
		await assert.rejects(connect(revoked));

		const forChat = mintMcpToken({ kind: "turn", chatId: chat.id, role: "prober" });
		const other = mintMcpToken({ kind: "graph" });
		revokeMcpTokensForChat(chat.id);
		await assert.rejects(connect(forChat), "chat release revokes its tokens");
		await (await connect(other)).close(); // unrelated scopes survive
	});
});
