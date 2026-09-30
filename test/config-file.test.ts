import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Handler = (...args: any[]) => unknown;
interface ApiCall {
	method: string;
	body: any;
}

const PAIRED_USER_ID = 4242;
const GOOD_CONFIG = { botToken: "123:TEST", allowedUserId: PAIRED_USER_ID, lastUpdateId: 7 };
const DAMAGED = '{\n\t"botToken": "123:TEST",\n\t"allowedUs';

let home: string;
let agentDir: string;
let module: typeof import("../index.ts");
let calls: ApiCall[];
let wakeLongPoll: (() => void) | undefined;
let savedAutoconnect: string | undefined;
const realFetch = globalThis.fetch;
const realConsoleError = console.error;
let loggedErrors: string[];

const configPath = () => join(agentDir, "telegram.json");
const backupPath = () => `${configPath()}.bak`;
const fileMode = async (path: string) => (await stat(path)).mode & 0o777;
const sentTexts = () => calls.filter((call) => call.method === "sendMessage").map((call) => String(call.body.text));

function createHarness() {
	const events = new Map<string, Handler[]>();
	const pi = {
		registerTool: () => undefined,
		registerCommand: () => undefined,
		on: (event: string, handler: Handler) => events.set(event, [...(events.get(event) ?? []), handler]),
		sendUserMessage: () => undefined,
	};
	const ctx = {
		hasUI: false,
		isIdle: () => true,
		abort: () => undefined,
		ui: { theme: { fg: (_color: string, text: string) => text }, setStatus: () => undefined, notify: () => undefined },
	};
	module.default(pi as any);
	return {
		emit: async (event: string, payload: unknown = {}) => {
			for (const handler of events.get(event) ?? []) await handler(payload, ctx);
		},
	};
}

function installFetchStub(): void {
	globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
		const method = String(input).split("/").pop()!;
		const body = JSON.parse(String(init?.body ?? "{}"));
		calls.push({ method, body });
		if (method === "getUpdates") {
			if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
			await new Promise<void>((resolve, reject) => {
				wakeLongPoll = resolve;
				init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
			});
			return new Response(JSON.stringify({ ok: true, result: [] }));
		}
		return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
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
	home = await mkdtemp(join(tmpdir(), "pi-telegram-config-"));
	process.env.HOME = home;
	agentDir = join(home, ".pi", "agent");
	module = await import("../index.ts");
});

after(async () => {
	globalThis.fetch = realFetch;
	await rm(home, { recursive: true, force: true });
});

beforeEach(async () => {
	calls = [];
	wakeLongPoll = undefined;
	loggedErrors = [];
	console.error = (...args: unknown[]) => void loggedErrors.push(args.map(String).join(" "));
	installFetchStub();
	await rm(agentDir, { recursive: true, force: true });
	await mkdir(agentDir, { recursive: true });
	savedAutoconnect = process.env.PI_TELEGRAM_AUTOCONNECT;
	// The Chief's environment: session_start connects on its own.
	process.env.PI_TELEGRAM_AUTOCONNECT = "1";
});

afterEach(() => {
	console.error = realConsoleError;
	if (savedAutoconnect === undefined) delete process.env.PI_TELEGRAM_AUTOCONNECT;
	else process.env.PI_TELEGRAM_AUTOCONNECT = savedAutoconnect;
});

describe("telegram.json writes", () => {
	it("never leaves a damaged file when writes overlap", async () => {
		const short = { ...GOOD_CONFIG, lastUpdateId: 8 };
		const long = { ...GOOD_CONFIG, processedUpdateIds: Array.from({ length: 200 }, (_, index) => 1000 + index) };
		for (let round = 0; round < 200; round++) {
			const [first, second] = round % 2 ? [short, long] : [long, short];
			await Promise.all([module.writeConfig(first), module.writeConfig(second)]);
			const content = await readFile(configPath(), "utf8");
			assert.doesNotThrow(() => JSON.parse(content), `round ${round} left a damaged telegram.json`);
			// Writes land in the order they were requested.
			assert.deepEqual(JSON.parse(content), second);
		}
	});

	it("keeps a matching backup and no temporary files, all readable by the owner only", async () => {
		await module.writeConfig(GOOD_CONFIG);

		assert.equal(await readFile(backupPath(), "utf8"), await readFile(configPath(), "utf8"));
		assert.equal(await fileMode(configPath()), 0o600);
		assert.equal(await fileMode(backupPath()), 0o600);
		assert.deepEqual((await readdir(agentDir)).filter((name) => name.endsWith(".tmp")), []);
	});
});

