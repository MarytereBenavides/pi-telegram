import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Handler = (...args: any[]) => unknown;

const PAIRED_USER_ID = 4242;

let home: string;
let heartbeatPath: string;
let extension: (pi: any) => void;
let getUpdatesCalls: number;
const realFetch = globalThis.fetch;

function createHarness() {
	const commands = new Map<string, { handler: Handler }>();
	const events = new Map<string, Handler[]>();
	const pi = {
		registerTool: () => undefined,
		registerCommand: (name: string, command: { handler: Handler }) => commands.set(name, command),
		on: (event: string, handler: Handler) => events.set(event, [...(events.get(event) ?? []), handler]),
		sendUserMessage: () => undefined,
	};
	const ctx = {
		hasUI: false,
		isIdle: () => true,
		ui: { theme: { fg: (_color: string, text: string) => text }, setStatus: () => undefined, notify: () => undefined },
	};
	extension(pi);
	return {
		command: (name: string) => commands.get(name)!.handler([], ctx),
		emit: async (event: string, payload: unknown = {}) => {
			for (const handler of events.get(event) ?? []) await handler(payload, ctx);
		},
	};
}

function installFetchStub(): void {
	globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
		const method = String(input).split("/").pop()!;
		const body = JSON.parse(String(init?.body ?? "{}"));
		if (method === "getUpdates") {
			getUpdatesCalls++;
			if (body.timeout > 0) {
				await new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
				});
			}
		}
		return new Response(JSON.stringify({ ok: true, result: method === "getUpdates" ? [] : { message_id: 1 } }));
	}) as typeof fetch;
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail(`timed out waiting for ${label}`);
}

before(async () => {
	home = await mkdtemp(join(tmpdir(), "pi-telegram-heartbeat-"));
	// HEARTBEAT_PATH is resolved from homedir() at import time.
	process.env.HOME = home;
	heartbeatPath = join(home, ".pi", "agent", "telegram-heartbeat.json");
	extension = (await import("../index.ts")).default;
});

after(async () => {
	globalThis.fetch = realFetch;
	await rm(home, { recursive: true, force: true });
});

beforeEach(async () => {
	getUpdatesCalls = 0;
	installFetchStub();
	await mkdir(join(home, ".pi", "agent"), { recursive: true });
	await writeFile(
		join(home, ".pi", "agent", "telegram.json"),
		JSON.stringify({ botToken: "123:TEST", allowedUserId: PAIRED_USER_ID, lastUpdateId: 1 }),
	);
	await rm(heartbeatPath, { force: true });
});

describe("polling heartbeat", () => {
	let harness: ReturnType<typeof createHarness>;

	afterEach(async () => {
		await harness.emit("session_shutdown");
	});

	it("writes the marker while polling and removes it on disconnect", async () => {
		harness = createHarness();
		await harness.emit("session_start");

		// Not written before polling starts: a session that never connects is not the owner.
		assert.equal(existsSync(heartbeatPath), false);

		await harness.command("telegram-connect");
		await waitFor(() => existsSync(heartbeatPath), "the heartbeat file");

		const marker = JSON.parse(await readFile(heartbeatPath, "utf8"));
		assert.equal(marker.pid, process.pid);
		assert.ok(Date.now() - marker.updatedAt < 5000, "updatedAt is recent");
		assert.ok(getUpdatesCalls >= 1, "the heartbeat is written before the long poll");

		await harness.command("telegram-disconnect");
		assert.equal(existsSync(heartbeatPath), false);
	});

	it("removes the marker on session shutdown", async () => {
		harness = createHarness();
		await harness.emit("session_start");
		await harness.command("telegram-connect");
		await waitFor(() => existsSync(heartbeatPath), "the heartbeat file");

		await harness.emit("session_shutdown");
		assert.equal(existsSync(heartbeatPath), false);
	});

	it("leaves a marker owned by another process alone", async () => {
		harness = createHarness();
		await harness.emit("session_start");
		await harness.command("telegram-connect");
		await waitFor(() => existsSync(heartbeatPath), "the heartbeat file");

		// Another pi session took over the bot while this one was still polling.
		await writeFile(heartbeatPath, JSON.stringify({ pid: process.pid + 100000, updatedAt: Date.now() }));
		await harness.command("telegram-disconnect");

		assert.equal(existsSync(heartbeatPath), true);
	});
});
