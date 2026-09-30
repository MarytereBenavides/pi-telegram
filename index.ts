import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { homedir } from "node:os";

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

interface TelegramConfig {
	botToken?: string;
	botUsername?: string;
	botId?: number;
	allowedUserId?: number;
	/**
	 * Low watermark: every update up to this id is fully processed, so it is
	 * safe to acknowledge to Telegram. Never advanced past a queued or running turn.
	 */
	lastUpdateId?: number;
	/** Updates above the watermark that already finished; skipped when Telegram redelivers them. */
	processedUpdateIds?: number[];
	/**
	 * Updates whose turn started running and has not finished. If pi stops meanwhile, Telegram
	 * redelivers them; they are acknowledged with a notice instead of being run a second time,
	 * so a message that restarts pi cannot restart it again in a loop.
	 */
	startedUpdateIds?: number[];
	/** Failed interruption notices per update id, capped at INTERRUPTED_NOTICE_MAX_ATTEMPTS across restarts. */
	interruptedNoticeAttempts?: Record<string, number>;
}

interface TelegramApiResponse<T> {
	ok: boolean;
	result?: T;
	description?: string;
	error_code?: number;
}

interface TelegramUser {
	id: number;
	is_bot: boolean;
	first_name: string;
	username?: string;
}

interface TelegramChat {
	id: number;
	type: string;
}

interface TelegramPhotoSize {
	file_id: string;
	file_size?: number;
}

interface TelegramDocument {
	file_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

interface TelegramVideo {
	file_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

interface TelegramAudio {
	file_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

interface TelegramVoice {
	file_id: string;
	mime_type?: string;
	file_size?: number;
}

interface TelegramAnimation {
	file_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

interface TelegramSticker {
	file_id: string;
	emoji?: string;
}

interface TelegramFileInfo {
	file_id: string;
	fileName: string;
	mimeType?: string;
	isImage: boolean;
}

interface TelegramMessage {
	message_id: number;
	chat: TelegramChat;
	from?: TelegramUser;
	text?: string;
	caption?: string;
	media_group_id?: string;
	photo?: TelegramPhotoSize[];
	document?: TelegramDocument;
	video?: TelegramVideo;
	audio?: TelegramAudio;
	voice?: TelegramVoice;
	animation?: TelegramAnimation;
	sticker?: TelegramSticker;
}

interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
	edited_message?: TelegramMessage;
}

interface TelegramGetFileResult {
	file_path: string;
}

interface TelegramSentMessage {
	message_id: number;
}

interface DownloadedTelegramFile {
	path: string;
	fileName: string;
	isImage: boolean;
	mimeType?: string;
}

interface PendingTelegramTurn {
	/** Telegram updates this turn answers; acknowledged only once the turn ends. */
	updateIds: number[];
	chatId: number;
	replyToMessageId: number;
	queuedAttachments: QueuedAttachment[];
	content: Array<TextContent | ImageContent>;
	historyText: string;
}

type ActiveTelegramTurn = PendingTelegramTurn;

interface QueuedAttachment {
	path: string;
	fileName: string;
}

interface TelegramPreviewState {
	mode: "draft" | "message";
	draftId?: number;
	messageId?: number;
	replyToMessageId: number;
	pendingText: string;
	lastSentText: string;
	flushTimer?: ReturnType<typeof setTimeout>;
	inFlight?: Promise<void>;
}

interface TelegramMediaGroupState {
	messages: TelegramMessage[];
	updateIds: number[];
	flushTimer?: ReturnType<typeof setTimeout>;
}

/** One blocking terminal dialog that has been announced to Telegram. */
interface DialogAlert {
	chatId: number;
	messageId?: number;
	lines: string[];
	sending: Promise<void>;
}

/** One option of a `gentle-pi` choice/questionnaire tool call. */
interface DialogOption {
	label?: unknown;
	description?: unknown;
}

/** One question of an `ask_user_question` tool call. */
interface DialogQuestion {
	question?: unknown;
	header?: unknown;
	options?: unknown;
	multiSelect?: unknown;
}

const CONFIG_PATH = join(homedir(), ".pi", "agent", "telegram.json");
/** Last config that was written successfully; the source for restoring a damaged CONFIG_PATH. */
const CONFIG_BACKUP_PATH = `${CONFIG_PATH}.bak`;
/** The config holds the bot token: every copy of it is readable by its owner only. */
const CONFIG_FILE_MODE = 0o600;
const HEARTBEAT_PATH = join(homedir(), ".pi", "agent", "telegram-heartbeat.json");
const TEMP_DIR = join(homedir(), ".pi", "agent", "tmp", "telegram");
const TELEGRAM_PREFIX = "[telegram]";
const MAX_MESSAGE_LENGTH = 4096;
const MAX_ATTACHMENTS_PER_TURN = 10;
const PREVIEW_THROTTLE_MS = 750;
const TELEGRAM_DRAFT_ID_MAX = 2_147_483_647;
const TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS = 1200;
/**
 * getUpdates returns unacknowledged updates immediately, so while turns wait in
 * the queue every poll hands them back. This pause keeps that from spinning.
 */
const KNOWN_UPDATES_REPOLL_MS = 2000;
/** Telegram's maximum; the batch must fit every retained update plus the new ones. */
const GET_UPDATES_LIMIT = 100;

/**
 * Tools that open a blocking terminal dialog and expose the full question and
 * options through their `tool_call` arguments. Everything else is announced
 * from the generic `ui_prompt_start` event, which only carries kind and title.
 */
const DIALOG_TOOL_NAMES = new Set(["ask_user_choice", "ask_user_question"]);

/** Key used for the single generic UI prompt alert; pi never nests outer prompts. */
const UI_PROMPT_ALERT_KEY = "ui_prompt";

/**
 * Sent for every queued message so none is ever silently parked. The first one
 * of a busy period explains the situation; the rest only confirm the position,
 * because repeating the explanation on every message is noise.
 * User-facing copy is Spanish on purpose: the only paired account is the CEO.
 */
const INTERRUPTED_QUOTE_LENGTH = 60;
/** Attempts at the interruption notice before the update is acknowledged without it. */
const INTERRUPTED_NOTICE_MAX_ATTEMPTS = 3;
const INTERRUPTED_NOTICE_RETRY_MS = 3000;

/** A Bot API error response, with Telegram's error code when it sent one. */
class TelegramApiError extends Error {
	readonly errorCode?: number;

