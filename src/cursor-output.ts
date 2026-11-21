function chunkText(chunk: string | Uint8Array): string {
	return typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
}

type StdoutWrite = (
	this: typeof process.stdout,
	chunk: string | Uint8Array,
	encoding?: BufferEncoding | ((error?: Error | null) => void),
	callback?: (error?: Error | null) => void,
) => boolean;

function forwardWrite(
	write: typeof process.stdout.write,
	chunk: string | Uint8Array,
	encoding?: BufferEncoding | ((error?: Error | null) => void),
	callback?: (error?: Error | null) => void,
): boolean {
	// Bun's stdout writer reads `this`. A bare call throws during a TUI redraw.
	const invoke = write as StdoutWrite;
	return invoke.call(process.stdout, chunk, encoding, callback);
}

function dropWrite(
	chunk: string | Uint8Array,
	encoding?: BufferEncoding | ((error?: Error | null) => void),
	callback?: (error?: Error | null) => void,
): boolean {
	if (typeof encoding === "function") encoding();
	else callback?.();
	void chunk;
	return true;
}

const consoleMethods = ["log", "info", "warn", "debug", "error"] as const;

export async function withMutedSdkOutput<T>(run: () => Promise<T>): Promise<T> {
	const stdoutWrite = process.stdout.write;
	const stderrWrite = process.stderr.write;
	const savedConsole = consoleMethods.map((name) => console[name]);
	process.stdout.write = (
		chunk: string | Uint8Array,
		encoding?: BufferEncoding | ((error?: Error | null) => void),
		callback?: (error?: Error | null) => void,
	): boolean => {
		if (chunkText(chunk).includes("\u001b")) return forwardWrite(stdoutWrite, chunk, encoding, callback);
		return dropWrite(chunk, encoding, callback);
	};
	process.stderr.write = dropWrite;
	for (const name of consoleMethods) {
		console[name] = () => undefined;
	}
	try {
		return await run();
	} finally {
		process.stdout.write = stdoutWrite;
		process.stderr.write = stderrWrite;
		for (const [index, name] of consoleMethods.entries()) {
			const saved = savedConsole[index];
			if (saved) console[name] = saved;
		}
	}
}
