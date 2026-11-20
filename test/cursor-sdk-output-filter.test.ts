import { Console } from "node:console";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { installCursorSdkOutputFilter, withCursorSdkOutputNoticeHandler, suppressCursorSdkOutput } from "../src/cursor-sdk-output-filter.js";
import { installCursorSdkOutputFilter as installScriptFilter } from "../scripts/lib/cursor-sdk-output-filter.mjs";
import { prepareInstalledBootstrapEmitters } from "./helpers/cursor-sdk-bootstrap.js";
import { writeRawTestEvidence } from "./helpers/raw-test-evidence.mjs";
import { collectOutput } from "./helpers/process-output.js";

// Dependency execution owns signature drift/confinement; sink replay owns byte
// framing/restoration, not the timing of real Agent/backend emissions.
describe("Cursor SDK presentation boundary", () => {
	let installedBootstrapEmitters: Awaited<ReturnType<typeof prepareInstalledBootstrapEmitters>>;
	beforeAll(async () => { installedBootstrapEmitters = await prepareInstalledBootstrapEmitters(); }, 30_000);

	it.each([false, true])("frames installed printer/guard/completion/hook bytes with colors=%s", async (colors) => {
		const output = collectOutput();
		const root = mkdtempSync(join(tmpdir(), "cursor-output-contract-"));
		const home = join(root, "home");
		mkdirSync(join(home, ".cursor/plugins/local"), { recursive: true });
		mkdirSync(join(root, "outside-é"));
		symlinkSync(join(root, "outside-é"), join(home, ".cursor/plugins/local/outside"), process.platform === "win32" ? "junction" : "dir");
		let restore: (() => void) | undefined;
		const previousTerm = process.env.TERM;
		process.env.TERM = "dumb"; // adversarial ambient input must not defeat either selected color mode
		try {
			const sdk = await installedBootstrapEmitters(colors); // bind before interception
			expect(process.env.TERM).toBe("dumb");
			await sdk.inventory();
			expect(Array.from(await sdk.plugins(home))).toEqual([]);
			expect(sdk.readerCalls()).toBe(0);
			const inventory = Buffer.concat(output.stdout), plugin = Buffer.concat(output.stderr);
			expect(inventory.toString()).toMatch(/INFO.*managed_skills.startup_inventory/);
			expect(plugin.toString()).toContain("rejected: symlink target");
			expect(inventory.includes(Buffer.from("\x1b["))).toBe(colors);
			expect(sdk.hookNotices).toEqual([
				...["startup", "resume", "clear", "compact"].map(matcher => `[hooks] SessionStart trigger matcher "${matcher}" is not supported in Cursor, hooks will fire for all triggers`),
				...["manual", "auto"].map(matcher => `[hooks] PreCompact trigger matcher "${matcher}" is not supported in Cursor, hooks will fire for all triggers`),
				'[hooks] Tool "Glob" is not supported in Cursor and will be ignored',
			]);
			output.stdout.length = 0;
			for (const message of sdk.completions) sdk.completion(message);
			const completions = [...output.stdout];
			expect(completions).toHaveLength(3);
			for (let i = 0; i < completions.length; i++) expect(completions[i]!.toString()).toContain(sdk.completions[i]);
			const proof = process.env.PI_CURSOR_BOOTSTRAP_PROOF_DIR;
			if (proof) writeRawTestEvidence(proof, `sdk-capture-${colors ? "ansi" : "plain"}.json`, JSON.stringify({ inventory: inventory.toString(), plugin: plugin.toString(), parserWarning: sdk.parserWarning, completions: completions.map(bytes => bytes.toString()), hookNotices: sdk.hookNotices, readerCalls: sdk.readerCalls() }, null, 2));
			output.stdout.length = output.stderr.length = 0;
			restore = installCursorSdkOutputFilter();
			let callbacks = 0;
			for (const byte of inventory) {
				process.stdout.write(Buffer.from([byte]), () => callbacks++);
				process.stderr.write(Buffer.from([byte]), () => callbacks++);
			}
			process.stdout.write(Buffer.concat([Buffer.from("before\r\n"), inventory, Buffer.from("after🙂\n")]));
			process.stdout.write("\x1b[0mcursor:local · fast:off");
			for (const byte of inventory) process.stdout.write(Buffer.from([byte]));
			for (const bytes of [...completions, ...sdk.hookNotices.map(message => Buffer.from(message + "\r\n"))]) {
				for (const byte of bytes) process.stdout.write(Buffer.from([byte]));
				process.stderr.write(Buffer.concat([bytes, Buffer.from("VISIBLE adjacent\n")]));
			}
			await new Promise<void>(resolve => setImmediate(resolve));
			expect(callbacks).toBe(inventory.length * 2);
			expect(Buffer.concat(output.stderr).toString()).toBe("VISIBLE adjacent\n".repeat(10));
			expect(Buffer.concat(output.stdout)).toEqual(Buffer.from("before\r\nafter🙂\n\x1b[0mcursor:local · fast:off"));
			output.stderr.length = 0;
			for (const byte of plugin) process.stderr.write(Buffer.from([byte]));
			expect(Buffer.concat(output.stderr)).toEqual(plugin); // unowned diagnostic stays visible
			await sdk.inventory();
			await sdk.plugins(home);
			expect(sdk.readerCalls()).toBe(0);
			output.stderr.length = 0;
			const notices: string[] = [];
			await withCursorSdkOutputNoticeHandler((kind, message) => {
				notices.push(kind);
				expect(message.length).toBeLessThan(200);
				expect(message).not.toContain(root);
				expect(message).toMatch(kind === "outsidePlugin" ? /Install it inside that directory/ : /Check the native parser installation/);
			}, async () => { await sdk.plugins(home); process.stderr.write(sdk.parserWarning + "\r\n"); });
			expect(notices).toEqual(["outsidePlugin", "parserUnavailable"]);
			expect(output.stderr).toEqual([]);
			await withCursorSdkOutputNoticeHandler((_kind, message) => { console.warn(message); }, () => suppressCursorSdkOutput(() => sdk.plugins(home)));
			expect(Buffer.concat(output.stderr).toString()).toMatch(/^Cursor skipped a local plugin.*Install it inside that directory/);
			expect(Buffer.concat(output.stderr).toString()).not.toContain(root);
			output.stderr.length = 0;
			const boundWhileInstalled = await installedBootstrapEmitters(colors);
			restore(); restore = undefined;
			expect(Array.from(await boundWhileInstalled.plugins(home))).toEqual([]);
			expect(boundWhileInstalled.readerCalls()).toBe(0);
			expect(Buffer.concat(output.stderr)).toEqual(plugin);
			await sdk.inventory();
			expect(Buffer.concat(output.stdout).toString()).toContain("managed_skills.startup_inventory");
		} finally {
			if (previousTerm === undefined) delete process.env.TERM; else process.env.TERM = previousTerm;
			restore?.(); output.restore(); rmSync(root, { recursive: true, force: true });
		}
	});

	it("matches installed unsupported/unknown Claude event templates without enumerating future names", async () => {
		const sdk = await installedBootstrapEmitters(false);
		const names = ["InstructionsLoaded", "ConfigChange", "WorktreeCreate", "FutureClaudeEvent42"];
		const notices = sdk.claudeEventNotices(Object.fromEntries(
			["Notification", "PermissionRequest", ...names].map(name => [name, []]),
		));
		expect(notices).toEqual([
			...["Notification", "PermissionRequest"].map(name => `[hooks] Claude Code event "${name}" is not supported in Cursor and will be ignored`),
			...names.map(name => `[hooks] Unknown Claude Code event "${name}", skipping`),
		]);
		// Future additions to the SDK's unsupported-event table use the same family.
		const recognized = [...notices, '[hooks] Claude Code event "FutureUnsupportedEvent42" is not supported in Cursor and will be ignored'];
		const invalidValue = sdk.claudeEventNotices({ SessionStart: "invalid" });
		expect(invalidValue).toEqual(['[hooks] Claude Code event "SessionStart" has invalid value (expected array), skipping']);
		const visible = [...invalidValue,
			'[hooks] Unknown Claude Code event "Future" failed to load: permission denied',
			'[hooks] Claude Code event "Future" is not supported in Cursor and will be ignored: failure',
			'[hooks] Unknown Claude Code event "", skipping',
			'[hooks] Unknown Claude Code event "bad"quote", skipping',
			'[hooks] Refusing to load user config via symlink path: /unsafe',
		];
		const output = collectOutput(), restore = installCursorSdkOutputFilter();
		try {
			for (const message of [...recognized, ...visible]) {
				const frame = Buffer.from(`\x1b[33m${message}\x1b[0m\r\n`);
				for (let split = 0; split <= frame.length; split++) {
					process.stdout.write(frame.subarray(0, split));
					process.stdout.write(frame.subarray(split));
					process.stderr.write(frame.subarray(0, split));
					process.stderr.write(frame.subarray(split));
				}
				const expected = recognized.includes(message) ? Buffer.alloc(0) : Buffer.concat(Array.from({ length: frame.length + 1 }, () => frame));
				expect(Buffer.concat(output.stdout)).toEqual(expected);
				expect(Buffer.concat(output.stderr)).toEqual(expected);
				output.stdout.length = output.stderr.length = 0;
			}
		} finally { restore(); output.restore(); }
	});

	it("attributes split frames to the owner and mute at their start and preserves warnings when native reporting fails", async () => {
		const output = collectOutput(), restore = installCursorSdkOutputFilter();
		try {
			const warning = "[local-plugins-bootstrap] loadUserLocalPlugin outside rejected: symlink target /outside is outside /root {}\n";
			const owners: string[] = [];
			withCursorSdkOutputNoticeHandler(() => { owners.push("first"); }, () => process.stderr.write(warning.slice(0, 20)));
			withCursorSdkOutputNoticeHandler(() => { owners.push("second"); }, () => process.stderr.write(warning.slice(20)));
			expect(owners).toEqual(["first"]);
			expect(output.stderr).toEqual([]);
			suppressCursorSdkOutput(() => process.stdout.write("18:05:"));
			process.stdout.write("57.959 INFO  started muted\n");
			process.stdout.write("18:05:");
			suppressCursorSdkOutput(() => process.stdout.write("57.959 INFO  started visible\n"));
			expect(Buffer.concat(output.stdout)).toEqual(Buffer.from("18:05:57.959 INFO  started visible\n"));
			output.stdout.length = 0;
			withCursorSdkOutputNoticeHandler(() => { throw new Error("native reporter failed"); }, () => process.stderr.write(warning));
			expect(Buffer.concat(output.stderr)).toEqual(Buffer.from(warning));
			let callbacks = 0;
			process.stdout.write('[hooks] Tool "Glob" is not supported in Cursor and will be ignored\n', () => callbacks++);
			process.stdout.write("18:05:", () => callbacks++);
			await new Promise<void>(resolve => setImmediate(resolve));
			expect(callbacks).toBe(2);
			restore();
			expect(Buffer.concat(output.stdout)).toEqual(Buffer.from("18:05:"));
		} finally { restore(); output.restore(); }
	});

	it("suppresses SDK frames on a host console that bypasses the process write sinks", () => {
		// A compiled Bun Pi binary resolves the SDK logger's console calls against
		// its own writer, so those bytes never reach process.stdout/stderr. Verified
		// on the shipped pi 1.5.2 binary: patching write alone left every
		// `load completed` frame visible while Node's build hid them.
		const originalConsole = globalThis.console;
		const captured = { stdout: [] as string[], stderr: [] as string[] };
		const hostConsole = {
			log: (...args: unknown[]) => { captured.stdout.push(args.join(" ") + "\n"); },
			info: (...args: unknown[]) => { captured.stdout.push(args.join(" ") + "\n"); },
			warn: (...args: unknown[]) => { captured.stderr.push(args.join(" ") + "\n"); },
			error: (...args: unknown[]) => { captured.stderr.push(args.join(" ") + "\n"); },
		} as unknown as Console;
		globalThis.console = hostConsole;
		let restore: (() => void) | undefined;
		try {
			restore = installCursorSdkOutputFilter();
			// A non-framed console call is swallowed whole while the mute covers it.
			suppressCursorSdkOutput(() => globalThis.console.log("muted", { multi: true }));
			expect(captured.stdout).toEqual([]);
			globalThis.console.log("05:22:47.267 INFO  CursorPluginsAgentSkillsService load completed meta={durationMs: 5, ruleCount: 58, skillCount: 58}");
			globalThis.console.warn("05:22:47.309 INFO  AgentSkillsCursorRulesService load completed meta={durationMs: 47}");
			expect(captured.stdout).toEqual([]);
			expect(captured.stderr).toEqual([]);
			globalThis.console.log("VISIBLE host line");
			expect(captured.stdout.join("")).toBe("VISIBLE host line\n");
			captured.stdout.length = 0;
			suppressCursorSdkOutput(() => globalThis.console.log("05:22:47.267 INFO  muted by creation"));
			expect(captured.stdout).toEqual([]);
			globalThis.console.log("05:22:47.267 INFO  after creation mute");
			expect(captured.stdout.join("")).toBe("05:22:47.267 INFO  after creation mute\n");
		} finally { restore?.(); globalThis.console = originalConsole; }
	});

	it("reports a capability notice on the console path during the creation mute, like the sink", () => {
		// `Agent.create()` runs inside suppressCursorSdkOutput() and reports notices
		// through the same layer. A mute that swallowed them here would lose the
		// warning only on Bun, where this layer is the sole interception point.
		const originalConsole = globalThis.console;
		const captured = collectOutput();
		globalThis.console = {
			log: () => {}, info: () => {}, error: () => {}, warn: () => {},
		} as unknown as Console;
		const warning = "[local-plugins-bootstrap] loadUserLocalPlugin outside rejected: symlink target /outside is outside /root {}";
		let restore: (() => void) | undefined;
		try {
			restore = installCursorSdkOutputFilter();
			const notices: string[] = [];
			withCursorSdkOutputNoticeHandler(kind => { notices.push(kind); }, () =>
				suppressCursorSdkOutput(() => globalThis.console.warn(warning)));
			expect(notices).toEqual(["outsidePlugin"]);
			expect(Buffer.concat(captured.stderr)).toEqual(Buffer.alloc(0)); // the reporter owns rendering it
			// An owner that declines to render must not turn the warning into silence.
			withCursorSdkOutputNoticeHandler(() => false, () => globalThis.console.warn(warning));
			expect(Buffer.concat(captured.stderr).toString()).toBe(`${warning}\n`);
		} finally { restore?.(); captured.restore(); globalThis.console = originalConsole; }
	});

	it("reports one console notice once and rebinds a host console swapped after install", () => {
		const originalConsole = globalThis.console;
		const output = collectOutput();
		let restore: (() => void) | undefined;
		try {
			// A Node-shaped console writes through the patched sinks, so a missing
			// hand-off would classify and report the same frame twice.
			globalThis.console = new Console({ stdout: process.stdout, stderr: process.stderr, colorMode: false });
			restore = installCursorSdkOutputFilter();
			let reports = 0;
			withCursorSdkOutputNoticeHandler(() => { reports += 1; }, () =>
				globalThis.console.warn("[local-plugins-bootstrap] loadUserLocalPlugin x rejected: symlink target /o is outside /r {}"));
			expect(reports).toBe(1);
			expect(Buffer.concat(output.stderr)).toEqual(Buffer.alloc(0));

			// A host may swap its console after the lease opened (worker stdio, TUI).
			// The next lease must filter the new object, not the stale one.
			const swapped = { stdout: [] as string[], stderr: [] as string[] };
			globalThis.console = {
				log: (...args: unknown[]) => { swapped.stdout.push(args.join(" ")); },
				info: (...args: unknown[]) => { swapped.stdout.push(args.join(" ")); },
				warn: (...args: unknown[]) => { swapped.stderr.push(args.join(" ")); },
				error: (...args: unknown[]) => { swapped.stderr.push(args.join(" ")); },
			} as unknown as Console;
			const rebound = installCursorSdkOutputFilter();
			try {
				globalThis.console.log("05:22:47.267 INFO  CursorPluginsAgentSkillsService load completed meta={durationMs: 5}");
				expect(swapped).toEqual({ stdout: [], stderr: [] });
				// A host that replaces one method on the same object retires our
				// wrapper; the next lease rebinds over it instead of leaving it raw.
				const raw = { stdout: [] as string[] };
				(globalThis.console as { log: unknown }).log = (...args: unknown[]) => { raw.stdout.push(args.join(" ")); };
				const reboundAgain = installCursorSdkOutputFilter();
				try {
					globalThis.console.log("05:22:47.267 INFO  CursorPluginsAgentSkillsService load completed meta={durationMs: 6}");
					expect(raw.stdout).toEqual([]);
				} finally { reboundAgain(); }
			} finally { rebound(); }
		} finally { restore?.(); output.restore(); globalThis.console = originalConsole; }
	});

	it("leaves a released console wrapper transparent and does not stack a second one", () => {
		const originalConsole = globalThis.console;
		const captured: string[] = [];
		const warning = "[local-plugins-bootstrap] loadUserLocalPlugin y rejected: symlink target /o is outside /r {}";
		const noise = "05:22:47.267 INFO  CursorPluginsAgentSkillsService load completed meta={durationMs: 5}";
		globalThis.console = {
			log: (...args: unknown[]) => { captured.push(args.join(" ")); }, info: () => {}, warn: () => {}, error: () => {},
		} as unknown as Console;
		let restore: (() => void) | undefined;
		try {
			restore = installCursorSdkOutputFilter();
			// A host that kept its own reference to the method we replaced.
			const retained = globalThis.console.log;
			restore(); restore = undefined;
			retained(warning);
			retained(noise); // a released lease must not filter, not even SDK noise
			expect(captured).toEqual([warning, noise]);
			captured.length = 0;
			// A later lease installs its own wrapper rather than reviving the dead one.
			restore = installCursorSdkOutputFilter();
			expect(globalThis.console.log).not.toBe(retained);
			let reports = 0;
			withCursorSdkOutputNoticeHandler(() => { reports += 1; }, () => globalThis.console.log(warning));
			expect(reports).toBe(1);
			expect(captured).toEqual([]);
		} finally { restore?.(); globalThis.console = originalConsole; }
	});

	it("renders the reporter's formatted echo once instead of swallowing it", () => {
		// A reporter renders the notice by writing it. That nested console call must
		// not be re-decided as a new notice.
		const originalConsole = globalThis.console;
		const captured = collectOutput();
		const warning = "[local-plugins-bootstrap] loadUserLocalPlugin z rejected: symlink target /o is outside /r {}";
		globalThis.console = {
			log: () => {}, info: () => {}, error: () => {},
			warn: (...args: unknown[]) => { process.stderr.write(`${args.join(" ")}\n`); },
		} as unknown as Console;
		let restore: (() => void) | undefined;
		try {
			restore = installCursorSdkOutputFilter();
			let reports = 0;
			withCursorSdkOutputNoticeHandler((_kind, message) => {
				reports += 1;
				globalThis.console.warn(message);
			}, () => globalThis.console.warn(warning));
			expect(reports).toBe(1);
			const written = Buffer.concat(captured.stderr).toString();
			expect(written.match(/Cursor skipped a local plugin/g) ?? []).toHaveLength(1);
		} finally { restore?.(); captured.restore(); globalThis.console = originalConsole; }
	});

	it("does not recurse when a reporter echoes the raw SDK line back through console", () => {
		// The frame being reported is itself a diagnostic on the same console. A
		// nested decision would classify it again and report the same frame forever.
		const originalConsole = globalThis.console;
		const captured = collectOutput();
		const warning = "[local-plugins-bootstrap] loadUserLocalPlugin w rejected: symlink target /o is outside /r {}";
		globalThis.console = {
			log: () => {}, info: () => {}, error: () => {},
			warn: (...args: unknown[]) => { process.stderr.write(`${args.join(" ")}\n`); },
		} as unknown as Console;
		let restore: (() => void) | undefined;
		try {
			restore = installCursorSdkOutputFilter();
			let reports = 0;
			withCursorSdkOutputNoticeHandler(() => {
				reports += 1;
				globalThis.console.warn(warning);
			}, () => globalThis.console.warn(warning));
			expect(reports).toBe(1);
			expect(captured.stderr.length).toBeGreaterThan(0);
		} finally { restore?.(); captured.restore(); globalThis.console = originalConsole; }
	});

	it("keeps a pending sink frame in place when a console frame is decided between writes", () => {
		// The console layer flushes the sink's pending candidate first. Without that,
		// a partial TUI frame swallows the console line into one unclassifiable frame
		// and the capability notice inside it is never reported.
		const output = collectOutput();
		const originalConsole = globalThis.console;
		globalThis.console = { log: () => {}, info: () => {}, warn: () => {}, error: () => {} } as unknown as Console;
		let restore: (() => void) | undefined;
		try {
			restore = installCursorSdkOutputFilter();
			const notices: string[] = [];
			withCursorSdkOutputNoticeHandler(kind => { notices.push(kind); }, () => {
				process.stdout.write("18:05:");
				globalThis.console.log("[local-plugins-bootstrap] loadUserLocalPlugin v rejected: symlink target /a is outside /b {}");
				process.stdout.write("TAIL\n");
			});
			expect(notices).toEqual(["outsidePlugin"]);
			expect(Buffer.concat(output.stdout).toString()).toBe("18:05:TAIL\n");
		} finally { restore?.(); output.restore(); globalThis.console = originalConsole; }
	});

	it("keeps a CRLF console separator when a reported notice is re-emitted", () => {
		// The SDK emits bare lines, but a host may log CRLF. A frame the reporter
		// declines to render must keep its own separator, not become LF-only.
		const originalConsole = globalThis.console;
		const captured = collectOutput();
		const warning = "[local-plugins-bootstrap] loadUserLocalPlugin u rejected: symlink target /o is outside /r {}";
		globalThis.console = { log: () => {}, info: () => {}, warn: () => {}, error: () => {} } as unknown as Console;
		let restore: (() => void) | undefined;
		try {
			restore = installCursorSdkOutputFilter();
			withCursorSdkOutputNoticeHandler(() => false, () => globalThis.console.warn(`${warning}\r\n`));
			expect(Buffer.concat(captured.stderr).toString()).toBe(`${warning}\r\n`);
		} finally { restore?.(); captured.restore(); globalThis.console = originalConsole; }
	});

	it("stays usable when a hardened host console rejects a method patch", () => {
		// SES/lockdown embedders and sandboxed runtimes hand out frozen consoles.
		// Failing to patch one method must not throw from extension load, and it
		// must not leave the process sinks patched with no cleanup behind them.
		const originalConsole = globalThis.console;
		const frozen = Object.freeze({
			log: () => {}, info: () => {}, warn: () => {}, error: () => {},
		}) as unknown as Console;
		globalThis.console = frozen;
		let restore: (() => void) | undefined;
		try {
			expect(() => { restore = installCursorSdkOutputFilter(); }).not.toThrow();
			expect(typeof restore).toBe("function");
		} finally {
			restore?.();
			globalThis.console = originalConsole;
		}
	});

	it("preserves synthetic failures/quoted controls, prompt bytes, invalid UTF-8, encodings and tails", () => {
		const output = collectOutput(true), restore = installCursorSdkOutputFilter();
		try {
			const controls = Buffer.from([
				'[local-plugins-bootstrap] loadUserLocalPlugin example failed: permission denied',
				'[local-plugins-bootstrap] Unexpected plugin exception: Error: denied',
				'[hooks] Refusing to load user config via symlink path: /unsafe',
				'[hooks] All tools in matcher "Glob" are unsupported, skipping hooks',
				'shell-parser: unexpected native parser exception',
				'Error initializing ignore mapping for /workspace: permission denied',
				'Ripgrep path not configured. Call configureRipgrepPath() at startup.',
				'"18:05:57.959 INFO  managed_skills.removed ctx=syncBuiltinSkills"',
				'prefix 18:05:57.959 INFO  managed_skills.removed ctx=syncBuiltinSkills',
				'18:05:57.959 WARN  managed_skills.removed ctx=syncBuiltinSkills',
				'99:99:99.999 INFO  managed_skills.removed ctx=syncBuiltinSkills',
				'18:05:57.959 INFO  managed_skills.startup_inventory_failed ctx=syncBuiltinSkills',
				'\x1b[?25l18:05:57.959 INFO  managed_skills.removed ctx=syncBuiltinSkills',
			].join("\n") + "\n");
			let done = 0;
			expect(process.stdout.write(controls, () => done++)).toBe(false);
			expect(done).toBe(1);
			const prompt = Buffer.from("\x1b[?25lPrompt: λ");
			expect(process.stdout.write(prompt)).toBe(false);
			process.stdout.write(Buffer.from([0xff, 0xc3, 0x28, 0x0a]));
			const invalidFrame = Buffer.concat([Buffer.from('18:05:57.959 INFO  managed_skills.removed meta={skill_id: "'), Buffer.from([0xff]), Buffer.from('"}\n')]);
			expect(process.stdout.write(invalidFrame)).toBe(false);
			process.stdout.write("é", "latin1");
			// The forwarded partial character must not reach the next frame's decoder.
			process.stdout.write("18:05:57.959 INFO  managed_skills.removed ctx=syncBuiltinSkills\n");
			process.stderr.write("18:05:");
			expect(output.stderr).toEqual([]);
			restore();
			expect(Buffer.concat(output.stderr)).toEqual(Buffer.from("18:05:"));
			expect(Buffer.concat(output.stdout)).toEqual(Buffer.concat([controls, prompt, Buffer.from([0xff, 0xc3, 0x28, 0x0a]), invalidFrame, Buffer.from([0xe9])]));
		} finally { restore(); output.restore(); }
	});

	it("does not remove wrappers installed by another owner and deactivates retained filter methods", () => {
		const output = collectOutput(), restore = installCursorSdkOutputFilter();
		const filteredStdout = process.stdout.write, filteredStderr = process.stderr.write;
		const laterStdout: typeof process.stdout.write = function (...args) { return Reflect.apply(filteredStdout, process.stdout, args) as boolean; };
		const laterStderr: typeof process.stderr.write = function (...args) { return Reflect.apply(filteredStderr, process.stderr, args) as boolean; };
		process.stdout.write = laterStdout;
		process.stderr.write = laterStderr;
		try {
			process.stdout.write("18:05:");
			restore();
			expect(process.stdout.write).toBe(laterStdout);
			expect(process.stderr.write).toBe(laterStderr);
			const frame = '[hooks] Unknown Claude Code event "Future", skipping\n';
			process.stdout.write(frame);
			process.stderr.write(frame);
			expect(Buffer.concat(output.stdout).toString()).toBe("18:05:" + frame);
			expect(Buffer.concat(output.stderr).toString()).toBe(frame);
			const reinstall = installCursorSdkOutputFilter();
			process.stdout.write(frame);
			reinstall();
			expect(process.stdout.write).toBe(laterStdout);
			expect(Buffer.concat(output.stdout).toString()).toBe("18:05:" + frame);
		} finally { restore(); output.restore(); }
	});

	it("shares nesting/restoration with scripts, bounds candidates and keeps retained methods live", () => {
		const output = collectOutput();
		const stdoutWrite = process.stdout.write, consoleWarn = console.warn;
		const first = installCursorSdkOutputFilter(), filtered = process.stdout.write;
		const retainedWarn = console.warn.bind(console), second = installScriptFilter();
		try {
			first();
			expect(process.stdout.write).toBe(filtered);
			const oversized = "[local-plugins-bootstrap] loadUserLocalPlugin " + "x".repeat(32_768);
			process.stdout.write(oversized);
			expect(Buffer.concat(output.stdout)).toEqual(Buffer.from(oversized));
			second();
			expect(process.stdout.write).toBe(stdoutWrite);
			expect(console.warn).toBe(consoleWarn);
			retainedWarn("VISIBLE retained console");
			expect(Buffer.concat(output.stderr)).toEqual(Buffer.from("VISIBLE retained console\n"));
		} finally { first(); second(); output.restore(); }
	});
});
