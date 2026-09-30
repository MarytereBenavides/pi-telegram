import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Handler = (...args: any[]) => unknown;
interface ApiCall {
	method: string;
	body: any;
}

const PAIRED_USER_ID = 4242;

let home: string;
let extension: (pi: any) => void;
let calls: ApiCall[];
/** Updates Telegram still holds: getUpdates drops everything below the requested offset, like the real API. */
let serverUpdates: any[];
let wakeLongPoll: (() => void) | undefined;
/** getUpdates call number (across sessions) that first returned each update id in the current session. */
let returnedAtPoll: Map<number, number>;
const realFetch = globalThis.fetch;
/** How many of the next sendMessage calls Telegram rejects (for example a 429). */
let failingSendMessages = 0;
/** Telegram error code for those rejections: 429 is transient, any other 4xx is permanent. */
let failingSendErrorCode = 429;

function textUpdate(updateId: number, text: string) {
	return {
		update_id: updateId,
		message: {
			message_id: updateId * 10,
			date: 0,
			chat: { id: PAIRED_USER_ID, type: "private" },
			from: { id: PAIRED_USER_ID, is_bot: false, first_name: "CEO" },
			text,
		},
	};
}

function createHarness(options: { idle: boolean }) {
	const commands = new Map<string, { handler: Handler }>();
	const events = new Map<string, Handler[]>();
	const sentUserMessages: any[] = [];
	const state = { idle: options.idle };
	const pi = {
		registerTool: () => undefined,
		registerCommand: (name: string, command: { handler: Handler }) => commands.set(name, command),
		on: (event: string, handler: Handler) => events.set(event, [...(events.get(event) ?? []), handler]),
		sendUserMessage: (content: unknown) => sentUserMessages.push(content),
	};
	const ctx = {
		hasUI: false,
		isIdle: () => state.idle,
		abort: () => undefined,
		ui: { theme: { fg: (_color: string, text: string) => text }, setStatus: () => undefined, notify: () => undefined },
	};
	extension(pi);
	const emit = async (event: string, payload: unknown = {}) => {
		for (const handler of events.get(event) ?? []) await handler(payload, ctx);
	};
	return {
		state,
		sentUserMessages,
		emit,
		command: (name: string) => commands.get(name)!.handler([], ctx),
		/** Lets pi pick the head of the queue and finish it with a plain answer. */
		runNextTurn: async (answer: string) => {
			state.idle = true;
			await emit("agent_settled");
			state.idle = false;
			await emit("agent_start");
			await emit("agent_end", {
				messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: answer }] }],
			});
		},
	};
}

function installFetchStub(): void {
	let nextMessageId = 100;
	globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
		const method = String(input).split("/").pop()!;
		const body = JSON.parse(String(init?.body ?? "{}"));
		calls.push({ method, body });
		if (method === "getUpdates") {
			if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
			if (typeof body.offset === "number") serverUpdates = serverUpdates.filter((update) => update.update_id >= body.offset);
			if (serverUpdates.length === 0 && body.timeout > 0) {
				await new Promise<void>((resolve, reject) => {
					wakeLongPoll = resolve;
					init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
				});
			}
			const result = serverUpdates.slice(0, body.limit ?? 100);
			const pollNumber = calls.filter((call) => call.method === "getUpdates").length;
			for (const update of result) if (!returnedAtPoll.has(update.update_id)) returnedAtPoll.set(update.update_id, pollNumber);
			return new Response(JSON.stringify({ ok: true, result }));
		}
		if (method === "sendMessage" && failingSendMessages > 0) {
			failingSendMessages--;
			return new Response(JSON.stringify({ ok: false, error_code: failingSendErrorCode, description: `Error ${failingSendErrorCode}` }));
		}
		return new Response(JSON.stringify({ ok: true, result: { message_id: nextMessageId++ } }));
	}) as typeof fetch;
}

