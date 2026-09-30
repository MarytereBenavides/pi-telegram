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

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
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
	sessionStart = 0;
	serverUpdates = [];
	returnedAtPoll = new Map();
	wakeLongPoll = undefined;
	installFetchStub();
	await mkdir(join(home, ".pi", "agent"), { recursive: true });
	await writeFile(configPath(), JSON.stringify({ botToken: "123:TEST", allowedUserId: PAIRED_USER_ID, lastUpdateId: 1 }));
});

describe("offset committed after processing", () => {
	let harness: ReturnType<typeof createHarness>;

	afterEach(async () => {
		await harness.emit("session_shutdown");
	});

	it("keeps queued turns unacknowledged across a restart and processes them afterwards", async () => {
		harness = createHarness({ idle: false });
		await harness.emit("session_start");
		await harness.command("telegram-connect");

		await deliver([textUpdate(2, "primera"), textUpdate(3, "segunda"), textUpdate(4, "tercera")]);
		// Three turns in the queue, none finished: nothing may be acknowledged yet.
		assert.equal((await readConfig()).lastUpdateId, 1);

		await harness.runNextTurn("respuesta a la primera");
		// Only the finished turn moves the watermark; 3 and 4 are still waiting.
		assert.equal((await readConfig()).lastUpdateId, 2);

		harness = await restart(harness, { idle: true });
		await waitForBatch(4);

		// The new session asked Telegram from the watermark and got the waiting turns back.
		assert.ok(getUpdatesCalls().some((call) => call.body.offset === 3), "expected the new session to poll from offset 3");
		assert.equal(harness.sentUserMessages.length, 1);
		assert.match(promptText(harness.sentUserMessages[0]), /segunda/);

		await harness.runNextTurn("respuesta a la segunda");
		await harness.runNextTurn("respuesta a la tercera");
		assert.deepEqual(harness.sentUserMessages.map(promptText).map((text) => text.replace("[telegram] ", "")), ["segunda", "tercera"]);
		const config = await readConfig();
		assert.equal(config.lastUpdateId, 4);
		assert.equal(config.processedUpdateIds, undefined);
	});

	it("does not answer a command twice when Telegram redelivers it after a restart", async () => {
		harness = createHarness({ idle: false });
		await harness.emit("session_start");
		await harness.command("telegram-connect");

		// A turn waits in the queue while a command behind it is answered right away.
		await deliver([textUpdate(2, "primera"), textUpdate(3, "/help")]);
		assert.equal(replies().filter((text) => text.startsWith("Send me a message")).length, 1);
		let config = await readConfig();
		assert.equal(config.lastUpdateId, 1);
		assert.deepEqual(config.processedUpdateIds, [3]);

		harness = await restart(harness, { idle: true });
		await waitForBatch(3);

		// Update 3 came back with 2 but was skipped by its id; only the turn runs.
		assert.equal(replies().filter((text) => text.startsWith("Send me a message")).length, 1);
		assert.equal(harness.sentUserMessages.length, 1);
		assert.match(promptText(harness.sentUserMessages[0]), /primera/);

		await harness.runNextTurn("listo");
		config = await readConfig();
		assert.equal(config.lastUpdateId, 3);
		assert.equal(config.processedUpdateIds, undefined);
	});

	it("acknowledges an aborted turn so a restart does not replay it", async () => {
		harness = createHarness({ idle: false });
		await harness.emit("session_start");
		await harness.command("telegram-connect");

		await deliver([textUpdate(2, "primera")]);
		harness.state.idle = true;
		await harness.emit("agent_settled");
		harness.state.idle = false;
		await harness.emit("agent_start");
		await harness.emit("agent_end", { messages: [{ role: "assistant", stopReason: "aborted", content: [] }] });

		assert.equal((await readConfig()).lastUpdateId, 2);
	});

	it("acknowledges a turn once its answer is delivered, so a restart inside the run does not replay it", async () => {
		harness = createHarness({ idle: true });
		await harness.emit("session_start");
		await harness.command("telegram-connect");

		await deliver([textUpdate(2, "termina la tarea y reiniciate")]);
		assert.equal(harness.sentUserMessages.length, 1);
		await harness.emit("agent_start");
		const answer = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Listo, reinicio ahora." }] };
		await harness.emit("message_start", { message: { ...answer, content: [] } });
		await harness.emit("message_update", { message: answer });
		await harness.emit("message_end", { message: answer });
		assert.ok(replies().includes("Listo, reinicio ahora."));

		// `chief restart` closes the tab before the run reaches agent_end: only session_shutdown runs.
		harness = await restart(harness, { idle: true });
		await harness.emit("agent_settled");

		assert.equal((await readConfig()).lastUpdateId, 2);
		assert.equal(harness.sentUserMessages.length, 0, "the new session must not run the answered message again");
	});

	it("keeps a turn unacknowledged while its only answer so far is cut short before a tool call", async () => {
		harness = createHarness({ idle: true });
		await harness.emit("session_start");
		await harness.command("telegram-connect");

		await deliver([textUpdate(2, "revisa el repo")]);
		await harness.emit("agent_start");
		// Truncated output that still carries a tool call: pi keeps the loop going.
		const partial = {
			role: "assistant",
			stopReason: "length",
			content: [{ type: "text", text: "Reviso el repo" }, { type: "toolCall", id: "t1", name: "bash", arguments: {} }],
		};
		await harness.emit("message_start", { message: { ...partial, content: [] } });
		await harness.emit("message_update", { message: partial });
		await harness.emit("message_end", { message: partial });

		assert.equal((await readConfig()).lastUpdateId, 1);
		assert.ok(!replies().includes("Reviso el repo"), "a truncated tool-call segment is not a final answer");
	});

	it("does not run a message twice when pi stopped while its turn was running", async () => {
		harness = createHarness({ idle: true });
		await harness.emit("session_start");
		await harness.command("telegram-connect");

		await deliver([textUpdate(2, "reiniciate ya, sin responder antes de hacerlo por favor")]);
		// The turn starts running and pi is restarted before any answer reaches Telegram.
		await harness.emit("agent_start");
		harness = await restart(harness, { idle: true });
		await waitForBatch(2);
		await harness.emit("agent_settled");

		assert.equal(harness.sentUserMessages.length, 0, "the interrupted message must not run again");
		assert.ok(
			replies().includes('Tu mensaje "reiniciate ya, sin responder antes de hacerlo por favor" se interrumpió por un reinicio; no lo repetí. Reenvíalo si hace falta.'),
			`expected the interruption notice, got ${JSON.stringify(replies())}`,
		);
		const config = await readConfig();
		assert.equal(config.lastUpdateId, 2);
		assert.equal(config.startedUpdateIds, undefined);
	});

	it("still redelivers a queued turn that had not started when pi stopped", async () => {
		harness = createHarness({ idle: false });
		await harness.emit("session_start");
		await harness.command("telegram-connect");

		await deliver([textUpdate(2, "en fila")]);
		harness = await restart(harness, { idle: true });
		await waitForBatch(2);

		assert.equal(harness.sentUserMessages.length, 1);
		assert.match(promptText(harness.sentUserMessages[0]), /en fila/);
		assert.ok(!replies().some((text) => text.includes("se interrumpió")));
	});

	it("shortens the quoted message to 60 characters in the interruption notice", async () => {
		harness = createHarness({ idle: true });
		await harness.emit("session_start");
		await harness.command("telegram-connect");

		const long = "a".repeat(59) + "bcdef";
		await deliver([textUpdate(2, long)]);
		await harness.emit("agent_start");
		harness = await restart(harness, { idle: true });
		await waitForBatch(2);

		assert.ok(replies().includes(`Tu mensaje "${"a".repeat(59)}b…" se interrumpió por un reinicio; no lo repetí. Reenvíalo si hace falta.`), JSON.stringify(replies()));
	});

	it("acknowledges commands immediately when nothing is queued", async () => {
		harness = createHarness({ idle: true });
		await harness.emit("session_start");
		await harness.command("telegram-connect");

		await deliver([textUpdate(2, "stop")]);

		const config = await readConfig();
		assert.equal(config.lastUpdateId, 2);
		assert.equal(config.processedUpdateIds, undefined);
	});
});