	constructor(message: string, errorCode?: number) {
		super(message);
		this.errorCode = errorCode;
	}
}

/** 4xx other than 429 (rate limit) will fail the same way on every retry. */
function isPermanentTelegramError(error: unknown): boolean {
	const code = error instanceof TelegramApiError ? error.errorCode : undefined;
	return code !== undefined && code >= 400 && code < 500 && code !== 429;
}

function formatInterruptedNotice(messageText: string): string {
	// Counted in code points: cutting UTF-16 units can split an emoji into a lone surrogate.
	const characters = Array.from(messageText.trim().replace(/\s+/g, " "));
	const text = characters.join("");
	const quote = characters.length > INTERRUPTED_QUOTE_LENGTH ? `${characters.slice(0, INTERRUPTED_QUOTE_LENGTH).join("")}…` : text;
	const subject = quote ? `Tu mensaje "${quote}"` : "Tu mensaje";
	return `${subject} se interrumpió por un reinicio; no lo repetí. Reenvíalo si hace falta.`;
}

function formatBusyNotice(queuePosition: number, isFirstOfPeriod: boolean): string {
	return isFirstOfPeriod
		? `Estoy terminando otra tarea. Tu mensaje llegó y queda en fila (n.º ${queuePosition}); te respondo apenas termine.`
		: `Recibido, queda en fila (n.º ${queuePosition}).`;
}

const DIALOG_ALERT_HEADER = "⏸ pi is waiting for your answer in the terminal";

const DIALOG_RESOLVED_HEADER = "✅ Answered in the terminal";

/**
 * pi exposes no API to submit an answer to an open dialog from an extension, so
 * the alert has to say plainly that replying here does not unblock the session.
 */
const DIALOG_ALERT_FOOTER = "Answer in the pi terminal. A reply here is queued as a normal message and does not select an option.";

const SYSTEM_PROMPT_SUFFIX = `

Telegram bridge extension is active.
- Messages forwarded from Telegram are prefixed with "[telegram]".
- [telegram] messages may include local temp file paths for Telegram attachments. Read those files as needed.
- If a [telegram] user asked for a file or generated artifact, use the telegram_attach tool with the local file path so the extension can send it with your next final reply.
- Do not assume mentioning a local file path in plain text will send it to Telegram. Use telegram_attach.
- When the current message did NOT come from Telegram (for example a notice from another session) and the Telegram user must hear about it, use the telegram_send tool. Otherwise the reply stays in the terminal and never reaches Telegram.`;

function isTelegramPrompt(prompt: string): boolean {
	return prompt.trimStart().startsWith(TELEGRAM_PREFIX);
}

function sanitizeFileName(name: string): string {
	return name.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function guessExtensionFromMime(mimeType: string | undefined, fallback: string): string {
	if (!mimeType) return fallback;
	const normalized = mimeType.toLowerCase();
	if (normalized === "image/jpeg") return ".jpg";
	if (normalized === "image/png") return ".png";
	if (normalized === "image/webp") return ".webp";
	if (normalized === "image/gif") return ".gif";
	if (normalized === "audio/ogg") return ".ogg";
	if (normalized === "audio/mpeg") return ".mp3";
	if (normalized === "audio/wav") return ".wav";
	if (normalized === "video/mp4") return ".mp4";
	if (normalized === "application/pdf") return ".pdf";
	return fallback;
}

function guessMediaType(path: string): string | undefined {
	const ext = extname(path).toLowerCase();
	if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
	if (ext === ".png") return "image/png";
	if (ext === ".webp") return "image/webp";
	if (ext === ".gif") return "image/gif";
	return undefined;
}

function isImageMimeType(mimeType: string | undefined): boolean {
	return mimeType?.toLowerCase().startsWith("image/") ?? false;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function chunkParagraphs(text: string): string[] {
	if (text.length <= MAX_MESSAGE_LENGTH) return [text];

	const normalized = text.replace(/\r\n/g, "\n");
	const paragraphs = normalized.split(/\n\n+/);
	const chunks: string[] = [];
	let current = "";

	const flushCurrent = (): void => {
		if (current.trim().length > 0) chunks.push(current);
		current = "";
	};

	const splitLongBlock = (block: string): string[] => {
		if (block.length <= MAX_MESSAGE_LENGTH) return [block];
		const lines = block.split("\n");
		const lineChunks: string[] = [];
		let lineCurrent = "";
		for (const line of lines) {
			const candidate = lineCurrent.length === 0 ? line : `${lineCurrent}\n${line}`;
			if (candidate.length <= MAX_MESSAGE_LENGTH) {
				lineCurrent = candidate;
				continue;
			}
			if (lineCurrent.length > 0) {
				lineChunks.push(lineCurrent);
				lineCurrent = "";
			}
			if (line.length <= MAX_MESSAGE_LENGTH) {
				lineCurrent = line;
				continue;
			}
			for (let i = 0; i < line.length; i += MAX_MESSAGE_LENGTH) {
				lineChunks.push(line.slice(i, i + MAX_MESSAGE_LENGTH));
			}
		}
		if (lineCurrent.length > 0) lineChunks.push(lineCurrent);
		return lineChunks;
	};

	for (const paragraph of paragraphs) {
		if (paragraph.length === 0) continue;
		const parts = splitLongBlock(paragraph);
		for (const part of parts) {
			const candidate = current.length === 0 ? part : `${current}\n\n${part}`;
			if (candidate.length <= MAX_MESSAGE_LENGTH) {
				current = candidate;
			} else {
				flushCurrent();
				current = part;
			}
		}
	}
	flushCurrent();
	return chunks;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener("abort", () => {
			clearTimeout(timer);
			resolve();
		}, { once: true });
	});
}

interface LoadedConfig {
	config: TelegramConfig;
	/** CONFIG_PATH was damaged and has been restored from the backup written at this time. */
	restoredFrom?: Date;
	/** CONFIG_PATH is damaged and there is no usable backup: the bridge must stay down. */
	error?: string;
}

/** Set while CONFIG_PATH is damaged and unrecoverable, so no write replaces the only copy left. */
let configWritesBlocked = false;

function isMissingFile(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

async function readConfigFile(path: string): Promise<{ config?: TelegramConfig; content?: string; missing?: true; error?: string }> {
	let content: string;
	try {
		content = await readFile(path, "utf8");
	} catch (error) {
		if (isMissingFile(error)) return { missing: true };
		return { error: error instanceof Error ? error.message : String(error) };
	}
	try {
		const parsed: unknown = JSON.parse(content);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { error: "not a JSON object" };
		return { config: parsed as TelegramConfig, content };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/** Writes through a temporary file in the same directory, so readers see the old or the new file, never a mix. */
async function writeFileAtomic(path: string, content: string): Promise<void> {
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, content, { encoding: "utf8", mode: CONFIG_FILE_MODE });
	await rename(temporary, path);
}

/** Copies a damaged config aside, owner-only from the first byte, without removing the original. */
async function keepDamagedCopy(): Promise<string> {
	const corruptPath = `${CONFIG_PATH}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
	await writeFile(corruptPath, await readFile(CONFIG_PATH), { mode: CONFIG_FILE_MODE, flag: "wx" });
	return corruptPath;
}

/**
 * Reads CONFIG_PATH. A missing file is a fresh install. A damaged one is copied aside as
 * telegram.json.corrupt-<timestamp> and atomically replaced by the backup, so the bridge
 * stays up and CONFIG_PATH never goes missing; without a usable backup it is left
 * untouched and further writes are blocked.
 */
export async function readConfig(): Promise<LoadedConfig> {
	configWritesBlocked = false;
	const main = await readConfigFile(CONFIG_PATH);
	if (main.config) {
		// The first start after an upgrade has no backup yet: take it now, from a known good file,
		// instead of waiting for a write that could be the one that goes wrong.
		const backup = await readConfigFile(CONFIG_BACKUP_PATH);
		if (backup.missing && main.content !== undefined) {
			try {
				await writeFileAtomic(CONFIG_BACKUP_PATH, main.content);
			} catch (error) {
				console.error(`pi-telegram: could not create ${CONFIG_BACKUP_PATH}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return { config: main.config };
	}
	if (main.missing) return { config: {} };

	console.error(`pi-telegram: ${CONFIG_PATH} is damaged (${main.error})`);
	const backup = await readConfigFile(CONFIG_BACKUP_PATH);
	if (!backup.config) {
		configWritesBlocked = true;
		const error = `${CONFIG_PATH} is damaged and ${CONFIG_BACKUP_PATH} is ${backup.missing ? "missing" : "damaged too"}; run /telegram-setup`;
		console.error(`pi-telegram: ${error}`);
		return { config: {}, error };
	}

	const backupStats = await stat(CONFIG_BACKUP_PATH);
	try {
		// Copy first, then replace: the rename swaps CONFIG_PATH atomically, so a crash at any
		// point leaves either the damaged file (restored again on the next start) or the good one.
		const corruptPath = await keepDamagedCopy();
		await writeFileAtomic(CONFIG_PATH, JSON.stringify(backup.config, null, "\t") + "\n");
		console.error(`pi-telegram: restored ${CONFIG_PATH} from ${CONFIG_BACKUP_PATH}; the damaged file is ${corruptPath}`);
	} catch (error) {
		// The bridge still runs on the backup; the next start tries the restore again.
		console.error(`pi-telegram: could not restore ${CONFIG_PATH} from ${CONFIG_BACKUP_PATH}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return { config: backup.config, restoredFrom: backupStats.mtime };
}

/**
 * Every writer (poll loop, album timers, pi events) shares this chain: one write at a
 * time, each with the content of the config when it was requested.
 */
let configWriteChain: Promise<void> = Promise.resolve();

export async function writeConfig(config: TelegramConfig): Promise<void> {
	const content = JSON.stringify(config, null, "\t") + "\n";
	const write = configWriteChain.then(async () => {
		if (configWritesBlocked) {
			console.error(`pi-telegram: not writing ${CONFIG_PATH}, it is damaged and has no backup; run /telegram-setup`);
			return;
		}
		await mkdir(join(homedir(), ".pi", "agent"), { recursive: true });
		await writeFileAtomic(CONFIG_PATH, content);
		await writeFileAtomic(CONFIG_BACKUP_PATH, content);
	});
	configWriteChain = write.catch(() => undefined);
	await write;
}

/** An explicit /telegram-setup replaces a damaged config; the damaged file is kept aside. */
async function unblockConfigWrites(): Promise<void> {
	if (!configWritesBlocked) return;
	try {
		await keepDamagedCopy();
	} catch (error) {
		if (!isMissingFile(error)) throw error;
	}
	configWritesBlocked = false;
}

function formatConfigRestoredNotice(restoredFrom: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	const when = `${pad(restoredFrom.getDate())}/${pad(restoredFrom.getMonth() + 1)} ${pad(restoredFrom.getHours())}:${pad(restoredFrom.getMinutes())}`;
	return `telegram.json estaba dañado; lo restauré desde la copia de ${when}.`;
}

/**
 * Liveness marker for out-of-process watchers (see tools/offline-responder):
 * its absence or staleness means no pi session is polling the bot, so an
 * external responder can safely answer without racing pi for getUpdates.
 * Only the session running pollLoop writes it, and pollLoop only runs in the
 * one session that connected the bridge.
 */
async function writeHeartbeat(): Promise<void> {
	try {
		await mkdir(join(homedir(), ".pi", "agent"), { recursive: true });
		await writeFile(HEARTBEAT_PATH, JSON.stringify({ pid: process.pid, updatedAt: Date.now() }) + "\n", "utf8");
	} catch {
		// Best effort: a failed heartbeat must never break polling.
	}
}

/** Removes the heartbeat, but only when this process is still its owner. */
async function removeHeartbeat(): Promise<void> {
	try {
		const content = await readFile(HEARTBEAT_PATH, "utf8");
		const parsed = JSON.parse(content) as { pid?: number };
		if (parsed.pid !== undefined && parsed.pid !== process.pid) return;
	} catch {
		// Unreadable or missing: fall through, the unlink below is guarded too.
	}
	try {
		await unlink(HEARTBEAT_PATH);
	} catch {
		// Already gone.
	}
}

export default function (pi: ExtensionAPI) {
	let config: TelegramConfig = {};
	let pollingController: AbortController | undefined;
	let pollingPromise: Promise<void> | undefined;
	let queuedTelegramTurns: PendingTelegramTurn[] = [];
	let activeTelegramTurn: ActiveTelegramTurn | undefined;
	let telegramTurnRequested = false;
	let typingInterval: ReturnType<typeof setInterval> | undefined;
	let currentAbort: (() => void) | undefined;
	let preserveQueuedTurnsAsHistory = false;
	let setupInProgress = false;
	let previewState: TelegramPreviewState | undefined;
	/** Why the config could not be loaded; shown in the status line until /telegram-setup fixes it. */
	let configError: string | undefined;
	/** Backup time of a config restored at load, announced on Telegram once connected. */
	let pendingRestoreNotice: Date | undefined;
	/** The latest assistant message of the active turn already reached Telegram from message_end. */
	let latestAnswerDelivered = false;
	let draftSupport: "unknown" | "supported" | "unsupported" = "unsupported";
	let nextDraftId = 0;
	const mediaGroups = new Map<string, TelegramMediaGroupState>();
	const dialogAlerts = new Map<string, DialogAlert>();
	let lastKnownChatId: number | undefined;
	/** True once the long notice of the current busy period went out; reset when the queue drains. */
	let busyNoticeSent = false;
	/** Files queued by telegram_attach outside a Telegram turn; flushed by the next telegram_send. */
	let pendingSendAttachments: QueuedAttachment[] = [];
	/** Updates held by a queued, running or debounced turn: they pin the watermark. */
	const retainedUpdateIds = new Set<number>();
	/** Highest update id received; the watermark catches up to it once nothing is retained. */
	let highestSeenUpdateId: number | undefined;
	/** Media groups already told they were interrupted, so a redelivered album gets one notice. */
	const interruptedGroupsNotified = new Set<string>();
	/**
	 * Interrupted updates whose notice failed, with the time of the next attempt. They stay
	 * retained, and are handled again once redelivered after that time.
	 */
	const interruptedNoticeRetryAt = new Map<number, number>();

	function isUpdateKnown(updateId: number): boolean {
		return (config.lastUpdateId !== undefined && updateId <= config.lastUpdateId)
			|| (retainedUpdateIds.has(updateId) && !(Date.now() >= (interruptedNoticeRetryAt.get(updateId) ?? Infinity)))
			|| (config.processedUpdateIds ?? []).includes(updateId);
	}

	/**
	 * Marks updates as done and persists the new watermark: everything below the
	 * oldest retained update, or everything seen when nothing is retained. A
	 * restart then redelivers exactly the turns that never finished.
	 */
	async function completeUpdates(updateIds: number[]): Promise<void> {
		if (updateIds.length === 0) return;
		for (const id of updateIds) retainedUpdateIds.delete(id);
		const processed = new Set([...(config.processedUpdateIds ?? []), ...updateIds]);
		const oldestRetained = retainedUpdateIds.size > 0 ? Math.min(...retainedUpdateIds) : undefined;
		const watermark = oldestRetained !== undefined ? oldestRetained - 1 : highestSeenUpdateId;
		if (watermark !== undefined && (config.lastUpdateId === undefined || watermark > config.lastUpdateId)) {
			config.lastUpdateId = watermark;
		}
		const floor = config.lastUpdateId ?? -Infinity;
		config.processedUpdateIds = [...processed].filter((id) => id > floor).sort((a, b) => a - b);
		if (config.processedUpdateIds.length === 0) delete config.processedUpdateIds;
		config.startedUpdateIds = (config.startedUpdateIds ?? []).filter((id) => !updateIds.includes(id));
		if (config.startedUpdateIds.length === 0) delete config.startedUpdateIds;
		if (config.interruptedNoticeAttempts) {
			for (const id of updateIds) delete config.interruptedNoticeAttempts[String(id)];
			if (Object.keys(config.interruptedNoticeAttempts).length === 0) delete config.interruptedNoticeAttempts;
		}
		await writeConfig(config);
	}

	/** Persists that a turn is running, before pi gets the chance to act on it. */
	async function markUpdatesStarted(updateIds: number[]): Promise<void> {
		if (updateIds.length === 0) return;
		config.startedUpdateIds = [...new Set([...(config.startedUpdateIds ?? []), ...updateIds])].sort((a, b) => a - b);
		await writeConfig(config);
	}

	function allocateDraftId(): number {
		nextDraftId = nextDraftId >= TELEGRAM_DRAFT_ID_MAX ? 1 : nextDraftId + 1;
		return nextDraftId;
	}

	function updateStatus(ctx: ExtensionContext, error?: string): void {
		const theme = ctx.ui.theme;
		const label = theme.fg("accent", "telegram");
		if (error) {
			ctx.ui.setStatus("telegram", `${label} ${theme.fg("error", "error")} ${theme.fg("muted", error)}`);
			return;
		}
		if (!config.botToken) {
			ctx.ui.setStatus("telegram", `${label} ${theme.fg("muted", "not configured")}`);
			return;
		}
		if (!pollingPromise) {
			ctx.ui.setStatus("telegram", `${label} ${theme.fg("muted", "disconnected")}`);
			return;
		}
		if (!config.allowedUserId) {
			ctx.ui.setStatus("telegram", `${label} ${theme.fg("warning", "awaiting pairing")}`);
			return;
		}
		if (activeTelegramTurn || queuedTelegramTurns.length > 0) {
			const queued = queuedTelegramTurns.length > 0 ? theme.fg("muted", ` +${queuedTelegramTurns.length} queued`) : "";
			ctx.ui.setStatus("telegram", `${label} ${theme.fg("accent", "processing")}${queued}`);
			return;
		}
		ctx.ui.setStatus("telegram", `${label} ${theme.fg("success", "connected")}`);
	}

	async function callTelegram<TResponse>(
		method: string,
		body: Record<string, unknown>,
		options?: { signal?: AbortSignal },
	): Promise<TResponse> {
		if (!config.botToken) throw new Error("Telegram bot token is not configured");
		const response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: options?.signal,
		});
			const data = (await response.json()) as TelegramApiResponse<TResponse>;
		if (!data.ok || data.result === undefined) {
			throw new TelegramApiError(data.description || `Telegram API ${method} failed`, data.error_code);
		}
		return data.result;
	}

	async function callTelegramMultipart<TResponse>(
		method: string,
		fields: Record<string, string>,
		fileField: string,
		filePath: string,
		fileName: string,
		options?: { signal?: AbortSignal },
	): Promise<TResponse> {
		if (!config.botToken) throw new Error("Telegram bot token is not configured");
		const form = new FormData();
		for (const [key, value] of Object.entries(fields)) {
			form.set(key, value);
		}
		const buffer = await readFile(filePath);
		form.set(fileField, new Blob([buffer]), fileName);
		const response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
			method: "POST",
			body: form,
			signal: options?.signal,
		});
		const data = (await response.json()) as TelegramApiResponse<TResponse>;
		if (!data.ok || data.result === undefined) {
			throw new Error(data.description || `Telegram API ${method} failed`);
		}
		return data.result;
	}

	async function downloadTelegramFile(fileId: string, suggestedName: string): Promise<string> {
		if (!config.botToken) throw new Error("Telegram bot token is not configured");
		const file = await callTelegram<TelegramGetFileResult>("getFile", { file_id: fileId });
		await mkdir(TEMP_DIR, { recursive: true });
		const targetPath = join(TEMP_DIR, `${Date.now()}-${sanitizeFileName(suggestedName)}`);
		const response = await fetch(`https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`);
		if (!response.ok) throw new Error(`Failed to download Telegram file: ${response.status}`);
		const arrayBuffer = await response.arrayBuffer();
		await writeFile(targetPath, Buffer.from(arrayBuffer));
		return targetPath;
	}

	function startTypingLoop(ctx: ExtensionContext, chatId?: number): void {
		const targetChatId = chatId ?? activeTelegramTurn?.chatId;
		if (typingInterval || targetChatId === undefined) return;

		const sendTyping = async (): Promise<void> => {
			if (!activeTelegramTurn && queuedTelegramTurns.length === 0) {
				stopTypingLoop();
				return;
			}
			try {
				await callTelegram("sendChatAction", { chat_id: targetChatId, action: "typing" });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				updateStatus(ctx, `typing failed: ${message}`);
			}
		};

		void sendTyping();
		typingInterval = setInterval(() => {
			void sendTyping();
		}, 4000);
	}

	function stopTypingLoop(): void {
		if (!typingInterval) return;
		clearInterval(typingInterval);
		typingInterval = undefined;
	}

	function stopTypingLoopIfInactive(): void {
		if (!activeTelegramTurn && queuedTelegramTurns.length === 0) {
			stopTypingLoop();
		}
	}

	function dispatchNextQueuedTelegramTurn(ctx: ExtensionContext): void {
		if (!ctx.isIdle() || telegramTurnRequested || activeTelegramTurn || queuedTelegramTurns.length === 0 || preserveQueuedTurnsAsHistory) {
			stopTypingLoopIfInactive();
			return;
		}

		const nextTurn = queuedTelegramTurns[0];
		if (!nextTurn) {
			stopTypingLoopIfInactive();
			return;
		}

		startTypingLoop(ctx, nextTurn.chatId);
		updateStatus(ctx);
		telegramTurnRequested = true;
		pi.sendUserMessage(nextTurn.content);
	}

	function isAssistantMessage(message: AgentMessage): boolean {
		// SAFETY: AgentMessage is a union whose variants do not all declare `role`; every field is re-checked at runtime below.
		return (message as unknown as { role?: string }).role === "assistant";
	}

	/**
	 * A complete answer ends the model's output without asking for a tool. A "length" stop that
	 * still carries a tool call is not one: pi keeps the loop going and executes that call.
	 */
	function isFinalAnswer(message: AgentMessage): boolean {
		// SAFETY: AgentMessage is a union whose variants do not all declare these fields; each one is re-checked at runtime below.
		const value = message as unknown as Record<string, unknown>;
		if (value.stopReason !== "stop" && value.stopReason !== "length") return false;
		const content = Array.isArray(value.content) ? value.content : [];
		return !content.some((block) => typeof block === "object" && block !== null && (block as { type?: unknown }).type === "toolCall");
	}

	function getMessageText(message: AgentMessage): string {
		// SAFETY: AgentMessage is a union whose variants do not all declare `content`; every field is re-checked at runtime below.
		const value = message as unknown as Record<string, unknown>;
		const content = Array.isArray(value.content) ? value.content : [];
		return content
			.filter((block): block is { type: string; text?: string } => typeof block === "object" && block !== null && "type" in block)
			.filter((block) => block.type === "text" && typeof block.text === "string")
			.map((block) => block.text as string)
			.join("")
			.trim();
	}

	async function clearPreview(chatId: number): Promise<void> {
		const state = previewState;
		if (!state) return;
		if (state.flushTimer) {
			clearTimeout(state.flushTimer);
			state.flushTimer = undefined;
		}
		previewState = undefined;
		if (state.mode === "draft" && state.draftId !== undefined) {
			try {
				await callTelegram("sendMessageDraft", { chat_id: chatId, draft_id: state.draftId, text: "" });
			} catch {
				// ignore
			}
		}
	}

	// Installs a fresh preview state, cancelling any timer still armed on the state it
	// replaces. Without the clearTimeout the orphaned timer fires against the new object.
	function startPreviewState(replyToMessageId: number): TelegramPreviewState {
		if (previewState?.flushTimer) {
			clearTimeout(previewState.flushTimer);
		}
		previewState = { mode: draftSupport === "unsupported" ? "message" : "draft", replyToMessageId, pendingText: "", lastSentText: "" };
		return previewState;
	}

	async function flushPreview(chatId: number): Promise<void> {
		const state = previewState;
		if (!state) return;
		if (state.flushTimer) {
			clearTimeout(state.flushTimer);
			state.flushTimer = undefined;
		}

		// Serialize the round-trips of a single preview state. A sendMessage slower than
		// PREVIEW_THROTTLE_MS would otherwise let the next scheduled flush run while
		// state.messageId is still unset, sending a duplicate message instead of editing
		// the first one. Each caller awaits the whole chain, so finalizePreview still sees
		// the settled state.
		const previous = state.inFlight;
		const current = (async () => {
			if (previous) await previous.catch(() => {});
			await sendPreviewText(chatId, state);
		})();
		state.inFlight = current;
		try {
			await current;
		} finally {
			if (state.inFlight === current) {
				state.inFlight = undefined;
			}
		}
	}

	async function sendPreviewText(chatId: number, state: TelegramPreviewState): Promise<void> {
		// The state may have been cleared or replaced while this link of the chain waited.
		if (previewState !== state) return;
		const text = state.pendingText.trim();
		if (!text || text === state.lastSentText) return;
		const truncated = text.length > MAX_MESSAGE_LENGTH ? text.slice(0, MAX_MESSAGE_LENGTH) : text;

		if (draftSupport !== "unsupported") {
			const draftId = state.draftId ?? allocateDraftId();
			state.draftId = draftId;
			try {
				await callTelegram("sendMessageDraft", { chat_id: chatId, draft_id: draftId, text: truncated });
				draftSupport = "supported";
				state.mode = "draft";
				state.lastSentText = truncated;
				return;
			} catch {
				draftSupport = "unsupported";
			}
		}

		if (state.messageId === undefined) {
			const sent = await callTelegram<TelegramSentMessage>("sendMessage", {
				chat_id: chatId,
				text: truncated,
				reply_parameters: { message_id: state.replyToMessageId, allow_sending_without_reply: true },
			});
			state.messageId = sent.message_id;
			state.mode = "message";
			state.lastSentText = truncated;
			return;
		}
		await callTelegram("editMessageText", { chat_id: chatId, message_id: state.messageId, text: truncated });
		state.mode = "message";
		state.lastSentText = truncated;
	}

	function schedulePreviewFlush(chatId: number): void {
		if (!previewState || previewState.flushTimer) return;
		previewState.flushTimer = setTimeout(() => {
			void flushPreview(chatId);
		}, PREVIEW_THROTTLE_MS);
	}

	async function finalizePreview(chatId: number): Promise<boolean> {
		const state = previewState;
		if (!state) return false;
		await flushPreview(chatId);
		const finalText = (state.pendingText.trim() || state.lastSentText).trim();
		if (!finalText) {
			await clearPreview(chatId);
			return false;
		}
		if (state.mode === "draft") {
			await callTelegram<TelegramSentMessage>("sendMessage", { chat_id: chatId, text: finalText });
			await clearPreview(chatId);
			return true;
		}
		previewState = undefined;
		return state.messageId !== undefined;
	}

	async function sendTextReply(chatId: number, replyToMessageId: number, text: string): Promise<number | undefined> {
		const chunks = chunkParagraphs(text);
		let lastMessageId: number | undefined;
		for (const [index, chunk] of chunks.entries()) {
			const sent = await callTelegram<TelegramSentMessage>("sendMessage", {
				chat_id: chatId,
				text: chunk,
				...(index === 0 ? { reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true } } : {}),
			});
			lastMessageId = sent.message_id;
		}
		return lastMessageId;
	}

	/**
	 * Chat used for unsolicited alerts. Prefers the chat of the turn in flight,
	 * then the last chat that talked to the bridge, then the paired account — in
	 * a private chat the Telegram user id doubles as the chat id.
	 */
	async function loadConfig(): Promise<void> {
		const loaded = await readConfig();
		config = loaded.config;
		configError = loaded.error;
		if (loaded.restoredFrom) pendingRestoreNotice = loaded.restoredFrom;
	}

	/** Tells the Telegram user their config was restored, once the bridge can reach them. */
	async function sendPendingRestoreNotice(signal: AbortSignal): Promise<void> {
		const restoredFrom = pendingRestoreNotice;
		const chatId = resolveAlertChatId();
		if (!restoredFrom || chatId === undefined) return;
		try {
			await callTelegram("sendMessage", { chat_id: chatId, text: formatConfigRestoredNotice(restoredFrom) }, { signal });
			pendingRestoreNotice = undefined;
		} catch {
			// Best effort: retried on the next connection.
		}
	}

	function resolveAlertChatId(): number | undefined {
		return activeTelegramTurn?.chatId ?? lastKnownChatId ?? config.allowedUserId;
	}

	function formatDialogOptions(options: unknown): string[] {
		if (!Array.isArray(options)) return [];
		return options.flatMap((option: DialogOption, index) => {
			if (typeof option?.label !== "string") return [];
			const description = typeof option.description === "string" && option.description.length > 0
				? ` — ${option.description}`
				: "";
			return [`${index + 1}. ${option.label}${description}`];
		});
	}

	/** Renders the question and numbered options of an `ask_user_choice` call. */
	function formatChoiceDialog(input: Record<string, unknown>): string[] {
		if (typeof input.question !== "string") return [];
		return [input.question, ...formatDialogOptions(input.options)];
	}

	/** Renders every question and its numbered options of an `ask_user_question` call. */
	function formatQuestionnaireDialog(input: Record<string, unknown>): string[] {
		if (!Array.isArray(input.questions)) return [];
		return input.questions.flatMap((question: DialogQuestion, index, all) => {
			if (typeof question?.question !== "string") return [];
			const position = all.length > 1 ? `(${index + 1}/${all.length}) ` : "";
			const multi = question.multiSelect === true ? " [multiple choice]" : "";
			return [`${position}${question.question}${multi}`, ...formatDialogOptions(question.options)];
		});
	}

	function formatDialogAlert(lines: string[], resolved: boolean): string {
		const body = resolved
			? [DIALOG_RESOLVED_HEADER, "", ...lines].join("\n")
			: [DIALOG_ALERT_HEADER, "", ...lines, "", DIALOG_ALERT_FOOTER].join("\n");
		return body.length <= MAX_MESSAGE_LENGTH ? body : `${body.slice(0, MAX_MESSAGE_LENGTH - 1)}…`;
	}

	/**
	 * Announces a blocking terminal dialog. Alerts are unsolicited (no reply
	 * target) because the dialog can be opened by a turn that never came from
	 * Telegram — exactly the case that leaves the session stuck unnoticed.
	 */
	function openDialogAlert(key: string, lines: string[]): void {
		if (!pollingController || dialogAlerts.has(key)) return;
		const chatId = resolveAlertChatId();
		if (chatId === undefined) return;

		const alert: DialogAlert = { chatId, lines, sending: Promise.resolve() };
		alert.sending = (async () => {
			try {
				const sent = await callTelegram<TelegramSentMessage>("sendMessage", {
					chat_id: chatId,
					text: formatDialogAlert(lines, false),
				});
				alert.messageId = sent.message_id;
			} catch {
				// Best effort: a failed alert must never break the dialog itself.
			}
		})();
		dialogAlerts.set(key, alert);
	}

	/** Marks an announced dialog as no longer blocking, editing the original alert in place. */
	async function closeDialogAlert(key: string): Promise<void> {
		const alert = dialogAlerts.get(key);
		if (!alert) return;
		dialogAlerts.delete(key);
		await alert.sending;
		if (alert.messageId === undefined) return;
		try {
			await callTelegram("editMessageText", {
				chat_id: alert.chatId,
				message_id: alert.messageId,
				text: formatDialogAlert(alert.lines, true),
			});
		} catch {
			// Best effort: the alert stays as sent if Telegram rejects the edit.
		}
	}

	async function sendAttachment(chatId: number, attachment: QueuedAttachment): Promise<void> {
		const mediaType = guessMediaType(attachment.path);
		const method = mediaType ? "sendPhoto" : "sendDocument";
		const fieldName = mediaType ? "photo" : "document";
		await callTelegramMultipart<TelegramSentMessage>(
			method,
			{
				chat_id: String(chatId),
			},
			fieldName,
			attachment.path,
			attachment.fileName,
		);
	}

	async function sendQueuedAttachments(turn: ActiveTelegramTurn): Promise<void> {
		for (const attachment of turn.queuedAttachments) {
			try {
				await sendAttachment(turn.chatId, attachment);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				await sendTextReply(turn.chatId, turn.replyToMessageId, `Failed to send attachment ${attachment.fileName}: ${message}`);
			}
		}
	}

	function extractAssistantText(messages: AgentMessage[]): { text?: string; stopReason?: string; errorMessage?: string } {
		for (let i = messages.length - 1; i >= 0; i--) {
			// SAFETY: AgentMessage is a union whose variants do not all declare these fields; each one is type-checked at runtime below.
			const message = messages[i] as unknown as Record<string, unknown>;
			if (message.role !== "assistant") continue;
			const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
			const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
			const content = Array.isArray(message.content) ? message.content : [];
			const text = content
				.filter((block): block is { type: string; text?: string } => typeof block === "object" && block !== null && "type" in block)
				.filter((block) => block.type === "text" && typeof block.text === "string")
				.map((block) => block.text as string)
				.join("")
				.trim();
			return { text: text || undefined, stopReason, errorMessage };
		}
		return {};
	}

	function collectTelegramFileInfos(messages: TelegramMessage[]): TelegramFileInfo[] {
		const files: TelegramFileInfo[] = [];
		for (const message of messages) {
			if (Array.isArray(message.photo) && message.photo.length > 0) {
				const photo = [...message.photo].sort((a, b) => (a.file_size ?? 0) - (b.file_size ?? 0)).pop();
				if (photo) {
					files.push({
						file_id: photo.file_id,
						fileName: `photo-${message.message_id}.jpg`,
						mimeType: "image/jpeg",
						isImage: true,
					});
				}
			}
			if (message.document) {
				const fileName = message.document.file_name || `document-${message.message_id}${guessExtensionFromMime(message.document.mime_type, "")}`;
				files.push({
					file_id: message.document.file_id,
					fileName,
					mimeType: message.document.mime_type,
					isImage: isImageMimeType(message.document.mime_type),
				});
			}
			if (message.video) {
				const fileName = message.video.file_name || `video-${message.message_id}${guessExtensionFromMime(message.video.mime_type, ".mp4")}`;
				files.push({
					file_id: message.video.file_id,
					fileName,
					mimeType: message.video.mime_type,
					isImage: false,
				});
			}
			if (message.audio) {
				const fileName = message.audio.file_name || `audio-${message.message_id}${guessExtensionFromMime(message.audio.mime_type, ".mp3")}`;
				files.push({
					file_id: message.audio.file_id,
					fileName,
					mimeType: message.audio.mime_type,
					isImage: false,
				});
			}
			if (message.voice) {
				files.push({
					file_id: message.voice.file_id,
					fileName: `voice-${message.message_id}${guessExtensionFromMime(message.voice.mime_type, ".ogg")}`,
					mimeType: message.voice.mime_type,
					isImage: false,
				});
			}
			if (message.animation) {
				const fileName = message.animation.file_name || `animation-${message.message_id}${guessExtensionFromMime(message.animation.mime_type, ".mp4")}`;
				files.push({
					file_id: message.animation.file_id,
					fileName,
					mimeType: message.animation.mime_type,
					isImage: false,
				});
			}
			if (message.sticker) {
				files.push({
					file_id: message.sticker.file_id,
					fileName: `sticker-${message.message_id}.webp`,
					mimeType: "image/webp",
					isImage: true,
				});
			}
		}
		return files;
	}

	async function buildTelegramFiles(messages: TelegramMessage[]): Promise<DownloadedTelegramFile[]> {
		const downloaded: DownloadedTelegramFile[] = [];
		for (const file of collectTelegramFileInfos(messages)) {
			const path = await downloadTelegramFile(file.file_id, file.fileName);
			downloaded.push({ path, fileName: file.fileName, isImage: file.isImage, mimeType: file.mimeType });
		}
		return downloaded;
	}

	async function promptForConfig(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI || setupInProgress) return;
		setupInProgress = true;
		try {
			const token = await ctx.ui.input("Telegram bot token", "123456:ABCDEF...");
			if (!token) return;

			const nextConfig: TelegramConfig = { ...config, botToken: token.trim() };
			const response = await fetch(`https://api.telegram.org/bot${nextConfig.botToken}/getMe`);
			const data = (await response.json()) as TelegramApiResponse<TelegramUser>;
			if (!data.ok || !data.result) {
				ctx.ui.notify(data.description || "Invalid Telegram bot token", "error");
				return;
			}

			nextConfig.botId = data.result.id;
			nextConfig.botUsername = data.result.username;
			config = nextConfig;
			await unblockConfigWrites();
			configError = undefined;
			await writeConfig(config);
			ctx.ui.notify(`Telegram bot connected: @${config.botUsername ?? "unknown"}`, "info");
			ctx.ui.notify("Send /start to your bot in Telegram to pair this extension with your account.", "info");
			await startPolling(ctx);
			updateStatus(ctx);
		} finally {
			setupInProgress = false;
		}
	}

	async function stopPolling(): Promise<void> {
		stopTypingLoop();
		pollingController?.abort();
		pollingController = undefined;
		await pollingPromise?.catch(() => undefined);
		pollingPromise = undefined;
	}

	function formatTelegramHistoryText(rawText: string, files: DownloadedTelegramFile[]): string {
		let summary = rawText.length > 0 ? rawText : "(no text)";
		if (files.length > 0) {
			summary += `\nAttachments:`;
			for (const file of files) {
				summary += `\n- ${file.path}`;
			}
		}
		return summary;
	}

	async function createTelegramTurn(
		messages: TelegramMessage[],
		updateIds: number[],
		historyTurns: PendingTelegramTurn[] = [],
	): Promise<PendingTelegramTurn> {
		const firstMessage = messages[0];
		if (!firstMessage) throw new Error("Missing Telegram message for turn creation");
		const rawText = messages.map((message) => (message.text || message.caption || "").trim()).filter(Boolean).join("\n\n");
		const files = await buildTelegramFiles(messages);
		const content: Array<TextContent | ImageContent> = [];
		let prompt = `${TELEGRAM_PREFIX}`;

		if (historyTurns.length > 0) {
			prompt += `\n\nEarlier Telegram messages arrived after an aborted turn. Treat them as prior user messages, in order:`;
			for (const [index, turn] of historyTurns.entries()) {
				prompt += `\n\n${index + 1}. ${turn.historyText}`;
			}
			prompt += `\n\nCurrent Telegram message:`;
		}

		if (rawText.length > 0) {
			prompt += historyTurns.length > 0 ? `\n${rawText}` : ` ${rawText}`;
		}
		if (files.length > 0) {
			prompt += `\n\nTelegram attachments were saved locally:`;
			for (const file of files) {
				prompt += `\n- ${file.path}`;
			}
		}
		content.push({ type: "text", text: prompt });

		for (const file of files) {
			if (!file.isImage) continue;
			const mediaType = file.mimeType || guessMediaType(file.path);
			if (!mediaType) continue;
			const buffer = await readFile(file.path);
			content.push({
				type: "image",
				data: buffer.toString("base64"),
				mimeType: mediaType,
			});
		}

		return {
			// Folded history turns are answered here, so their updates ride along.
			updateIds: [...historyTurns.flatMap((turn) => turn.updateIds), ...updateIds],
			chatId: firstMessage.chat.id,
			replyToMessageId: firstMessage.message_id,
			queuedAttachments: [],
			content,
			historyText: formatTelegramHistoryText(rawText, files),
		};
	}

	async function dispatchAuthorizedTelegramMessages(messages: TelegramMessage[], updateIds: number[], ctx: ExtensionContext): Promise<void> {
		const firstMessage = messages[0];
		if (!firstMessage) return;
		const rawText = messages.map((message) => (message.text || message.caption || "").trim()).find((text) => text.length > 0) || "";
		const lower = rawText.toLowerCase();

		if (lower === "stop" || lower === "/stop") {
			if (currentAbort) {
				if (queuedTelegramTurns.length > 0) {
					preserveQueuedTurnsAsHistory = true;
				}
				currentAbort();
				updateStatus(ctx);
				await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "Aborted current turn.");
			} else {
				await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "No active turn.");
			}
			return;
		}

		if (lower === "/compact") {
			if (!ctx.isIdle()) {
				await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "Cannot compact while pi is busy. Send \"stop\" first.");
				return;
			}
			ctx.compact({
				onComplete: () => {
					void sendTextReply(firstMessage.chat.id, firstMessage.message_id, "Compaction completed.");
				},
				onError: (error) => {
					const message = error instanceof Error ? error.message : String(error);
					void sendTextReply(firstMessage.chat.id, firstMessage.message_id, `Compaction failed: ${message}`);
				},
			});
			await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "Compaction started.");
			return;
		}