describe("damaged telegram.json at startup", () => {
	let harness: ReturnType<typeof createHarness>;

	afterEach(async () => {
		await harness.emit("session_shutdown");
	});

	it("restores the backup, keeps the damaged file aside and tells the user on Telegram", async () => {
		await writeFile(backupPath(), JSON.stringify(GOOD_CONFIG), { mode: 0o600 });
		const backupTime = new Date(2026, 8, 29, 18, 46);
		await utimes(backupPath(), backupTime, backupTime);
		await writeFile(configPath(), DAMAGED, { mode: 0o644 });

		harness = createHarness();
		await harness.emit("session_start");
		await waitFor(() => calls.some((call) => call.method === "getUpdates"), "the bridge to connect");

		assert.deepEqual(JSON.parse(await readFile(configPath(), "utf8")), GOOD_CONFIG);
		const corrupt = (await readdir(agentDir)).filter((name) => name.startsWith("telegram.json.corrupt-"));
		assert.equal(corrupt.length, 1);
		assert.equal(await readFile(join(agentDir, corrupt[0]!), "utf8"), DAMAGED);
		assert.equal(await fileMode(join(agentDir, corrupt[0]!)), 0o600);
		assert.equal(await fileMode(configPath()), 0o600);
		assert.deepEqual(sentTexts(), ["telegram.json estaba dañado; lo restauré desde la copia de 29/09 18:46."]);
		assert.equal(calls.find((call) => call.method === "sendMessage")!.body.chat_id, PAIRED_USER_ID);
		assert.ok(loggedErrors.some((line) => line.includes("is damaged")), JSON.stringify(loggedErrors));
	});

	it("never leaves telegram.json missing when the restore fails halfway, and the next start restores it", async () => {
		await writeFile(backupPath(), JSON.stringify(GOOD_CONFIG), { mode: 0o600 });
		await writeFile(configPath(), DAMAGED, { mode: 0o600 });
		// A directory where the temporary file goes makes the restore fail after the damaged copy is saved.
		const temporary = `${configPath()}.${process.pid}.tmp`;
		await mkdir(temporary);

		harness = createHarness();
		await harness.emit("session_start");
		await harness.emit("session_shutdown");

		assert.equal(await readFile(configPath(), "utf8"), DAMAGED, "telegram.json must still exist, damaged, after the failed restore");
		await rm(temporary, { recursive: true });
		calls = [];
		harness = createHarness();
		await harness.emit("session_start");
		await waitFor(() => calls.some((call) => call.method === "getUpdates"), "the bridge to connect");

		assert.deepEqual(JSON.parse(await readFile(configPath(), "utf8")), GOOD_CONFIG);
		const corrupt = (await readdir(agentDir)).filter((name) => name.startsWith("telegram.json.corrupt-"));
		assert.ok(corrupt.length >= 1);
		for (const name of corrupt) {
			assert.equal(await readFile(join(agentDir, name), "utf8"), DAMAGED);
			assert.equal(await fileMode(join(agentDir, name)), 0o600);
		}
	});

	it("creates the backup at startup when a valid telegram.json has none", async () => {
		const content = JSON.stringify(GOOD_CONFIG, null, "\t") + "\n";
		await writeFile(configPath(), content, { mode: 0o600 });

		harness = createHarness();
		await harness.emit("session_start");

		assert.equal(await readFile(backupPath(), "utf8"), content);
		assert.equal(await fileMode(backupPath()), 0o600);
	});

	for (const [label, prepareBackup] of [
		["missing", async () => undefined],
		["damaged too", async () => writeFile(backupPath(), DAMAGED, { mode: 0o600 })],
	] as const) {
		it(`stays disconnected and leaves the file untouched when the backup is ${label}`, async () => {
			await prepareBackup();
			await writeFile(configPath(), DAMAGED, { mode: 0o600 });

			harness = createHarness();
			await harness.emit("session_start");
			// A write requested meanwhile must not replace the only copy of the token.
			await module.writeConfig({ lastUpdateId: 9 });

			assert.equal(await readFile(configPath(), "utf8"), DAMAGED);
			assert.equal(calls.filter((call) => call.method === "getUpdates").length, 0);
			assert.ok(loggedErrors.some((line) => line.includes(`is ${label}`)), JSON.stringify(loggedErrors));
		});
	}
});
