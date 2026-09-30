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
let serverUpdates: any[];
let wakeLongPoll: (() => void) | undefined;
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

function assistant(text: string, stopReason: string) {
	return { role: "assistant", stopReason, content: [{ type: "text", text }] };
}

function createHarness() {
	const commands = new Map<string, { handler: Handler }>();
	const events = new Map<string, Handler[]>();
	// Idle when the update arrives, so it is dispatched at once instead of queued behind a busy notice.
	const state = { idle: true };
	const pi = {
		registerTool: () => undefined,
		registerCommand: (name: string, command: { handler: Handler }) => commands.set(name, command),
		on: (event: string, handler: Handler) => events.set(event, [...(events.get(event) ?? []), handler]),
		sendUserMessage: () => undefined,
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
		emit,
		command: (name: string) => commands.get(name)!.handler([], ctx),
		/** Lets pi pick the queued Telegram turn and open its run. */
		startTelegramRun: async () => {
			state.idle = false;
			await emit("agent_start");
		},
		/** Streams one assistant message of the current run, the way pi emits it. */
		streamMessage: async (message: ReturnType<typeof assistant>) => {
			await emit("message_start", { message: { ...message, content: [] } });
			await emit("message_update", { message });
			await emit("message_end", { message });
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
			return new Response(JSON.stringify({ ok: true, result: serverUpdates.slice(0, body.limit ?? 100) }));
		}
		return new Response(JSON.stringify({ ok: true, result: { message_id: nextMessageId++ } }));
	}) as typeof fetch;
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail(`timed out waiting for ${label}`);
}

async function deliver(update: any): Promise<void> {
	const pollsBefore = calls.filter((call) => call.method === "getUpdates").length;
	serverUpdates.push(update);
	const wake = wakeLongPoll;
	wakeLongPoll = undefined;
	wake?.();
	// Two more polls: the one that returns the update and the next one, issued after it was handled.
	await waitFor(() => calls.filter((call) => call.method === "getUpdates").length >= pollsBefore + 2, "the update to be handled");
}

/** What the Telegram chat ends up showing: every sent message, with the last edit applied. */
function chatTranscript(): string[] {
	const shown = new Map<number, string>();
	let nextMessageId = 100;
	for (const call of calls) {
		if (call.method === "getUpdates") continue;
		if (call.method === "editMessageText") {
			shown.set(call.body.message_id, String(call.body.text));
			continue;
		}
		const messageId = nextMessageId++;
		if (call.method === "sendMessage") shown.set(messageId, String(call.body.text));
	}
	return [...shown.values()];
}

before(async () => {
	home = await mkdtemp(join(tmpdir(), "pi-telegram-follow-up-"));
	process.env.HOME = home;
	extension = (await import("../index.ts")).default;
});

after(async () => {
	globalThis.fetch = realFetch;
	await rm(home, { recursive: true, force: true });
});

beforeEach(async () => {
	calls = [];
	serverUpdates = [];
	wakeLongPoll = undefined;
	installFetchStub();
	await mkdir(join(home, ".pi", "agent"), { recursive: true });
	await writeFile(join(home, ".pi", "agent", "telegram.json"), JSON.stringify({ botToken: "123:TEST", allowedUserId: PAIRED_USER_ID, lastUpdateId: 1 }));
});

describe("answers inside one Telegram run", () => {
	let harness: ReturnType<typeof createHarness>;

	afterEach(async () => {
		await harness.emit("session_shutdown");
	});

	it("keeps every completed answer when follow-up messages extend the run", async () => {
		harness = createHarness();
		await harness.emit("session_start");
		await harness.command("telegram-connect");
		await deliver(textUpdate(2, "review and allow"));
		await harness.startTelegramRun();

		// The Telegram question gets its answer; then two intercom notices arrive as
		// follow-ups, so pi keeps the same run going and answers each of them.
		const first = assistant("Done: the review approved the change.", "stop");
		const second = assistant("Status: IOR-167 delivered, waiting on QA.", "stop");
		const third = assistant("Mika estimates 40 minutes for the QA.", "stop");
		await harness.streamMessage(first);
		await harness.streamMessage(second);
		await harness.streamMessage(third);
		await harness.emit("agent_end", { messages: [first, second, third] });

		const transcript = chatTranscript();
		assert.ok(transcript.includes(first.content[0].text), `first answer was lost: ${JSON.stringify(transcript)}`);
		assert.ok(transcript.includes(second.content[0].text), `second answer was lost: ${JSON.stringify(transcript)}`);
		assert.ok(transcript.includes(third.content[0].text), `third answer was lost: ${JSON.stringify(transcript)}`);
		// Each answer shows up once: agent_end must not send the last one again.
		assert.deepEqual(transcript, [first, second, third].map((message) => message.content[0].text));
	});

	it("still folds tool-call narration into the single answer of the turn", async () => {
		harness = createHarness();
		await harness.emit("session_start");
		await harness.command("telegram-connect");
		await deliver(textUpdate(2, "check the repo"));
		await harness.startTelegramRun();

		const narration = assistant("Checking the repo.", "toolUse");
		const answer = assistant("The repo is clean.", "stop");
		await harness.streamMessage(narration);
		await harness.streamMessage(answer);
		await harness.emit("agent_end", { messages: [narration, answer] });

		assert.deepEqual(chatTranscript(), ["The repo is clean."]);
	});
});
