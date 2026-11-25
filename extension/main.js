const BRIDGE_URL = "http://127.0.0.1:4242";
let isProcessing = false;

async function reportStatus(message, done = false, success = false) {
	try {
		await fetch(`${BRIDGE_URL}/status`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message, done, success }),
		});
	} catch (_) {}
}

function waitForTabLoad(tabId) {
	return new Promise((resolve) => {
		const listener = (updatedTabId, changeInfo) => {
			if (updatedTabId === tabId && changeInfo.status === "complete") {
				chrome.tabs.onUpdated.removeListener(listener);
				resolve();
			}
		};
		chrome.tabs.onUpdated.addListener(listener);
	});
}

async function executeSubmissionInPage(job, bridgeUrl) {
	const report = async (message, done = false, success = false) => {
		try {
			await fetch(`${bridgeUrl}/status`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ message, done, success }),
			});
		} catch (_) {}
	};

	const getHandle = () => {
		const link = document.querySelector('#header a[href^="/profile/"]');
		return link ? link.textContent.trim() : null;
	};

	const VERDICT_MAP = {
		OK: "Accepted",
		WRONG_ANSWER: "Wrong answer",
		TIME_LIMIT_EXCEEDED: "Time limit exceeded",
		MEMORY_LIMIT_EXCEEDED: "Memory limit exceeded",
		RUNTIME_ERROR: "Runtime error",
		COMPILATION_ERROR: "Compilation error",
		IDLENESS_LIMIT_EXCEEDED: "Idleness limit exceeded",
		CHALLENGED: "Hacked",
		SKIPPED: "Skipped",
		PARTIAL: "Partial",
	};

	const { contestId, problemIndex, programTypeId, source, isGym } = job;
	const origin = window.location.origin;
	const basePath = isGym
		? `${origin}/gym/${contestId}`
		: `${origin}/contest/${contestId}`;
	const submitUrl = `${basePath}/submit`;

	const handle = getHandle();
	if (!handle) {
		await report(
			"Error: Not logged into Codeforces in your browser!",
			true,
			false,
		);
		return;
	}

	try {
		await report("Fetching fresh CSRF token from Codeforces...", false);

		const pageRes = await fetch(submitUrl, { credentials: "include" });
		if (!pageRes.ok) {
			await report(
				`Error: HTTP ${pageRes.status} loading submit page.`,
				true,
				false,
			);
			return;
		}
		const html = await pageRes.text();

		const submitDoc = new DOMParser().parseFromString(html, "text/html");
		const submitForm = submitDoc.querySelector("form.submit-form");
		if (!submitForm) {
			await report(
				"Error: Could not find submit form on Codeforces.",
				true,
				false,
			);
			return;
		}

		const csrfToken = submitForm.querySelector(
			'input[name="csrf_token"]',
		)?.value;
		if (!csrfToken) {
			await report("Error: Could not find csrf_token.", true, false);
			return;
		}

		let validLangId = programTypeId;
		const langSelect = submitForm.querySelector('select[name="programTypeId"]');
		if (
			langSelect &&
			!langSelect.querySelector(`option[value="${validLangId}"]`)
		) {
			const options = Array.from(langSelect.options);
			const fallback =
				options.find((o) => /g\+\+2/i.test(o.text)) ||
				options.find((o) => /python 3/i.test(o.text));
			if (fallback) validLangId = fallback.value;
		}

		await report(
			`CSRF token acquired (Lang ID: ${validLangId}). Submitting solution...`,
			false,
		);

		const formData = new FormData(submitForm);
		formData.set("submittedProblemIndex", problemIndex);
		formData.set("programTypeId", validLangId);
		formData.set("source", source);
		formData.set("tabSize", "4");
		formData.delete("sourceFile");

		const ftaa = localStorage.getItem("ftaa") || window._ftaa || "n/a";
		const bfaa = localStorage.getItem("bfaa") || window._bfaa || "n/a";
		formData.set("ftaa", ftaa);
		formData.set("bfaa", bfaa);

		const submitStartTime = Math.floor(Date.now() / 1000);

		const postRes = await fetch(`${submitUrl}?csrf_token=${csrfToken}`, {
			method: "POST",
			credentials: "include",
			body: formData,
		});

		const postHtml = await postRes.text();
		if (!postRes.url.includes("/my") && !postRes.url.includes("/status")) {
			const doc = new DOMParser().parseFromString(postHtml, "text/html");
			const errors = [
				...new Set(
					Array.from(doc.querySelectorAll(".error, .shiftUp"))
						.map((el) => el.textContent.trim())
						.filter(Boolean),
				),
			].join(" | ");
			await report(
				`Codeforces rejected: ${errors || "Check source/language"}`,
				true,
				false,
			);
			return;
		}

		if (isGym) {
			await report("status: Submitted to Gym", true, true);
			return;
		}

		await report("Submitted! Waiting for judge verdict...", false);

		let lastMsg = "";
		for (let attempt = 0; attempt < 60; attempt++) {
			await new Promise((r) => setTimeout(r, 2000));
			try {
				const res = await fetch(
					`${origin}/api/user.status?handle=${encodeURIComponent(handle)}&from=1&count=5`,
				);
				const data = await res.json();
				if (data.status !== "OK" || !Array.isArray(data.result)) continue;

				const latest = data.result.find(
					(sub) =>
						String(sub.contestId) === String(contestId) &&
						sub.problem &&
						sub.problem.index.toUpperCase() === problemIndex.toUpperCase() &&
						sub.creationTimeSeconds >= submitStartTime - 300,
				);

				if (!latest) continue;

				const verdict = latest.verdict || "TESTING";
				const passedTests = latest.passedTestCount || 0;

				if (verdict === "TESTING") {
					const msg = `status: Running on test ${passedTests + 1}`;
					if (msg !== lastMsg) {
						await report(msg, false);
						lastMsg = msg;
					}
				} else {
					const readable = VERDICT_MAP[verdict] || verdict.replace(/_/g, " ");
					const timeMs = latest.timeConsumedMillis || 0;
					const memKb = Math.round((latest.memoryConsumedBytes || 0) / 1024);

					if (verdict === "OK") {
						await report(
							`status: Accepted (${timeMs} ms, ${memKb} KB)`,
							true,
							true,
						);
					} else if (verdict === "COMPILATION_ERROR") {
						await report("status: Compilation error", true, true);
					} else {
						await report(
							`status: ${readable} on test ${passedTests + 1} (${timeMs} ms, ${memKb} KB)`,
							true,
							true,
						);
					}
					return;
				}
			} catch (_) {}
		}

		await report("status: Verdict polling timed out", true, true);
	} catch (err) {
		await report(`Extension error: ${err.message}`, true, false);
	}
}