		if (lower === "/status") {
			let totalInput = 0;
			let totalOutput = 0;
			let totalCacheRead = 0;
			let totalCacheWrite = 0;
			let totalCost = 0;

			for (const entry of ctx.sessionManager.getEntries()) {
				if (entry.type !== "message" || entry.message.role !== "assistant") continue;
				totalInput += entry.message.usage.input;
				totalOutput += entry.message.usage.output;
				totalCacheRead += entry.message.usage.cacheRead;
				totalCacheWrite += entry.message.usage.cacheWrite;
				totalCost += entry.message.usage.cost.total;
			}

			const usage = ctx.getContextUsage();
			const lines: string[] = [];
			if (ctx.model) {
				lines.push(`Model: ${ctx.model.provider}/${ctx.model.id}`);
			}
			const tokenParts: string[] = [];
			if (totalInput) tokenParts.push(`↑${formatTokens(totalInput)}`);
			if (totalOutput) tokenParts.push(`↓${formatTokens(totalOutput)}`);
			if (totalCacheRead) tokenParts.push(`R${formatTokens(totalCacheRead)}`);
			if (totalCacheWrite) tokenParts.push(`W${formatTokens(totalCacheWrite)}`);
			if (tokenParts.length > 0) {
				lines.push(`Usage: ${tokenParts.join(" ")}`);
			}
			const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
			if (totalCost || usingSubscription) {
				lines.push(`Cost: $${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
			}
			if (usage) {
				const contextWindow = usage.contextWindow ?? ctx.model?.contextWindow ?? 0;
				const percent = usage.percent !== null ? `${usage.percent.toFixed(1)}%` : "?";
				lines.push(`Context: ${percent}/${formatTokens(contextWindow)}`);
			} else {
				lines.push("Context: unknown");
			}
			if (lines.length === 0) {
				lines.push("No usage data yet.");
			}
			await sendTextReply(firstMessage.chat.id, firstMessage.message_id, lines.join("\n"));
			return;
		}

		if (lower === "/help" || lower === "/start") {
			await sendTextReply(
				firstMessage.chat.id,
				firstMessage.message_id,
				`Send me a message and I will forward it to pi. Commands: /status, /compact, stop.`,
			);
			if (config.allowedUserId === undefined && firstMessage.from) {
				config.allowedUserId = firstMessage.from.id;
				await writeConfig(config);
				updateStatus(ctx);
			}
			return;
		}

		const historyTurns = preserveQueuedTurnsAsHistory ? queuedTelegramTurns.splice(0) : [];
		preserveQueuedTurnsAsHistory = false;
		const turn = await createTelegramTurn(messages, updateIds, historyTurns);
		for (const id of turn.updateIds) retainedUpdateIds.add(id);
		queuedTelegramTurns.push(turn);
		dispatchNextQueuedTelegramTurn(ctx);

		// Only announce when this message is really waiting. A turn handed to pi is
		// at the head of the queue with a request already in flight; anything else
		// sits behind a busy run and the sender deserves to know.
		const startedNow = telegramTurnRequested && queuedTelegramTurns[0] === turn;
		if (startedNow) return;
		await announceBusy(firstMessage, queuedTelegramTurns.indexOf(turn) + 1, ctx);
	}

	/**
	 * One notice per queued turn (not per photo: a media group is a single turn).
	 * A failed send is reported and leaves the flag down, so the next message
	 * still gets the long explanation, but never affects the queued turn.
	 */
	async function announceBusy(message: TelegramMessage, queuePosition: number, ctx: ExtensionContext): Promise<void> {
		try {
			await sendTextReply(message.chat.id, message.message_id, formatBusyNotice(queuePosition, !busyNoticeSent));
			busyNoticeSent = true;
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			updateStatus(ctx, `busy notice failed: ${reason}`);
		}
	}

	/** A drained queue ends the busy period, so the next one opens with the long notice again. */
	function resetBusyNoticeIfDrained(): void {
		if (!activeTelegramTurn && queuedTelegramTurns.length === 0) {
			busyNoticeSent = false;
		}
	}

	async function handleAuthorizedTelegramMessage(message: TelegramMessage, updateId: number, ctx: ExtensionContext): Promise<void> {
		if (message.media_group_id) {
			const key = `${message.chat.id}:${message.media_group_id}`;
			const existing = mediaGroups.get(key) ?? { messages: [], updateIds: [] };
			existing.messages.push(message);
			existing.updateIds.push(updateId);
			// Retained while debounced, so a later update cannot move the watermark past it.
			retainedUpdateIds.add(updateId);
			if (existing.flushTimer) clearTimeout(existing.flushTimer);
			existing.flushTimer = setTimeout(() => {
				const state = mediaGroups.get(key);
				mediaGroups.delete(key);
				if (!state) return;
				void dispatchAuthorizedTelegramMessages(state.messages, state.updateIds, ctx)
					.catch((error) => updateStatus(ctx, error instanceof Error ? error.message : String(error)))
					.finally(() => {
						// Handed to a turn: that turn completes them. Otherwise (command or failure) they are done now.
						const held = [...queuedTelegramTurns, activeTelegramTurn].some((turn) => turn?.updateIds.includes(state.updateIds[0]!));
						if (!held) void completeUpdates(state.updateIds);
					});
			}, TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS);
			mediaGroups.set(key, existing);
			return;
		}

		await dispatchAuthorizedTelegramMessages([message], [updateId], ctx);
	}

	/**
	 * Without the notice the user would never learn the message was dropped, so a failed one is
	 * retried: the update stays unacknowledged and its redelivery comes back here, still not run.
	 * Failures never throw, so the updates behind it are processed meanwhile. The retries stop
	 * after INTERRUPTED_NOTICE_MAX_ATTEMPTS, or at once when Telegram rejects the notice for good.
	 */
	async function sendInterruptedNotice(message: TelegramMessage, updateId: number, ctx: ExtensionContext): Promise<"done" | "retry"> {
		try {
			await sendTextReply(message.chat.id, message.message_id, formatInterruptedNotice(message.text || message.caption || ""));
			return "done";
		} catch (error) {
			const attempts = (config.interruptedNoticeAttempts?.[String(updateId)] ?? 0) + 1;
			const reason = error instanceof Error ? error.message : String(error);
			if (!isPermanentTelegramError(error) && attempts < INTERRUPTED_NOTICE_MAX_ATTEMPTS) {
				config.interruptedNoticeAttempts = { ...config.interruptedNoticeAttempts, [String(updateId)]: attempts };
				await writeConfig(config);
				retainedUpdateIds.add(updateId);
				interruptedNoticeRetryAt.set(updateId, Date.now() + INTERRUPTED_NOTICE_RETRY_MS);
				return "retry";
			}
			const dropped = `interruption notice for update ${updateId} dropped after ${attempts} attempt(s): ${reason}`;
			console.error(`pi-telegram: ${dropped}`);
			updateStatus(ctx, dropped);
			return "done";
		}
	}

	async function handleUpdate(update: TelegramUpdate, ctx: ExtensionContext): Promise<void> {
		const message = update.message || update.edited_message;
		if (!message || message.chat.type !== "private" || !message.from || message.from.is_bot) return;

		if (config.allowedUserId === undefined) {
			config.allowedUserId = message.from.id;
			await writeConfig(config);
			updateStatus(ctx);
			await sendTextReply(message.chat.id, message.message_id, "Telegram bridge paired with this account.");
		}

		lastKnownChatId = message.chat.id;

		if (message.from.id !== config.allowedUserId) {
			await sendTextReply(message.chat.id, message.message_id, "This bot is not authorized for your account.");
			return;
		}

		// Its turn was already running when pi stopped: never run it twice. Not retained, so
		// pollLoop acknowledges it right after this return. One notice per media group.
		if ((config.startedUpdateIds ?? []).includes(update.update_id)) {
			const groupKey = message.media_group_id ? `${message.chat.id}:${message.media_group_id}` : undefined;
			// A sibling may have notified the group while this item waited for a retry, so the
			// skip must release it too: a retained id is never acknowledged and pins the offset.
			const notified = groupKey !== undefined && interruptedGroupsNotified.has(groupKey);
			if (!notified && await sendInterruptedNotice(message, update.update_id, ctx) === "retry") return;
			if (groupKey) interruptedGroupsNotified.add(groupKey);
			retainedUpdateIds.delete(update.update_id);
			interruptedNoticeRetryAt.delete(update.update_id);
			return;
		}

		await handleAuthorizedTelegramMessage(message, update.update_id, ctx);
	}

	async function pollLoop(ctx: ExtensionContext, signal: AbortSignal): Promise<void> {
		if (!config.botToken) return;

		try {
			await callTelegram("deleteWebhook", { drop_pending_updates: false }, { signal });
		} catch {
			// ignore
		}
		await sendPendingRestoreNotice(signal);

		if (config.lastUpdateId === undefined) {
			try {
				const updates = await callTelegram<TelegramUpdate[]>("getUpdates", { offset: -1, limit: 1, timeout: 0 }, { signal });
				const last = updates.at(-1);
				if (last) {
					config.lastUpdateId = last.update_id;
					await writeConfig(config);
				}
			} catch {
				// ignore
			}
		}

		while (!signal.aborted) {
			try {
				// Refreshed before every long poll (30 s), so a watcher can treat a
				// marker older than a couple of poll cycles as "pi is not listening".
				await writeHeartbeat();
				// The write above yields, so the bridge may have been disconnected meanwhile:
				// re-check before opening a 30 s poll with an already aborted signal.
				if (signal.aborted) return;
				// A getUpdates offset acknowledges everything below it, so it must never
				// pass the watermark: queued turns stay with Telegram until they finish.
				const updates = await callTelegram<TelegramUpdate[]>(
					"getUpdates",
					{
						offset: config.lastUpdateId !== undefined ? config.lastUpdateId + 1 : undefined,
						limit: GET_UPDATES_LIMIT,
						timeout: 30,
						allowed_updates: ["message", "edited_message"],
					},
					{ signal },
				);
				let receivedNew = false;
				for (const update of updates) {
					const id = update.update_id;
					if (highestSeenUpdateId === undefined || id > highestSeenUpdateId) highestSeenUpdateId = id;
					if (isUpdateKnown(id)) continue;
					receivedNew = true;
					try {
						await handleUpdate(update, ctx);
					} finally {
						// Commands, rejections and failures finish here; turns finish in agent_end.
						if (!retainedUpdateIds.has(id)) await completeUpdates([id]);
					}
				}
				if (updates.length > 0 && !receivedNew) await abortableDelay(KNOWN_UPDATES_REPOLL_MS, signal);
			} catch (error) {
				if (signal.aborted) return;
				if (error instanceof DOMException && error.name === "AbortError") return;
				const message = error instanceof Error ? error.message : String(error);
				updateStatus(ctx, message);
				await new Promise((resolve) => setTimeout(resolve, 3000));
				updateStatus(ctx);
			}
		}
	}

	async function startPolling(ctx: ExtensionContext): Promise<void> {
		if (!config.botToken || pollingPromise) return;
		pollingController = new AbortController();
		pollingPromise = pollLoop(ctx, pollingController.signal).finally(async () => {
			pollingPromise = undefined;
			pollingController = undefined;
			await removeHeartbeat();
			updateStatus(ctx);
		});
		updateStatus(ctx);
	}

	pi.registerTool({
		name: "telegram_attach",
		label: "Telegram Attach",
		description: "Queue one or more local files to be sent with the next Telegram reply (or with the next telegram_send call when no Telegram turn is active).",
		promptSnippet: "Queue local files to be sent with the next Telegram reply.",
		promptGuidelines: [
			"When handling a [telegram] message and the user asked for a file or generated artifact, call telegram_attach with the local path instead of only mentioning the path in text.",
		],
		parameters: Type.Object({
			paths: Type.Array(Type.String({ description: "Local file path to attach" }), { minItems: 1, maxItems: MAX_ATTACHMENTS_PER_TURN }),
		}),
		async execute(_toolCallId, params) {
			// Outside a Telegram turn there is no final reply to carry the files, so they wait
			// for the next telegram_send instead.
			const queue = activeTelegramTurn ? activeTelegramTurn.queuedAttachments : pendingSendAttachments;
			const added: string[] = [];
			for (const inputPath of params.paths) {
				const stats = await stat(inputPath);
				if (!stats.isFile()) {
					throw new Error(`Not a file: ${inputPath}`);
				}
				if (queue.length >= MAX_ATTACHMENTS_PER_TURN) {
					throw new Error(`Attachment limit reached (${MAX_ATTACHMENTS_PER_TURN})`);
				}
				queue.push({ path: inputPath, fileName: basename(inputPath) });
				added.push(inputPath);
			}
			const target = activeTelegramTurn ? "the next Telegram reply" : "the next telegram_send call";
			return {
				content: [{ type: "text", text: `Queued ${added.length} Telegram attachment(s) for ${target}.` }],
				details: { paths: added },
			};
		},
	});

	pi.registerTool({
		name: "telegram_send",
		label: "Telegram Send",
		description:
			"Send a message (and optional local files) to the paired Telegram chat right now, even when the current turn did not come from Telegram.",
		promptSnippet: "Proactively message the paired Telegram user, outside a Telegram turn.",
		promptGuidelines: [
			"Use telegram_send when the Telegram user must learn something and the current message did not come from Telegram (e.g. a notice from another session). Replies to [telegram] messages are delivered automatically; do not duplicate them with telegram_send.",
		],
		parameters: Type.Object({
			text: Type.String({ description: "Message text to send" }),
			attachments: Type.Optional(
				Type.Array(Type.String({ description: "Local file path to send after the text" }), { maxItems: MAX_ATTACHMENTS_PER_TURN }),
			),
		}),
		async execute(_toolCallId, params) {
			if (!config.botToken) {
				throw new Error("Telegram bridge is not configured. Run /telegram-setup in the pi terminal.");
			}
			if (!pollingController) {
				throw new Error("Telegram bridge is not connected. Run /telegram-connect in the pi terminal; nothing was sent.");
			}
			const chatId = resolveAlertChatId();
			if (chatId === undefined) {
				throw new Error("Telegram bridge is not paired with any chat yet. Send /start to the bot first; nothing was sent.");
			}

			const attachments: QueuedAttachment[] = [...pendingSendAttachments];
			for (const inputPath of params.attachments ?? []) {
				const stats = await stat(inputPath);
				if (!stats.isFile()) {
					throw new Error(`Not a file: ${inputPath}`);
				}
				attachments.push({ path: inputPath, fileName: basename(inputPath) });
			}
			if (attachments.length > MAX_ATTACHMENTS_PER_TURN) {
				throw new Error(`Attachment limit reached (${MAX_ATTACHMENTS_PER_TURN})`);
			}
			const text = params.text.trim();
			if (!text && attachments.length === 0) {
				throw new Error("telegram_send needs non-empty text or at least one attachment");
			}

			let messages = 0;
			if (text) {
				for (const chunk of chunkParagraphs(text)) {
					await callTelegram<TelegramSentMessage>("sendMessage", { chat_id: chatId, text: chunk });
					messages++;
				}
			}
			// The queued files are consumed by this call whether or not each upload succeeds;
			// failures are reported back so the agent can retry them explicitly.
			pendingSendAttachments = [];
			const failed: string[] = [];
			for (const attachment of attachments) {
				try {
					await sendAttachment(chatId, attachment);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					failed.push(`${attachment.path}: ${message}`);
				}
			}

			const sentFiles = attachments.length - failed.length;
			const summary = `Sent ${messages} Telegram message(s) and ${sentFiles} attachment(s) to chat ${chatId}.`;
			if (failed.length > 0) {
				throw new Error(`${summary} Failed attachments:\n${failed.join("\n")}`);
			}
			return {
				content: [{ type: "text", text: summary }],
				details: { chatId, messages, attachments: attachments.map((attachment) => attachment.path) },
			};
		},
	});

	pi.registerCommand("telegram-setup", {
		description: "Configure Telegram bot token",
		handler: async (_args, ctx) => {
			await promptForConfig(ctx);
		},
	});

	pi.registerCommand("telegram-status", {
		description: "Show Telegram bridge status",
		handler: async (_args, ctx) => {
			const status = [
				`bot: ${config.botUsername ? `@${config.botUsername}` : "not configured"}`,
				`allowed user: ${config.allowedUserId ?? "not paired"}`,
				`polling: ${pollingPromise ? "running" : "stopped"}`,
				`active telegram turn: ${activeTelegramTurn ? "yes" : "no"}`,
				`queued telegram turns: ${queuedTelegramTurns.length}`,
			];
			ctx.ui.notify(status.join(" | "), "info");
		},
	});

	pi.registerCommand("telegram-connect", {
		description: "Start the Telegram bridge in this pi session",
		handler: async (_args, ctx) => {
			// Already polling (for example autoconnected at session_start): reloading the file here
			// would replace the in-memory config under the poll loop and undo its latest changes.
			if (pollingPromise) {
				updateStatus(ctx, configError);
				return;
			}
			await loadConfig();
			if (!config.botToken) {
				await promptForConfig(ctx);
				return;
			}
			await startPolling(ctx);
			updateStatus(ctx);
		},
	});

	pi.registerCommand("telegram-disconnect", {
		description: "Stop the Telegram bridge in this pi session",
		handler: async (_args, ctx) => {
			await stopPolling();
			updateStatus(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await loadConfig();
		await mkdir(TEMP_DIR, { recursive: true });
		if (process.env.PI_TELEGRAM_AUTOCONNECT === "1" && config.botToken) {
			await startPolling(ctx);
		}
		updateStatus(ctx, configError);
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		// Unfinished turns are dropped here on purpose: their updates were never
		// acknowledged, so the next session receives them again from Telegram.
		queuedTelegramTurns = [];
		retainedUpdateIds.clear();
		highestSeenUpdateId = undefined;
		pendingSendAttachments = [];
		dialogAlerts.clear();
		for (const state of mediaGroups.values()) {
			if (state.flushTimer) clearTimeout(state.flushTimer);
		}
		mediaGroups.clear();
		interruptedGroupsNotified.clear();
		interruptedNoticeRetryAt.clear();
		if (activeTelegramTurn) {
			await clearPreview(activeTelegramTurn.chatId);
		}
		activeTelegramTurn = undefined;
		telegramTurnRequested = false;
		currentAbort = undefined;
		preserveQueuedTurnsAsHistory = false;
		busyNoticeSent = false;
		await stopPolling();
	});

	pi.on("before_agent_start", async (event) => {
		const suffix = isTelegramPrompt(event.prompt)
			? `${SYSTEM_PROMPT_SUFFIX}\n- The current user message came from Telegram.`
			: SYSTEM_PROMPT_SUFFIX;
		return {
			systemPrompt: event.systemPrompt + suffix,
		};
	});

	pi.on("agent_start", async (_event, ctx) => {
		currentAbort = () => ctx.abort();
		telegramTurnRequested = false;
		latestAnswerDelivered = false;
		if (!activeTelegramTurn && queuedTelegramTurns.length > 0) {
			const nextTurn = queuedTelegramTurns.shift();
			if (nextTurn) {
				activeTelegramTurn = { ...nextTurn };
				startPreviewState(nextTurn.replyToMessageId);
				startTypingLoop(ctx);
				await markUpdatesStarted(nextTurn.updateIds);
			}
		}
		updateStatus(ctx);
	});

	pi.on("message_start", async (event, _ctx) => {
		if (!activeTelegramTurn || !isAssistantMessage(event.message)) return;
		latestAnswerDelivered = false;
		if (previewState && (previewState.pendingText.trim().length > 0 || previewState.lastSentText.trim().length > 0)) {
			// Carry the same Telegram message across every assistant text segment of this turn
			// (tool calls open new segments) instead of finalizing/sending a new message per segment.
			await flushPreview(activeTelegramTurn.chatId);
			if (previewState?.flushTimer) {
				clearTimeout(previewState.flushTimer);
			}
			previewState = {
				mode: previewState.mode,
				messageId: previewState.messageId,
				replyToMessageId: activeTelegramTurn.replyToMessageId,
				pendingText: "",
				lastSentText: previewState.lastSentText,
			};
			return;
		}
		startPreviewState(activeTelegramTurn.replyToMessageId);
	});

	pi.on("message_update", async (event, _ctx) => {
		if (!activeTelegramTurn || !isAssistantMessage(event.message)) return;
		const state = previewState ?? startPreviewState(activeTelegramTurn.replyToMessageId);
		state.pendingText = getMessageText(event.message);
		schedulePreviewFlush(activeTelegramTurn.chatId);
	});

	// An assistant message that ends without a tool call is a complete answer. Follow-up
	// messages (for example intercom notices) can still extend the same run, and each of
	// them gets its own answer. Delivering the answer here detaches the preview message, so
	// the next answer starts a new Telegram message instead of editing this one away.
	pi.on("message_end", async (event, _ctx) => {
		const turn = activeTelegramTurn;
		if (!turn || !isAssistantMessage(event.message)) return;
		if (!isFinalAnswer(event.message)) return;
		const text = getMessageText(event.message);
		if (!text) return;
		if (text.length <= MAX_MESSAGE_LENGTH) {
			const state = previewState ?? startPreviewState(turn.replyToMessageId);
			state.pendingText = text;
			await finalizePreview(turn.chatId);
		} else {
			await clearPreview(turn.chatId);
			await sendTextReply(turn.chatId, turn.replyToMessageId, text);
		}
		latestAnswerDelivered = true;
		// The user has the answer now, so the update is settled. Waiting for agent_end is
		// not enough: a run that restarts pi (`chief restart`) never reaches it, and the next
		// session would receive and run the same message again. completeUpdates is idempotent,
		// so the second call from agent_end is harmless.
		await completeUpdates(turn.updateIds);
	});

	pi.on("agent_end", async (event, ctx) => {
		const turn = activeTelegramTurn;
		currentAbort = undefined;
		stopTypingLoop();
		activeTelegramTurn = undefined;
		updateStatus(ctx);
		if (!turn) return;
		try {
			await deliverTurnResult(turn, event, ctx);
		} finally {
			// Any ending (answered, failed or aborted by "stop") settles the turn for good.
			await completeUpdates(turn.updateIds);
		}
	});

	async function deliverTurnResult(turn: ActiveTelegramTurn, event: { messages: AgentMessage[] }, ctx: ExtensionContext): Promise<void> {
		const assistant = extractAssistantText(event.messages);
		if (assistant.stopReason === "aborted") {
			await clearPreview(turn.chatId);
			return;
		}
		if (assistant.stopReason === "error") {
			await clearPreview(turn.chatId);
			await sendTextReply(turn.chatId, turn.replyToMessageId, assistant.errorMessage || "Telegram bridge: pi failed while processing the request.");
			return;
		}

		const finalText = assistant.text;
		if (previewState) {
			previewState.pendingText = finalText ?? previewState.pendingText;
		}

		if (latestAnswerDelivered) {
			// message_end already sent the final answer.
			await clearPreview(turn.chatId);
		} else if (finalText && finalText.length <= MAX_MESSAGE_LENGTH) {
			const finalized = await finalizePreview(turn.chatId);
			if (!finalized && turn.queuedAttachments.length > 0 && !finalText) {
				await sendTextReply(turn.chatId, turn.replyToMessageId, "Attached requested file(s).");
			}
		} else {
			await clearPreview(turn.chatId);
			if (finalText) {
				await sendTextReply(turn.chatId, turn.replyToMessageId, finalText);
			} else if (turn.queuedAttachments.length > 0) {
				await sendTextReply(turn.chatId, turn.replyToMessageId, "Attached requested file(s).");
			}
		}

		latestAnswerDelivered = false;
		await sendQueuedAttachments(turn);

		// Best effort only: pi still reports the run as active during agent_end, so the
		// isIdle() guard in dispatchNextQueuedTelegramTurn rejects this call. The queue is
		// actually drained from agent_settled below.
		dispatchNextQueuedTelegramTurn(ctx);
		stopTypingLoopIfInactive();
		resetBusyNoticeIfDrained();
	}

	// pi clears its run flag at the start of agent_settled and only then emits it, so this
	// is the first point where ctx.isIdle() is true after a turn. Dispatching only from
	// agent_end left every turn queued during a busy run waiting for the next incoming
	// Telegram message to trigger a dispatch, which answered each message one message late.
	pi.on("agent_settled", async (_event, ctx) => {
		dispatchNextQueuedTelegramTurn(ctx);
		stopTypingLoopIfInactive();
		resetBusyNoticeIfDrained();
	});

	// A blocking dialog opened by a turn that did not come from Telegram is invisible
	// to the user until they look at the terminal. `tool_call` is the only event that
	// carries the question and its options, so the rich alert is built from there.
	pi.on("tool_call", async (event) => {
		if (!DIALOG_TOOL_NAMES.has(event.toolName)) return;
		const input = event.input as Record<string, unknown>;
		const lines = event.toolName === "ask_user_choice"
			? formatChoiceDialog(input)
			: formatQuestionnaireDialog(input);
		if (lines.length === 0) return;
		openDialogAlert(event.toolCallId, lines);
	});

	pi.on("tool_execution_end", async (event) => {
		if (!DIALOG_TOOL_NAMES.has(event.toolName)) return;
		await closeDialogAlert(event.toolCallId);
	});

	// Catch-all for every other blocking prompt (project trust, and any extension
	// calling ctx.ui.select/confirm/input/editor/custom). The event only carries
	// kind and optional title, so the alert cannot list options here.
	pi.on("ui_prompt_start", async (event) => {
		if (dialogAlerts.size > 0) return;
		const title = typeof event.title === "string" && event.title.length > 0
			? event.title
			: `pi opened a ${event.kind} dialog and is blocked on it.`;
		openDialogAlert(UI_PROMPT_ALERT_KEY, [title]);
	});

	pi.on("ui_prompt_end", async () => {
		await closeDialogAlert(UI_PROMPT_ALERT_KEY);
	});
}