const configPath = () => join(home, ".pi", "agent", "telegram.json");
const readConfig = async () => JSON.parse(await readFile(configPath(), "utf8"));
/** Index into `calls` where the current session started, so a restart ignores the previous session's polls. */
let sessionStart = 0;
const getUpdatesCalls = () => calls.slice(sessionStart).filter((call) => call.method === "getUpdates");
const replies = () => calls.filter((call) => call.method === "sendMessage").map((call) => String(call.body.text));
const promptText = (content: any) => String(content[0].text);

async function waitFor(predicate: () => boolean, label: string, attempts = 200): Promise<void> {
	for (let attempt = 0; attempt < attempts; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail(`timed out waiting for ${label}`);
}

/**
 * Resolves once pollLoop handled the batch holding `lastId`: batches are handled
 * sequentially, so a poll after the one that returned it is the signal.
 */
async function waitForBatch(lastId: number): Promise<void> {
	await waitFor(() => {
		const returnedAt = returnedAtPoll.get(lastId);
		return returnedAt !== undefined && calls.filter((call) => call.method === "getUpdates").length > returnedAt;
	}, `the batch up to update ${lastId} to be processed`);
}

async function deliver(updates: any[]): Promise<void> {
	serverUpdates.push(...updates);
	const wake = wakeLongPoll;
	wakeLongPoll = undefined;
	wake?.();
	await waitForBatch(updates[updates.length - 1].update_id);
}

/** A fresh extension instance on the same config file: what `chief restart` does. */
async function restart(previous: ReturnType<typeof createHarness>, options: { idle: boolean }) {
	await previous.emit("session_shutdown");
	sessionStart = calls.length;
	// Redelivered updates count as new for the next session's completion signal.
	returnedAtPoll = new Map();
	const next = createHarness(options);
	await next.emit("session_start");
	await next.command("telegram-connect");
	return next;
}

before(async () => {
	home = await mkdtemp(join(tmpdir(), "pi-telegram-offset-"));
	process.env.HOME = home;
	extension = (await import("../index.ts")).default;
});

after(async () => {
	globalThis.fetch = realFetch;
	await rm(home, { recursive: true, force: true });
});

beforeEach(async () => {
	calls = [];
	failingSendMessages = 0;
	failingSendErrorCode = 429;
	sessionStart = 0;
	serverUpdates = [];
	returnedAtPoll = new Map();
	wakeLongPoll = undefined;
	installFetchStub();
	await mkdir(join(home, ".pi", "agent"), { recursive: true });
	await writeFile(configPath(), JSON.stringify({ botToken: "123:TEST", allowedUserId: PAIRED_USER_ID, lastUpdateId: 1 }));
});

function albumUpdate(updateId: number, groupId: string, caption?: string) {
	const base = textUpdate(updateId, "");
	const { text: _t, ...rest } = base.message as any;
	return { update_id: updateId, message: { ...rest, media_group_id: groupId, photo: [{ file_id: `f${updateId}`, file_unique_id: `u${updateId}`, width: 1, height: 1 }], ...(caption ? { caption } : {}) } };
}

async function seed(extra: Record<string, unknown>) {
	await writeFile(configPath(), JSON.stringify({ botToken: "123:TEST", allowedUserId: PAIRED_USER_ID, lastUpdateId: 1, ...extra }));
}

describe("mika r4 - interruption notice edges", () => {
	let harness: ReturnType<typeof createHarness>;
	afterEach(async () => {
		failingSendMessages = 0;
		await harness.emit("session_shutdown");
	});

	it("R4-1 album: first item's notice fails once, second succeeds -> first item must still be acknowledged", async () => {
		await seed({ startedUpdateIds: [2, 3] });
		harness = createHarness({ idle: true });
		failingSendMessages = 1; // 429 on update 2's notice only
		await harness.emit("session_start");
		await harness.command("telegram-connect");
		await deliver([albumUpdate(2, "g1", "album"), albumUpdate(3, "g1")]);
		const pollsBefore = calls.filter((c) => c.method === "getUpdates").length;
		await new Promise((r) => setTimeout(r, 4500));
		const pollsAfter = calls.filter((c) => c.method === "getUpdates").length;
		const config = await readConfig();
		console.log("R4-1 notices:", replies().filter((t) => t.includes("se interrumpió")).length,
			"getUpdates in 4.5s:", pollsAfter - pollsBefore, "config:", JSON.stringify({ lastUpdateId: config.lastUpdateId, startedUpdateIds: config.startedUpdateIds, attempts: config.interruptedNoticeAttempts }));
		assert.equal(config.startedUpdateIds, undefined, "update 2 stays started/retained forever");
		assert.equal(config.lastUpdateId, 3, "watermark stuck below the album");
		assert.ok(pollsAfter - pollsBefore < 20, `hot getUpdates loop: ${pollsAfter - pollsBefore} polls in 4.5 s`);
	});

	it("R4-2 attempts persist across restart: 2 failed before restart -> exactly 1 more attempt after", async () => {
		await seed({ startedUpdateIds: [2], interruptedNoticeAttempts: { "2": 2 } });
		harness = createHarness({ idle: true });
		failingSendMessages = 1_000_000;
		await harness.emit("session_start");
		await harness.command("telegram-connect");
		await deliver([textUpdate(2, "reiniciate")]);
		await new Promise((r) => setTimeout(r, 3500));
		const config = await readConfig();
		assert.equal(replies().filter((t) => t.includes("se interrumpió")).length, 1);
		assert.equal(config.startedUpdateIds, undefined);
		assert.equal(config.interruptedNoticeAttempts, undefined);
		assert.equal(config.lastUpdateId, 2);
		assert.equal(harness.sentUserMessages.length, 0, "the interrupted message must never run");
	});

	it("R4-3 5xx is transient: retried, and success on attempt 2 acknowledges and clears the counter", async () => {
		await seed({ startedUpdateIds: [2] });
		harness = createHarness({ idle: true });
		failingSendMessages = 1;
		failingSendErrorCode = 502;
		await harness.emit("session_start");
		await harness.command("telegram-connect");
		await deliver([textUpdate(2, "reiniciate")]);
		assert.deepEqual((await readConfig()).interruptedNoticeAttempts, { "2": 1 });
		await waitFor(() => replies().filter((t) => t.includes("se interrumpió")).length === 2, "second attempt", 600);
		await new Promise((r) => setTimeout(r, 200));
		const config = await readConfig();
		assert.equal(config.interruptedNoticeAttempts, undefined);
		assert.equal(config.startedUpdateIds, undefined);
		assert.equal(config.lastUpdateId, 2);
	});

	it("R4-4 403 (bot blocked) is permanent: one attempt, acknowledged", async () => {
		await seed({ startedUpdateIds: [2] });
		harness = createHarness({ idle: true });
		failingSendMessages = 1_000_000;
		failingSendErrorCode = 403;
		await harness.emit("session_start");
		await harness.command("telegram-connect");
		await deliver([textUpdate(2, "reiniciate")]);
		await new Promise((r) => setTimeout(r, 3500));
		assert.equal(replies().filter((t) => t.includes("se interrumpió")).length, 1);
		assert.equal((await readConfig()).lastUpdateId, 2);
	});

	it("R4-5 /telegram-connect while connected does not reload config under the poll loop", async () => {
		harness = createHarness({ idle: true });
		await harness.emit("session_start");
		await harness.command("telegram-connect");
		await deliver([textUpdate(2, "hola")]);
		await harness.runNextTurn("ok");
		assert.equal((await readConfig()).lastUpdateId, 2);
		// Stale file on disk (another writer); reconnect must not pull it into memory.
		await seed({ lastUpdateId: 1 });
		await harness.command("telegram-connect");
		await deliver([textUpdate(3, "otra")]);
		await harness.runNextTurn("ok");
		const config = await readConfig();
		assert.equal(config.lastUpdateId, 3);
		assert.equal(harness.sentUserMessages.length, 2, "update 2 must not run twice");
	});

	it("R4-6 quote: empty/whitespace, exactly 60 code points, combining/ZWJ emoji", async () => {
		await seed({ startedUpdateIds: [2, 3, 4] });
		harness = createHarness({ idle: true });
		await harness.emit("session_start");
		await harness.command("telegram-connect");
		const sixty = "😀".repeat(60);
		const zwj = "a".repeat(59) + "👨‍👩‍👧";
		await deliver([textUpdate(2, "   \n\t "), textUpdate(3, sixty), textUpdate(4, zwj)]);
		const r = replies();
		console.log("R4-6 notices:", JSON.stringify(r));
		assert.equal(r[0], "Tu mensaje se interrumpió por un reinicio; no lo repetí. Reenvíalo si hace falta.");
		assert.equal(r[1], `Tu mensaje "${sixty}" se interrumpió por un reinicio; no lo repetí. Reenvíalo si hace falta.`);
		for (const n of r) assert.doesNotMatch(n, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
	});
});

describe("mika r4 - deafness after stuck album item", () => {
	let harness: ReturnType<typeof createHarness>;
	afterEach(async () => {
		failingSendMessages = 0;
		await harness.emit("session_shutdown");
	});
	it("R4-7 with update 2 stuck, the 101st update behind it is never fetched", async () => {
		await seed({ startedUpdateIds: [2, 3] });
		harness = createHarness({ idle: true });
		failingSendMessages = 1;
		await harness.emit("session_start");
		await harness.command("telegram-connect");
		await deliver([albumUpdate(2, "g1", "album"), albumUpdate(3, "g1")]);
		await new Promise((r) => setTimeout(r, 3500));
		const stranger = (id: number) => { const u = textUpdate(id, "x") as any; u.message.from = { ...u.message.from, id: 999 }; u.message.chat = { ...u.message.chat, id: 999 }; return u; };
		const strangers = Array.from({ length: 99 }, (_, i) => stranger(4 + i));
		serverUpdates.push(...strangers, textUpdate(103, "mensaje de la CEO"));
		wakeLongPoll?.();
		await new Promise((r) => setTimeout(r, 3000));
		const config = await readConfig();
		console.log("R4-7 ceo ran:", harness.sentUserMessages.length, "lastUpdateId:", config.lastUpdateId, "processed count:", (config.processedUpdateIds ?? []).length);
		assert.equal(harness.sentUserMessages.length, 1, "the CEO message behind the stuck window must run");
	});
});

describe("mika r4 - baseline", () => {
	let harness: ReturnType<typeof createHarness>;
	afterEach(async () => { failingSendMessages = 0; await harness.emit("session_shutdown"); });
	it("R4-1b same album scenario, waiting 6 s without the batch helper", async () => {
		await seed({ startedUpdateIds: [2, 3] });
		harness = createHarness({ idle: true });
		failingSendMessages = 1;
		await harness.emit("session_start");
		await harness.command("telegram-connect");
		serverUpdates.push(albumUpdate(2, "g1", "album"), albumUpdate(3, "g1"));
		wakeLongPoll?.();
		await new Promise((r) => setTimeout(r, 6000));
		const config = await readConfig();
		console.log("R4-1b notices:", replies().filter((t) => t.includes("se interrumpió")).length, "getUpdates:", calls.filter((c) => c.method === "getUpdates").length, "config:", JSON.stringify({ lastUpdateId: config.lastUpdateId, startedUpdateIds: config.startedUpdateIds }));
		assert.equal(config.startedUpdateIds, undefined);
		assert.equal(config.lastUpdateId, 3);
	});
});
