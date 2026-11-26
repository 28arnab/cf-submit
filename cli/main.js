#!/usr/bin/env node
// biome-ignore lint/suspicious/noRedundantUseStrict: Node runs this file as CommonJS; keep strict mode enabled.
"use strict";

const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { createHash, randomBytes, timingSafeEqual } = require("node:crypto");

const HOST = "127.0.0.1";
const PORT = 4242;
const VERSION = "1.1.0";
const WAIT_TIMEOUT_MS = 180_000;

const LANG_MAP = new Map([
	[".cpp", "89"], // GNU G++20 64-bit
	[".py", "31"], // Python 3
	[".java", "87"], // Java 21 64-bit
]);

function parseTarget(targetArgs) {
	if (targetArgs.length === 1) {
		const url = targetArgs[0];
		const match =
			url.match(/\/(?:contest|gym)\/(\d+)\/problem\/([A-Za-z0-9]+)/) ||
			url.match(/\/problemset\/problem\/(\d+)\/([A-Za-z0-9]+)/);
		if (match) {
			return {
				contestId: match[1],
				problemIndex: match[2].toUpperCase(),
				isGym: url.includes("/gym/"),
			};
		}
	} else if (targetArgs.length >= 2 && /^\d+$/.test(targetArgs[0])) {
		return {
			contestId: targetArgs[0],
			problemIndex: targetArgs[1].toUpperCase(),
			isGym: Number(targetArgs[0]) >= 100000,
		};
	}
	return null;
}

function extensionOriginFromKey(publicKey) {
	const keyBytes = Buffer.from(publicKey || "", "base64");
	if (keyBytes.length === 0) {
		throw new Error("The extension manifest must contain a public key.");
	}
	const hash = createHash("sha256").update(keyBytes).digest().subarray(0, 16);
	let extensionId = "";
	for (const byte of hash) {
		extensionId += String.fromCharCode(97 + (byte >> 4), 97 + (byte & 0x0f));
	}
	return `chrome-extension://${extensionId}`;
}

function tokenMatches(candidate, expected) {
	if (typeof candidate !== "string" || !/^[a-f0-9]{64}$/.test(candidate))
		return false;
	const candidateBytes = Buffer.from(candidate, "hex");
	const expectedBytes = Buffer.from(expected, "hex");
	return (
		candidateBytes.length === expectedBytes.length &&
		timingSafeEqual(candidateBytes, expectedBytes)
	);
}

function isAllowedOrigin(
	pathname,
	request,
	extensionOrigin,
	bridgeSecret,
	preflight = false,
) {
	const origin = request.headers.origin;
	const extensionOriginMatches = origin === extensionOrigin;
	const noOriginExtensionRequest =
		!origin &&
		request.headers["sec-fetch-site"] === "none" &&
		request.headers["sec-fetch-mode"] === "cors";
	const requestHeaders = (
		request.headers["access-control-request-headers"] || ""
	)
		.split(",")
		.map((header) => header.trim().toLowerCase());
	const extensionPreflight = requestHeaders.includes("x-cf-submit-secret");
	const hasExtensionSecret = tokenMatches(
		request.headers["x-cf-submit-secret"],
		bridgeSecret,
	);

	if (pathname === "/job") {
		return (
			(extensionOriginMatches || noOriginExtensionRequest) &&
			(preflight
				? extensionOriginMatches || extensionPreflight
				: hasExtensionSecret)
		);
	}
	if (pathname === "/status") {
		return (
			origin === "https://codeforces.com" ||
			(extensionOriginMatches && (preflight || hasExtensionSecret)) ||
			(noOriginExtensionRequest &&
				(preflight ? extensionPreflight : hasExtensionSecret))
		);
	}
	return false;
}

function sendJson(response, statusCode, data, origin = null) {
	const body = JSON.stringify(data);
	const headers = {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(body),
	};
	if (origin) {
		headers["Access-Control-Allow-Origin"] = origin;
		headers["Access-Control-Allow-Private-Network"] = "true";
		headers.Vary = "Origin";
	}
	response.writeHead(statusCode, headers);
	response.end(body);
}

