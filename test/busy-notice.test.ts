import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
let pendingUpdates: any[];
let sendMessageFails: boolean;
let wakeLongPoll: (() => void) | undefined;
const realFetch = globalThis.fetch;

/** Minimal inbound private message from the paired account. */
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

/**
 * One member of a media group. Captions only, no `photo`/`document`: the point
 * here is the debounced grouping into a single turn, not the file download path.
 */
function mediaGroupUpdate(updateId: number, groupId: string, caption: string) {
	const { message, ...rest } = textUpdate(updateId, "");
	const { text, ...withoutText } = message;
	return { ...rest, message: { ...withoutText, media_group_id: groupId, caption } };
}

function createHarness(options: { idle: boolean }) {
	const commands = new Map<string, { handler: Handler }>();
	const events = new Map<string, Handler[]>();
	const sentUserMessages: unknown[] = [];
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
		ui: { theme: { fg: (_color: string, text: string) => text }, setStatus: () => undefined, notify: () => undefined },
	};
	extension(pi);
	return {
		state,
		sentUserMessages,
		command: (name: string) => commands.get(name)!.handler([], ctx),
		emit: async (event: string, payload: unknown = {}) => {
			for (const handler of events.get(event) ?? []) await handler(payload, ctx);
		},
	};
}

/**
 * Telegram Bot API stub. A long poll parks until `deliver` pushes updates and
 * wakes it, which is what the real API does and what keeps the test
 * deterministic: pushing into `pendingUpdates` alone cannot unblock a request
 * that already decided there was nothing to return.
 */
function installFetchStub(): void {
	let nextMessageId = 100;
	globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
		const method = String(input).split("/").pop()!;
		const body = JSON.parse(String(init?.body ?? "{}"));
		calls.push({ method, body });
		if (method === "getUpdates") {
			if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
			if (pendingUpdates.length === 0 && body.timeout > 0) {
				await new Promise<void>((resolve, reject) => {
					wakeLongPoll = resolve;
					init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
				});
			}
			return new Response(JSON.stringify({ ok: true, result: pendingUpdates.splice(0) }));
		}
		if (method === "sendMessage" && sendMessageFails) {
			return new Response(JSON.stringify({ ok: false, description: "Bad Request: chat not found" }));
		}
		return new Response(JSON.stringify({ ok: true, result: { message_id: nextMessageId++ } }));
	}) as typeof fetch;
}

async function writeTelegramConfig(config: Record<string, unknown>): Promise<void> {
	await mkdir(join(home, ".pi", "agent"), { recursive: true });
	await writeFile(join(home, ".pi", "agent", "telegram.json"), JSON.stringify(config));
}

const sentMessages = () => calls.filter((call) => call.method === "sendMessage");
/** Notice attempts: the stub records the call before deciding whether it fails. */
const busyNotices = () => sentMessages().filter((call) => String(call.body.text).includes("queda en fila"));
const noticeTexts = () => busyNotices().map((call) => String(call.body.text));

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail(`timed out waiting for ${label}`);
}

/** Resolves once pollLoop has consumed the queued batch and gone back to long polling. */
async function deliver(updates: any[]): Promise<void> {
	const before = calls.filter((call) => call.method === "getUpdates").length;
	pendingUpdates.push(...updates);
	const wake = wakeLongPoll;
	wakeLongPoll = undefined;
	wake?.();
	// pollLoop only reopens getUpdates past the last update_id once the whole
	// batch went through handleUpdate, so this offset is the completion signal.
	const lastId = updates[updates.length - 1].update_id;
	await waitFor(
		() => calls.some((call) => call.method === "getUpdates" && call.body.offset > lastId),
		`the batch up to update ${lastId} to be processed (${before} polls before)`,
	);
}

before(async () => {
	home = await mkdtemp(join(tmpdir(), "pi-telegram-busy-"));
	// CONFIG_PATH is resolved from homedir() at import time.
	process.env.HOME = home;
	extension = (await import("../index.ts")).default;
});

after(async () => {
	globalThis.fetch = realFetch;
	await rm(home, { recursive: true, force: true });
});

beforeEach(async () => {
	calls = [];
	pendingUpdates = [];
	sendMessageFails = false;
	wakeLongPoll = undefined;
	installFetchStub();
	await writeTelegramConfig({ botToken: "123:TEST", allowedUserId: PAIRED_USER_ID, lastUpdateId: 1 });
});

