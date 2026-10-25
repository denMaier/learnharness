import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../../config.ts";

/**
 * Where a harness process finds this app (docs/harness-orchestration.md).
 * The desktop shell passes PORT to the server child (electron/main.cjs);
 * `next dev` / `next start` without PORT listen on 3000. LH_MCP_URL
 * overrides both (a reverse proxy, a non-default dev port).
 */
export function harnessMcpUrl(env: Record<string, string | undefined> = process.env): string {
	return env.LH_MCP_URL ?? `http://127.0.0.1:${env.PORT ?? "3000"}/api/mcp`;
}

/** The harness process cwd: an app-owned empty directory under the data
 *  dir — never a project checkout, so no repo CLAUDE.md, hooks or
 *  .mcp.json can reach a lesson. Created on first use. */
export function harnessCwd(driver: string): string {
	const dir = path.join(PATHS.data, "harness", driver);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}
