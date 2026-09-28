import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Handler = (...args: any[]) => unknown;
interface RegisteredTool {
	execute: (toolCallId: string, params: any) => Promise<{ content: Array<{ type: string; text: string }>; details: any }>;
}
interface ApiCall {
	method: string;
	body: any;
}

const PAIRED_USER_ID = 4242;

let home: string;
let extension: (pi: any) => void;
let calls: ApiCall[];
const realFetch = globalThis.fetch;

function createHarness() {
	const tools = new Map<string, RegisteredTool>();
	const commands = new Map<string, { handler: Handler }>();
	const events = new Map<string, Handler[]>();
	const pi = {
		registerTool: (tool: RegisteredTool & { name: string }) => tools.set(tool.name, tool),
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
		tool: (name: string) => {
			const tool = tools.get(name);
			assert.ok(tool, `tool ${name} is registered`);
			return tool;
		},
		command: (name: string) => commands.get(name)!.handler([], ctx),
		emit: async (event: string, payload: unknown = {}) => {
			for (const handler of events.get(event) ?? []) await handler(payload, ctx);
		},
	};
}

/** Telegram Bot API stub: records every call, long polls block until aborted. */
function installFetchStub(): void {
	let nextMessageId = 100;
	globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
		const method = String(input).split("/").pop()!;
		const body = init?.body instanceof FormData ? Object.fromEntries(init.body.entries()) : JSON.parse(String(init?.body ?? "{}"));
		calls.push({ method, body });
		if (method === "getUpdates" && body.timeout > 0) {
			await new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
			});
		}
		const result = method === "getUpdates" ? [] : { message_id: nextMessageId++ };
		return new Response(JSON.stringify({ ok: true, result }));
	}) as typeof fetch;
}

async function writeTelegramConfig(config: Record<string, unknown>): Promise<void> {
	await mkdir(join(home, ".pi", "agent"), { recursive: true });
	await writeFile(join(home, ".pi", "agent", "telegram.json"), JSON.stringify(config));
}

const sentMessages = () => calls.filter((call) => call.method === "sendMessage");

before(async () => {
	home = await mkdtemp(join(tmpdir(), "pi-telegram-test-"));
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
	installFetchStub();
	await writeTelegramConfig({ botToken: "123:TEST", allowedUserId: PAIRED_USER_ID, lastUpdateId: 1 });
});

describe("telegram_send", () => {
	let harness: ReturnType<typeof createHarness>;

	afterEach(async () => {
		await harness.emit("session_shutdown");
	});

	it("sends to the paired chat when no Telegram turn is active", async () => {
		harness = createHarness();
		await harness.emit("session_start");
		await harness.command("telegram-connect");

		const result = await harness.tool("telegram_send").execute("call-1", { text: "Task finished: build is green." });

		assert.deepEqual(sentMessages().map((call) => call.body), [{ chat_id: PAIRED_USER_ID, text: "Task finished: build is green." }]);
		assert.equal(result.details.chatId, PAIRED_USER_ID);
		assert.match(result.content[0]!.text, /Sent 1 Telegram message/);
	});

	it("splits long text with the bridge chunking and sends no reply target", async () => {
		harness = createHarness();
		await harness.emit("session_start");
		await harness.command("telegram-connect");

		const paragraph = "x".repeat(3000);
		await harness.tool("telegram_send").execute("call-1", { text: `${paragraph}\n\n${paragraph}` });

		const sent = sentMessages();
		assert.equal(sent.length, 2);
		for (const call of sent) {
			assert.equal(call.body.text, paragraph);
			assert.equal(call.body.reply_parameters, undefined);
		}
	});

	it("fails explicitly and sends nothing when the bridge is not connected", async () => {
		harness = createHarness();
		await harness.emit("session_start");

		await assert.rejects(
			harness.tool("telegram_send").execute("call-1", { text: "hello" }),
			/Telegram bridge is not connected/,
		);
		assert.equal(sentMessages().length, 0);
	});

	it("fails explicitly when the bridge was never paired", async () => {
		await writeTelegramConfig({ botToken: "123:TEST", lastUpdateId: 1 });
		harness = createHarness();
		await harness.emit("session_start");
		await harness.command("telegram-connect");

		await assert.rejects(harness.tool("telegram_send").execute("call-1", { text: "hello" }), /not paired/);
		assert.equal(sentMessages().length, 0);
	});
});

describe("telegram_attach outside a Telegram turn", () => {
	let harness: ReturnType<typeof createHarness>;

	afterEach(async () => {
		await harness.emit("session_shutdown");
	});

	it("queues files for the next telegram_send instead of throwing", async () => {
		harness = createHarness();
		await harness.emit("session_start");
		await harness.command("telegram-connect");
		const report = join(home, "report.pdf");
		await writeFile(report, "pdf");

		const attached = await harness.tool("telegram_attach").execute("call-1", { paths: [report] });
		assert.match(attached.content[0]!.text, /next telegram_send/);
		assert.equal(calls.filter((call) => call.method === "sendDocument").length, 0);

		await harness.tool("telegram_send").execute("call-2", { text: "Here is the report." });
		const documents = calls.filter((call) => call.method === "sendDocument");
		assert.equal(documents.length, 1);
		assert.equal(documents[0]!.body.chat_id, String(PAIRED_USER_ID));

		// The queue is consumed: a second send carries no file.
		await harness.tool("telegram_send").execute("call-3", { text: "Anything else?" });
		assert.equal(calls.filter((call) => call.method === "sendDocument").length, 1);
	});
});
