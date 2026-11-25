import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);

// Mock Chrome Extension APIs before loading main.js
let queriedTabs = [];
let createdTabs = [];
let removedTabIds = [];
let executedScripts = [];
let tabUpdateListeners = [];

globalThis.chrome = {
	alarms: {
		create: () => {},
		onAlarm: { addListener: () => {} },
	},
	runtime: {
		getPlatformInfo: (cb) => cb?.({}),
	},
	tabs: {
		query: async () => queriedTabs,
		create: async (opts) => {
			const tab = { id: 999, ...opts };
			createdTabs.push(tab);
			// Simulate immediate tab load completion
			setTimeout(() => {
				for (const fn of tabUpdateListeners) {
					fn(tab.id, { status: "complete" });
				}
			}, 5);

			return tab;
		},
		remove: async (id) => {
			removedTabIds.push(id);
		},
		onUpdated: {
			addListener: (fn) => tabUpdateListeners.push(fn),
			removeListener: (fn) => {
				tabUpdateListeners = tabUpdateListeners.filter((l) => l !== fn);
			},
		},
	},
	scripting: {
		executeScript: async (opts) => {
			executedScripts.push(opts);
		},
	},
};

globalThis.fetch = async () => ({
	ok: true,
	json: async () => ({ has_job: false }),
});

const { processJob } = require("../extension/main.js");

test("uses existing Codeforces tab when available", async () => {
	queriedTabs = [{ id: 42, url: "https://codeforces.com" }];
	createdTabs = [];
	removedTabIds = [];
	executedScripts = [];

	await processJob({
		contestId: "2164",
		problemIndex: "A",
		source: "int main(){}",
	});

	assert.equal(executedScripts.length, 1);
	assert.equal(executedScripts[0].target.tabId, 42);
	assert.equal(createdTabs.length, 0);
	assert.equal(removedTabIds.length, 0);
});

test("opens and closes temporary background tab when zero tabs are open", async () => {
	queriedTabs = [];
	createdTabs = [];
	removedTabIds = [];
	executedScripts = [];

	await processJob({
		contestId: "2164",
		problemIndex: "A",
		source: "int main(){}",
	});

	assert.equal(createdTabs.length, 1);
	assert.equal(createdTabs[0].active, false);
	assert.equal(executedScripts.length, 1);
	assert.equal(executedScripts[0].target.tabId, 999);
	assert.deepEqual(removedTabIds, [999]);
});