describe("busy notice", () => {
	let harness: ReturnType<typeof createHarness>;

	afterEach(async () => {
		await harness.emit("session_shutdown");
	});

	it("answers every queued message with its position, long first and short after", async () => {
		harness = createHarness({ idle: false });
		await harness.emit("session_start");
		await harness.command("telegram-connect");

		await deliver([textUpdate(2, "primera"), textUpdate(3, "segunda"), textUpdate(4, "tercera")]);

		const notices = busyNotices();
		assert.equal(notices.length, 3);
		assert.deepEqual(notices.map((call) => call.body.chat_id), [PAIRED_USER_ID, PAIRED_USER_ID, PAIRED_USER_ID]);
		assert.match(notices[0]!.body.text, /Estoy terminando otra tarea\..*\(n\.º 1\)/);
		assert.equal(notices[1]!.body.text, "Recibido, queda en fila (n.º 2).");
		assert.equal(notices[2]!.body.text, "Recibido, queda en fila (n.º 3).");
		// Each notice replies to its own message, not to the first one of the period.
		assert.deepEqual(notices.map((call) => call.body.reply_parameters.message_id), [20, 30, 40]);
	});

	it("sends one notice per queued turn, not one per photo of a media group", async () => {
		harness = createHarness({ idle: false });
		await harness.emit("session_start");
		await harness.command("telegram-connect");

		await deliver([
			mediaGroupUpdate(2, "grupo-1", "foto uno"),
			mediaGroupUpdate(3, "grupo-1", "foto dos"),
			mediaGroupUpdate(4, "grupo-1", "foto tres"),
		]);
		// The group is debounced, so its single turn lands after the poll returns.
		await waitFor(() => busyNotices().length > 0, "the media group notice");
		await new Promise((resolve) => setTimeout(resolve, 200));

		assert.deepEqual(noticeTexts().length, 1);
		assert.match(busyNotices()[0]!.body.text, /Estoy terminando otra tarea\..*\(n\.º 1\)/);
	});

	it("announces again after the queue drains and the session gets busy once more", async () => {
		harness = createHarness({ idle: false });
		await harness.emit("session_start");
		await harness.command("telegram-connect");

		await deliver([textUpdate(2, "primera")]);
		assert.equal(busyNotices().length, 1);

		// The run ends and the queue is dispatched: the busy period is over.
		harness.state.idle = true;
		await harness.emit("agent_settled");
		await harness.emit("agent_start");
		await harness.emit("agent_end", { messages: [] });
		await harness.emit("agent_settled");

		harness.state.idle = false;
		await deliver([textUpdate(3, "segunda")]);
		assert.equal(busyNotices().length, 2);
		// A new busy period starts over: long copy and position 1 again.
		assert.match(busyNotices()[1]!.body.text, /Estoy terminando otra tarea\..*\(n\.º 1\)/);
	});

	it("stays silent when the message is dispatched immediately", async () => {
		harness = createHarness({ idle: true });
		await harness.emit("session_start");
		await harness.command("telegram-connect");

		await deliver([textUpdate(2, "hola")]);

		assert.equal(busyNotices().length, 0);
		assert.equal(harness.sentUserMessages.length, 1);
	});

	it("stays silent for commands that already answer", async () => {
		harness = createHarness({ idle: false });
		await harness.emit("session_start");
		await harness.command("telegram-connect");

		await deliver([textUpdate(2, "stop")]);

		assert.equal(busyNotices().length, 0);
		assert.deepEqual(sentMessages().map((call) => call.body.text), ["No active turn."]);
	});

	it("still queues the turn when the notice cannot be sent", async () => {
		sendMessageFails = true;
		harness = createHarness({ idle: false });
		await harness.emit("session_start");
		await harness.command("telegram-connect");

		await deliver([textUpdate(2, "primera")]);
		// The notice was attempted and rejected by Telegram.
		assert.equal(busyNotices().length, 1);
		assert.equal(harness.sentUserMessages.length, 0);

		// A failed notice leaves the period unopened: the next one still explains.
		await deliver([textUpdate(3, "segunda")]);
		assert.equal(busyNotices().length, 2);
		assert.match(busyNotices()[1]!.body.text, /Estoy terminando otra tarea\..*\(n\.º 2\)/);

		// The turns survived the failed notices and are dispatched once pi goes idle.
		harness.state.idle = true;
		await harness.emit("agent_settled");
		assert.equal(harness.sentUserMessages.length, 1);
	});
});