async function processJob(job) {
	let createdTempTab = false;
	let targetTabId = null;

	try {
		const tabs = await chrome.tabs.query({ url: "https://codeforces.com/*" });
		if (tabs.length > 0) {
			targetTabId = tabs[0].id;
		} else {
			await reportStatus(
				"No Codeforces tab open. Opening background session tab...",
				false,
			);
			const newTab = await chrome.tabs.create({
				url: "https://codeforces.com/",
				active: false,
			});
			targetTabId = newTab.id;
			createdTempTab = true;
			await waitForTabLoad(targetTabId);
		}

		await chrome.scripting.executeScript({
			target: { tabId: targetTabId },
			func: executeSubmissionInPage,
			args: [job, BRIDGE_URL],
		});
	} catch (err) {
		await reportStatus(`Background worker error: ${err.message}`, true, false);
	} finally {
		if (createdTempTab && targetTabId !== null) {
			try {
				await chrome.tabs.remove(targetTabId);
			} catch (_) {}
		}
	}
}

async function pollBridge() {
	if (isProcessing) return;
	try {
		const res = await fetch(`${BRIDGE_URL}/job`);
		if (!res.ok) return;
		const data = await res.json();
		if (data.has_job && data.job) {
			isProcessing = true;
			await processJob(data.job);
			isProcessing = false;
		}
	} catch (_) {}
}

if (typeof module !== "undefined" && module.exports) {
	module.exports = { processJob, pollBridge, reportStatus };
} else {
	chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
	chrome.alarms.onAlarm.addListener(() => {
		pollBridge();
	});

	setInterval(() => {
		chrome.runtime.getPlatformInfo(() => {});
	}, 20000);

	setInterval(pollBridge, 600);
}