function createBridge(job, extensionOrigin, bridgeSecret) {
	let jobClaimed = false;
	let complete;
	let timeout;
	const finished = new Promise((resolve) => {
		complete = resolve;
	});

	const server = http.createServer(async (request, response) => {
		const requestUrl = new URL(request.url, `http://${HOST}:${PORT}`);
		const origin = request.headers.origin;
		if (request.method === "OPTIONS") {
			const requestedMethod = request.headers["access-control-request-method"];
			if (
				!isAllowedOrigin(
					requestUrl.pathname,
					request,
					extensionOrigin,
					bridgeSecret,
					true,
				) ||
				(requestUrl.pathname === "/job" && requestedMethod !== "GET") ||
				(requestUrl.pathname === "/status" && requestedMethod !== "POST")
			) {
				response.writeHead(403);
				response.end();
				return;
			}
			response.writeHead(204, {
				"Access-Control-Allow-Origin": origin || extensionOrigin,
				"Access-Control-Allow-Methods": requestedMethod,
				"Access-Control-Allow-Headers": "Content-Type, X-CF-Submit-Secret",
				"Access-Control-Allow-Private-Network": "true",
				Vary: "Origin",
			});
			response.end();
			return;
		}

		if (request.method === "GET" && requestUrl.pathname === "/job") {
			if (
				!isAllowedOrigin(
					requestUrl.pathname,
					request,
					extensionOrigin,
					bridgeSecret,
				)
			) {
				sendJson(response, 403, { error: "Origin not allowed" });
				return;
			}
			const responseOrigin = origin || extensionOrigin;
			if (jobClaimed) {
				sendJson(response, 200, { has_job: false }, responseOrigin);
			} else {
				jobClaimed = true;
				sendJson(response, 200, { has_job: true, job }, responseOrigin);
			}
			return;
		}

		if (request.method === "POST" && requestUrl.pathname === "/status") {
			if (
				!isAllowedOrigin(
					requestUrl.pathname,
					request,
					extensionOrigin,
					bridgeSecret,
				)
			) {
				sendJson(response, 403, { error: "Origin not allowed" });
				return;
			}
			const responseOrigin = origin || extensionOrigin;
			try {
				let rawBody = "";
				for await (const chunk of request) {
					rawBody += chunk;
					if (rawBody.length > 64 * 1024) {
						sendJson(
							response,
							413,
							{ error: "Request too large" },
							responseOrigin,
						);
						return;
					}
				}
				const body = JSON.parse(rawBody || "{}");
				if (!tokenMatches(body.bridgeToken, job.bridgeToken)) {
					sendJson(
						response,
						403,
						{ error: "Invalid bridge token" },
						responseOrigin,
					);
					return;
				}
				if (typeof body.message === "string" && body.message) {
					process.stdout.write(`${body.message}\n`);
				}
				if (body.done) {
					complete({ exitCode: body.success ? 0 : 1 });
				}
				sendJson(response, 200, { ok: true }, responseOrigin);
			} catch {
				sendJson(response, 400, { error: "Invalid JSON" }, responseOrigin);
			}
			return;
		}

		sendJson(response, 404, { error: "Not found" });
	});

	server.on("clientError", (_error, socket) => {
		socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
	});

	return {
		finished,
		listen: () =>
			new Promise((resolve, reject) => {
				server.once("error", reject);
				server.listen(PORT, HOST, () => {
					server.removeListener("error", reject);
					resolve();
				});
			}),
		wait: () => {
			timeout = setTimeout(
				() => complete({ timedOut: true, exitCode: 1 }),
				WAIT_TIMEOUT_MS,
			);
			return finished;
		},
		close: () => {
			clearTimeout(timeout);
			return new Promise((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections?.();
			});
		},
	};
}

function printHelp() {
	process.stdout.write(
		"Usage: cf submit -f <source-file> <problem-url>\n" +
			"       cf submit -f <source-file> <contest-id> <problem-index>\n" +
			"       cf config\n" +
			"       cf --version\n",
	);
}

async function submit(args) {
	let filePath;
	const targetArgs = [];
	for (let i = 0; i < args.length; i += 1) {
		if (args[i] === "-f" || args[i] === "--file") {
			if (filePath || !args[i + 1]) {
				throw new Error("A single source file must be provided with -f.");
			}
			filePath = args[++i];
		} else if (args[i].startsWith("-")) {
			throw new Error(`Unknown option: ${args[i]}`);
		} else {
			targetArgs.push(args[i]);
		}
	}
	if (!filePath) throw new Error("Missing required -f <source-file> option.");

	const absolutePath = path.resolve(filePath);
	let source;
	try {
		source = await fs.readFile(absolutePath, "utf8");
	} catch (error) {
		throw new Error(
			`Could not read source file '${filePath}': ${error.message}`,
		);
	}
	const ext = path.extname(absolutePath).toLowerCase();
	const programTypeId = LANG_MAP.get(ext);
	if (!programTypeId)
		throw new Error(`Unsupported source extension '${ext || "(none)"}'.`);

	const target = parseTarget(targetArgs);
	if (!target)
		throw new Error(
			`Could not parse target: ${targetArgs.join(" ") || "(missing)"}`,
		);

	let extensionOrigin;
	let bridgeSecret;
	try {
		const manifestPath = path.resolve(__dirname, "../extension/manifest.json");
		const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
		extensionOrigin = extensionOriginFromKey(manifest.key);
		bridgeSecret = require("../extension/bridge-config.js");
		if (
			typeof bridgeSecret !== "string" ||
			!/^[a-f0-9]{64}$/.test(bridgeSecret)
		) {
			throw new Error("The bridge secret is missing or invalid.");
		}
	} catch (error) {
		throw new Error(
			`Could not load extension bridge credentials: ${error.message}`,
		);
	}

	const job = {
		...target,
		programTypeId,
		ext,
		source,
		bridgeToken: randomBytes(32).toString("hex"),
	};
	const bridge = createBridge(job, extensionOrigin, bridgeSecret);
	try {
		await bridge.listen();
	} catch (error) {
		throw new Error(
			`Could not start local bridge on ${HOST}:${PORT}: ${error.message}`,
		);
	}

	process.stdout.write(
		`Waiting for browser extension to submit ${target.contestId}${target.problemIndex}...\n`,
	);
	try {
		const result = await bridge.wait();
		if (result.timedOut) {
			process.stderr.write("Error: Timed out waiting for browser extension.\n");
		}
		return result.exitCode;
	} finally {
		await bridge.close();
	}
}

async function main(argv) {
	if (argv.includes("--version") || argv.includes("-v")) {
		process.stdout.write(`cf-tool (cf) v${VERSION}\n`);
		return 0;
	}
	const [command, ...args] = argv;
	if (command === "submit") return submit(args);
	if (command === "config") {
		process.stdout.write("Configured via active browser session bridge.\n");
		return 0;
	}
	printHelp();
	return command ? 2 : 0;
}

main(process.argv.slice(2))
	.then((code) => {
		process.exitCode = code;
	})
	.catch((error) => {
		process.stderr.write(`Error: ${error.message}\n`);
		process.exitCode = 1;
	});
