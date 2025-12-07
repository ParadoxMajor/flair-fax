import { Devvit, JSONValue } from "@devvit/public-api";
import { checkForModPerms } from "./RedditUtils.js";
import { getAppSettings } from "./main.js";

Devvit.configure({
  redditAPI: true,
});

//TODO - rewrite to perform scan in the background based on frequency defined in settings. Cut out the stepping through forms entirely.

/* ---------- Part 1: Types, Config, Basic Helpers ---------- */

interface FlairScanResult {
	// Maps flair text → array of usernames
	flairGroups: Record<string, string[]>;
	after: string | null;
	timestamp: number; // scan start timestamp (ms)
	completed: boolean;
	scannedUsers: number;
	lastPageNumber?: number;
	toastShown?: boolean;
}

const DEFAULT_QUICK_SCAN_MS = 500;
const DEFAULT_DEVVIT_TIMEOUT_SECONDS = 30;
const TIMEOUT_FRACTION = 0.9; // stop at 90% of allowed time
const LONG_RUN_WARNING_THRESHOLD_MS = 3000; // show long-run toast if chunk takes > 3s
const SLEEP_BETWEEN_PAGES_MS = 250;

function sleep(ms: number) {
	return new Promise((res) => setTimeout(res, ms));
}

function formatDuration(ms: number) {
	const sec = Math.floor(ms / 1000);
	if (sec < 60) return `${sec} sec`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min} min ${sec % 60} sec`;
	const hr = Math.floor(min / 60);
	return `${hr} hr ${min % 60} min`;
}

function formatNumberWithCommas(n: number): string {
	return n.toLocaleString();
}

function startTimer() {
	return Date.now();
}

function isTimeRemaining(startTime: number, timeoutSeconds: number, fraction = TIMEOUT_FRACTION) {
	return Date.now() - startTime < timeoutSeconds * 1000 * fraction;
}

/* ---------- Part 2: Safe KV wrappers, merge and formatting helpers ---------- */

async function safeKVWrite(context: Devvit.Context, key: string, value: unknown) {
	try {
		await context.kvStore.put(key, JSON.parse(JSON.stringify(value)) as JSONValue);
	} catch (err) {
		console.error(`safeKVWrite failed key=${key}`, err);
	}
}

async function safeKVDelete(context: Devvit.Context, key: string) {
	try {
		await context.kvStore.delete(key);
	} catch (err) {
		console.error(`safeKVDelete failed key=${key}`, err);
	}
}

function formatFlairPreviewCounts(flairGroups: Record<string, string[]>, maxLines = 25): string {
	if (!flairGroups || Object.keys(flairGroups).length === 0) return "No flair data available yet.";
	const lines = Object.entries(flairGroups)
		.sort(([, a], [, b]) => b.length - a.length)
		.map(([f, users]) => `• ${f} — ${formatNumberWithCommas(users.length)} user${users.length !== 1 ? "s" : ""}`);
	if (lines.length <= maxLines) return lines.join("\n");
	return lines.slice(0, maxLines).join("\n") + `\n…and ${lines.length - maxLines} more flairs`;
}

/* merge src into dst in-place (retains possible duplicates; if you want dedupe, change here) */
function mergeFlairGroups(dst: Record<string, string[]>, src: Record<string, string[]>) {
	for (const [f, users] of Object.entries(src)) {
		if (!dst[f]) dst[f] = [];
		dst[f].push(...users);
	}
}

/* ---------- Part 3: Chunked pagination with cumulative totals & page numbering ---------- */

/**
 * buildFlairGroupsPaginatedChunk
 * - continues from `after` cursor
 * - accumulates into `cumulativeFlairGroupsStart` and `scannedUsersStart`
 * - uses startPageNumber so logs continue across chunks
 * - returns FlairScanResult for the merged state and persists partial/final
 */
async function buildFlairGroupsPaginatedChunk(
	context: Devvit.Context,
	subredditName: string,
	after: string | null,
	cumulativeFlairGroupsStart: Record<string, string[]>,
	scannedUsersStart: number,
	startPageNumber: number
): Promise<FlairScanResult> {
	const subreddit = await context.reddit.getCurrentSubreddit();
	let currentAfter: string | null = after;
	let pageNumber = startPageNumber;
	// clone starting cumulative so we can mutate locally
	const cumulativeFlairGroups: Record<string, string[]> = { ...(cumulativeFlairGroupsStart ?? {}) };
	let cumulativeUsers = scannedUsersStart ?? 0;

	const settings = (typeof getAppSettings === "function") ? await getAppSettings(context) : { devvitExecutionTimeoutSeconds: DEFAULT_DEVVIT_TIMEOUT_SECONDS };
	const timeoutSeconds = (settings && typeof settings.devvitExecutionTimeoutSeconds === "number") ? settings.devvitExecutionTimeoutSeconds : DEFAULT_DEVVIT_TIMEOUT_SECONDS;
	const chunkStart = startTimer();

	// If chunk is long, we log once (UI toast is triggered on menu/form open)
	let longRunToastLogged = false;

	let completed = false;

	do {
		pageNumber++;
    context.ui.showToast('User Flair scanning on page ' + pageNumber);

		// Stop if time budget nearly exhausted
		if (!isTimeRemaining(chunkStart, timeoutSeconds, TIMEOUT_FRACTION)) {
			console.log(`⚠️ Chunk ${Math.max(1, startPageNumber)} — budget reached after ${formatDuration(Date.now() - chunkStart)}. Pausing chunk.`);
			break;
		}

		let resp: any;
		try {
			resp = await subreddit.getUserFlair({ after: currentAfter ?? undefined, limit: 1000 });
		} catch (err) {
			const msg = String(err);
			console.error("❌ Page fetch error:", err);
			await safeKVWrite(context, "flairScanFailed", true);
			await safeKVWrite(context, "flairScanFailedMessage", msg);
			await safeKVWrite(context, "flairScanInProgress", false);
			throw err;
		}

		// Defensive
		if (!resp || !Array.isArray(resp.users)) {
			console.error("❌ Invalid getUserFlair response:", resp);
			await safeKVWrite(context, "flairScanFailed", true);
			await safeKVWrite(context, "flairScanFailedMessage", "Invalid response from getUserFlair");
			await safeKVWrite(context, "flairScanInProgress", false);
			throw new Error("Invalid response from getUserFlair");
		}

		// Merge page users
		for (const u of resp.users) {
			const uname = u.user ?? "Unknown";
			const ftext = (u.flairText || "").trim();
			if (!ftext) continue;
			if (!cumulativeFlairGroups[ftext]) cumulativeFlairGroups[ftext] = [];
			cumulativeFlairGroups[ftext].push(uname);
			cumulativeUsers++;
		}

		currentAfter = resp.next ?? null;

		// If running long, mark logged (console-only); toast shown on form/menu open or when user continues
		// if (!longRunToastLogged && Date.now() - chunkStart > LONG_RUN_WARNING_THRESHOLD_MS) {
		// 	console.log("⚠️ Showing long-run warning toast to user... (chunk in progress)");
		// 	longRunToastLogged = true;
		// }

		// Log cumulative counts (do NOT log full flair arrays)
		console.log(
			`Chunk ${Math.max(1, startPageNumber)} — Page ${pageNumber}: after=${currentAfter}, scannedUsers=${formatNumberWithCommas(
				cumulativeUsers
			)}, uniqueFlairs=${formatNumberWithCommas(Object.keys(cumulativeFlairGroups).length)}`
		);

		// heartbeat
		await safeKVWrite(context, "flairScanHeartbeat", Date.now());

		// yield
		await sleep(SLEEP_BETWEEN_PAGES_MS);

		if (!currentAfter) {
			completed = true;
			break;
		}
	} while (true);

	// Determine timestamp: reuse existing scan start if present
	const startTimestampRaw = await context.kvStore.get("flairScanStartedAt");
	const timestamp = typeof startTimestampRaw === "number" ? startTimestampRaw : Date.now();

	const result: FlairScanResult = {
		flairGroups: cumulativeFlairGroups,
		after: currentAfter,
		timestamp,
		completed,
		scannedUsers: cumulativeUsers,
		lastPageNumber: pageNumber,
	};

	// Persist partial or final
	if (completed) {
		await safeKVWrite(context, "flairScanResult", result);
		await safeKVWrite(context, "flairScanCompletedAt", Date.now());
		await safeKVWrite(context, "flairScanInProgress", false);
		await safeKVWrite(context, "flairScanFailed", false);
		await safeKVDelete(context, "flairScanPartial");
	} else {
		await safeKVWrite(context, "flairScanPartial", result);
		await safeKVWrite(context, "flairScanInProgress", true);
	}

	return result;
}

/* ---------- Part 4: Scan flow helpers (startQuickScan, continueScan) and UI helper ---------- */

/* startQuickScan: attempt to complete quickly (race against DEFAULT_QUICK_SCAN_MS) */
async function startQuickScan(context: Devvit.Context, subredditName: string): Promise<FlairScanResult> {
	// load partial (if any) to pick up where left off
	const partialRaw = await context.kvStore.get("flairScanPartial");
	const partial = partialRaw ? (partialRaw as unknown as FlairScanResult) : null;

	const quickPromise = (async () => {
		const startAfter = partial?.after ?? null;
		const startGroups = partial?.flairGroups ?? {};
		const startUsers = partial?.scannedUsers ?? 0;
		const startPage = partial?.lastPageNumber ?? 0;
		return await buildFlairGroupsPaginatedChunk(context, subredditName, startAfter, startGroups, startUsers, startPage);
	})();

	const quickTimeout = new Promise<{ __timeout: true }>((resolve) =>
		setTimeout(() => resolve({ __timeout: true }), DEFAULT_QUICK_SCAN_MS)
	);

	const raced = await Promise.race([quickPromise, quickTimeout]);

	if ((raced as any).__timeout) {
		// Quick attempt didn't finish: ensure partial exists or create initial
		if (!partial) {
			const initial: FlairScanResult = {
				flairGroups: {},
				after: null,
				timestamp: Date.now(),
				completed: false,
				scannedUsers: 0,
				lastPageNumber: 0,
				toastShown: false,
			};
			await safeKVWrite(context, "flairScanPartial", initial);
			await safeKVWrite(context, "flairScanStartedAt", Date.now());
			await safeKVWrite(context, "flairScanInProgress", true);
			return initial;
		}
		return partial;
	} else {
		// Quick finished: returns chunk result (may be completed or partial) and it has been persisted by chunk fn
		return raced as FlairScanResult;
	}
}

/* continueScan: resume from partial state and run one chunk */
async function continueScan(context: Devvit.Context, subredditName: string, partial: FlairScanResult): Promise<FlairScanResult> {
	const startAfter = partial.after ?? null;
	const startGroups = partial.flairGroups ?? {};
	const startUsers = partial.scannedUsers ?? 0;
	const startPage = partial.lastPageNumber ?? 0;

	// run a chunk and persist result
	const res = await buildFlairGroupsPaginatedChunk(context, subredditName, startAfter, startGroups, startUsers, startPage);
	return res;
}

/* showProgressForm: render partial or final preview */
function showProgressForm(context: Devvit.Context, result: FlairScanResult) {
	const preview = result.completed
		? `Total flairs: ${formatNumberWithCommas(Object.keys(result.flairGroups).length)}\nTotal users: ${formatNumberWithCommas(
				result.scannedUsers
		  )}\nFlair Breakdown (⏱️ ${formatDuration(Date.now() - result.timestamp)}):\n${formatFlairPreviewCounts(result.flairGroups)}`
		: `⏱️ ${formatDuration(Date.now() - result.timestamp)}, ${formatNumberWithCommas(result.scannedUsers)} users scanned so far.`;

	// show form (do not await)
	context.ui.showForm(flairForm, {
		full: result.completed ? (JSON.parse(JSON.stringify(result)) as JSONValue) : null,
		scanRunning: !result.completed,
		failedScan: false,
		preview,
	});
}

/* ---------- Part 5: Form + Menu wiring, reset/version, inspect ---------- */

/* Form creation (Devvit.createForm) — keep simple UI; handlers below rely on KV state */
const flairForm = Devvit.createForm(
	(data) => ({
		title: data.scanRunning
			? "🟡 Flair Scan — In Progress"
			: data.failedScan
			? "❌ Flair Scan — Failed"
			: data.full
			? "🟢 Flair Scan — Results"
			: "⚪️ Flair Scan — No Scan Yet",
		acceptLabel: data.scanRunning ? "Continue Scan" : data.failedScan ? "Retry Scan" : data.full ? "Refresh" : "Start Scan",
		cancelLabel: "Close",
		fields: [
			{
				name: "preview",
				type: "paragraph",
				label: "Current Flair Breakdown Preview",
				defaultValue: data.preview,
				disabled: true,
				lineHeight: 10,
			},
      {
        name: "cancelScan",
        type: 'boolean',
        label: "Cancel Scan",
      },
		],
	}),
	/* handler: form approval */
	async ({ values }, context) => {
		const scanRunning = !!(await context.kvStore.get("flairScanInProgress"));
		const failedScan = !!(await context.kvStore.get("flairScanFailed"));
		const subreddit = await context.reddit.getCurrentSubreddit();

    if(values.cancelScan) {
      await clearScan(context, 'User selected to cancel');
      return;
    }

		// if scanning, treat accept as "Continue Scan"
		if (scanRunning && !failedScan) {
			//context.ui.showToast("⚪️ Continuing scan...");
			const partialRaw = await context.kvStore.get("flairScanPartial");
			const partial: FlairScanResult = partialRaw
				? (partialRaw as unknown as FlairScanResult)
				: { flairGroups: {}, after: null, timestamp: Date.now(), completed: false, scannedUsers: 0, lastPageNumber: 0, toastShown: false };
			// show a toast (console log too)
			//console.log("⚠️ Showing long-run warning toast to user... (continue)");
			//context.ui.showToast("⚠️ Continuing scan chunk — this may take up to 30s.");

			const result = await continueScan(context, subreddit.name, partial);
			showProgressForm(context, result);
			return;
		}

		// otherwise accept acts as Start/Retry/Refresh
		await safeKVDelete(context, "flairScanFailed");
		await safeKVDelete(context, "flairScanFailedMessage");

		// set scan start if missing
		const scanStartedAtRaw = await context.kvStore.get("flairScanStartedAt");
		if (!scanStartedAtRaw) await safeKVWrite(context, "flairScanStartedAt", Date.now());

		const quickResult = await startQuickScan(context, subreddit.name);
		// quickResult persisted by chunk function when appropriate
		showProgressForm(context, quickResult);
	}
);

/* Menu item wiring */
Devvit.addMenuItem({
	label: "User Flairs",
	description: "Breakdown user flairs and who has them",
	location: "subreddit",
	forUserType: "moderator",
	onPress: async (_, context) => {
		try {
			await resetFlairScanIfAppUpdated(context, context.appVersion);

			const fullRaw = await context.kvStore.get("flairScanResult");
			const full = fullRaw ? (fullRaw as unknown as FlairScanResult) : null;

			const partialRaw = await context.kvStore.get("flairScanPartial");
			const partial = partialRaw ? (partialRaw as unknown as FlairScanResult) : null;

			const scanRunning = !!(await context.kvStore.get("flairScanInProgress"));
			const failedScan = !!(await context.kvStore.get("flairScanFailed"));

			let preview: string;
      if(scanRunning || partial || full || failedScan) {
        if (scanRunning && partial) {
          preview = `⏱️ ${formatDuration(Date.now() - partial.timestamp)}, ${formatNumberWithCommas(
            partial.scannedUsers
          )} users scanned so far.`;
          // show warning toast once per partial
          if (!partial.toastShown) {
            //console.log("⚠️ Showing long-run warning toast to user... (initial from menu)");
            //context.ui.showToast("⚠️ This scan may take multiple chunks. Press Continue Scan to proceed.");
            await safeKVWrite(context, "flairScanPartial", { ...partial, toastShown: true });
          }
        } else if (full) {
          preview = `Total flairs: ${formatNumberWithCommas(Object.keys(full.flairGroups).length)}\nTotal users: ${formatNumberWithCommas(
            full.scannedUsers
          )}\nFlair Breakdown (⏱️ ${formatDuration(Date.now() - full.timestamp)}):\n${formatFlairPreviewCounts(full.flairGroups)}`;
        } else if (failedScan) {
          const msg = (await context.kvStore.get("flairScanFailedMessage")) as string | null;
          preview = `Scan failed: ${msg ?? "Unknown error"}`;
        } else {
          preview = "No scan yet. Opening will start a scan.";
        }
        context.ui.showForm(flairForm, {
        	full: full ? (JSON.parse(JSON.stringify(full)) as JSONValue) : null,
        	scanRunning,
        	failedScan,
        	preview,
        });
      }

			// Auto-start: if no full, no partial, no running — start quick scan in background
			if (!full && !partial && !(await context.kvStore.get("flairScanInProgress"))) {
				console.log("⚪️ No previous scan found, starting new scan...");
				await safeKVWrite(context, "flairScanStartedAt", Date.now());
				const initialPartial: FlairScanResult = {
					flairGroups: {},
					after: null,
					timestamp: Date.now(),
					completed: false,
					scannedUsers: 0,
					lastPageNumber: 0,
					toastShown: false,
				};
				await safeKVWrite(context, "flairScanPartial", initialPartial);
				await safeKVWrite(context, "flairScanInProgress", true);

				// attempt a quick chunk in the background (non-blocking)
				// result will be persisted by chunk function if it finishes
				startQuickScan(context, (await context.reddit.getCurrentSubreddit()).name)
					.then((res) => {
						if (res && res.completed) {
							console.log("Quick scan completed quickly; showing results.");
						} else {
							console.log("Quick scan started in background; user must Continue to progress manually.");
						}
            showProgressForm(context, res);
					})
					.catch((err) => console.error("startQuickScan background error:", err));
			}
		} catch (err: unknown) {
			console.error("User Flairs menu error:", err);
			context.ui.showToast("Failed to open User Flairs");
		}
	},
});

/* reset on app update */
async function resetFlairScanIfAppUpdated(context: Devvit.Context, currentVersion: string) {
	try {
		const lastVersionRaw = (await context.kvStore.get("appVersion")) as unknown;
		const lastVersion: string | null = typeof lastVersionRaw === "string" ? lastVersionRaw : null;
		if (lastVersion !== currentVersion) {
			await clearScan(context, "App version change: lastVersion → currentVersion");
			await safeKVWrite(context, "appVersion", currentVersion);
			console.log("Flair scan cleared due to app version change:", lastVersion, "→", currentVersion);
		}
	} catch (err: unknown) {
		console.warn("Could not check/reset app version KV:", err);
	}
}

async function clearScan(context:Devvit.Context, clearReason = '') {
  try {
			await safeKVDelete(context, "flairScanPartial");
			await safeKVDelete(context, "flairScanResult");
			await safeKVDelete(context, "flairScanInProgress");
			await safeKVDelete(context, "flairScanFailed");
			await safeKVDelete(context, "flairScanFailedMessage");
			await safeKVDelete(context, "flairScanStartedAt");
      clearReason ?? context.ui.showToast('User Flair scan cleared: ' + clearReason);
  }
	catch (err: unknown) {
		console.warn("Could not clear User Flair scan:", err);
	}
}

/* small inspector */
async function inspectFlairScanStatus(context: Devvit.Context) {
	const keys = [
		"flairScanInProgress",
		"flairScanCancelled",
		"flairScanFailed",
		"flairScanFailedMessage",
		"flairScanStartedAt",
		"flairScanCompletedAt",
		"flairScanHeartbeat",
		"flairScanPartial",
		"flairScanResult",
	];

	console.log("===== FLAIR SCAN STATUS =====");
	for (const key of keys) {
		let value: any;
		try {
			value = await context.kvStore.get(key);
		} catch (err) {
			value = `ERROR: ${err}`;
		}
		// summarize partial/result to avoid huge logs
		if (value && typeof value === "object" && "flairGroups" in (value as any)) {
			const partial = value as FlairScanResult;
			console.log(`${key}: flairs: ${Object.keys(partial.flairGroups).length}, scannedUsers: ${partial.scannedUsers}`);
			continue;
		}
		console.log(`${key}:`, value);
	}
	console.log("===== END STATUS =====");
}



















//Old flair menu and form:
/**
 * User Flairs
 */
/*Devvit.addMenuItem({
  label: "User Flairs",
  description: "Display users with specified flair names",
  location: "subreddit",
  forUserType: "moderator",
  onPress: async (_, context) => {
    try {
      if(!await checkForModPerms(context, ['flair'])) {
          context.ui.showToast("You need 'flair' perm to view user flairs.");
          return;
      }

      const flairGroups = await getFlairGroups(context, '');
      const flairBreakdown = getFlairBreakdown(flairGroups);
      
      if (flairBreakdown.length === 0) {
        context.ui.showToast("No user flairs found.");
        return;
      }

      const flairOptions = getFlairOptions(flairGroups);

      context.ui.showForm(userFlairForm, { flairOptions, flairBreakdown });
    }
    catch(error) {
      console.error('Error generated user flair breakdwn:', error, '\nCaller stack:\n', new Error().stack?.split('\n').slice(1,5).join('\n'));
      context.ui.showToast('Error generated user flair breakdwn (' + error + ')');
      throw error;
    }
  }
});*/

/**
 * First form: select a flair name
 */
const userFlairForm = Devvit.createForm(
  (data) => ({
    fields: [
      {
        name: 'flairFilter',
        label: 'Flair Filter',
        type: 'string',
        defaultValue: data?.flairFilterValue,
        helpText: 'Enter any text to filter on flairs',
      },
      {
        name: "flairSelectFilter",
        label: "Flair Filter",
        type: "select",
        options: (data?.flairOptions || []),
        helpText: "Select a flair to filter (if not typed above)",
        defaultValue: !data?.flairFilterValue && data?.flairSelectValue
                 ? [data.flairSelectValue]   // use select value only if string is empty/undefined
                 : [],                        // otherwise, leave empty
        multiSelect: false, //TODO handle selcting multiple?
        size: 10,
        allowCustomValue: false,
      },
      {
        name: 'flairBreakdown',
        label: 'Flair Breakdown',
        type: 'paragraph',
        defaultValue: data.flairBreakdown,
        lineHeight: 10,
        disabled: true,
      },
    ],
    title: "User Flairs",
    acceptLabel: "Filter",
    cancelLabel: "Close",
  }),
  async ({ values }, context) => {
    try {
        const flairFilterValue = 
            (values.flairFilter && values.flairFilter !== '') 
                ? values.flairFilter 
                : (Array.isArray(values.flairSelectFilter) && values.flairSelectFilter.length > 0 
                    ? values.flairSelectFilter[0] 
                    : '');
        //const selectedFlair = values.flairnames[0];
        //Build the flairToUsernames map here, as you cannot access data in the handler
        //const flairToUsernames: Record<string, string[]> = {};
        const subreddit = await context.reddit.getCurrentSubreddit();

        console.log('------------------------------------------------------------------------');
        console.log("New 'User Flairs' Form Submitted" + (flairFilterValue === "" ? "(Flair Filter: " + flairFilterValue + ")" : ""));
        console.log('------------------------------------------------------------------------');
        console.log('r/' + subreddit.name + ' by u/' + await context.reddit.getCurrentUsername());
        console.log('-----------------------------\n');

        // const response = await subreddit.getUserFlair();
        // const userFlairs = response.users;
        // for (const userFlair of userFlairs) {
        //   const flairName = userFlair.flairText || "<No Text>";
        //   const username = userFlair.user;
        //   if (!flairToUsernames[flairName]) {
        //     flairToUsernames[flairName] = [];
        //   }
        //   if (username) {
        //     flairToUsernames[flairName].push(username);
        //   }
        // }
        // const users = flairToUsernames[selectedFlair] || [];
        // if (!selectedFlair || users.length === 0) {
        //   context.ui.showToast("No users found for this flair.");
        //   return;
        // }
        //context.ui.showForm(userFlairUsersForm, { selectedFlair, users });
        //const users = flairToUsernames[flairFilterValue] || [];
        const fullFlairGroups = await getFlairGroups(context);
        const flairOptions = getFlairOptions(fullFlairGroups); 
        const flairGroups = await getFlairGroups(context, flairFilterValue);
        const flairBreakdown = getFlairBreakdown(flairGroups);
        context.ui.showForm(userFlairForm, {
        flairFilterValue: values.flairFilter || '',           // typed text stays in string field
        flairSelectValue: (Array.isArray(values.flairSelectFilter) && values.flairSelectFilter.length > 0)
                            ? values.flairSelectFilter[0]
                            : '',                               // select field keeps its selected option
        flairOptions,                                         // dropdown options
        flairBreakdown                                        // filtered breakdown
        });
    }
    catch(error) {
        console.error('Error displays flairs:', error, '\nCaller stack:\n', new Error().stack?.split('\n').slice(1,5).join('\n'));
        context.ui.showToast('Error displaying flairs\n(' + error + ')');
        throw error;
    }
  }
);

/**
 * Second form: display users with the selected flair
 */
const userFlairUsersForm = Devvit.createForm(
  (data) => ({
    fields: [
      {
        name: "usernames",
        label: "User Names",
        options: (data?.users || []).map((username: string) => ({
          label: username,
          value: username
        })),
        type: "select",
        defaultValue: [],
        multiSelect: false,
        size: 10,
      },
    ],
    title: "Users with Flair: " + (data?.selectedFlair + " (" + data?.users.length + " users)" || ""),
    acceptLabel: "Open Profile",
    cancelLabel: "Cancel",
  }),
  async ({ values }, context) => {
    if (!values.usernames || values.usernames.length === 0) {
      context.ui.showToast("No user selected.");
      return;
    }
    context.ui.navigateTo("https://www.reddit.com/user/" + values.usernames[0]);
  }
);

/**
 * Build a flair-to-usernames mapping for a subreddit.
 */
export async function getFlairGroups(
  context: Devvit.Context,
  flairFilterValue?: string
): Promise<Record<string, string[]>> {
  const flairGroups: Record<string, string[]> = {};
  const subreddit = await context.reddit.getCurrentSubreddit();
  let response = await subreddit.getUserFlair();
  //let response = await subreddit.getUserFlair();
  //const userFlairs = response.users

  let reachedEnd = false;
  while(!reachedEnd) {
    const userFlairs = response.users;
    for (const userFlair of userFlairs) {
      const flairText = userFlair.flairText || "No Flair";
      const username = userFlair.user || "Unknown";

      // Apply optional filter if provided
      if (
        !flairFilterValue ||
        flairText.toLowerCase().includes(flairFilterValue.toLowerCase())
      ) {
        if (!flairGroups[flairText]) {
          flairGroups[flairText] = [];
        }
        flairGroups[flairText].push(username);
      }
    }
    if(response.next) {
      console.log('Handled ' + userFlairs.length + ' users, getting next page');
      response = await subreddit.getUserFlair({'after': response.next});
    }
    else {
      console.log('Last page, exiting');
      reachedEnd = true;
    }
  }

  return flairGroups;
}

/**
 * Create a list of flair options (for selects or filters) from flairGroups.
 */
export function getFlairOptions(flairGroups: Record<string, string[]>) {
  return Object.keys(flairGroups).map((flairText) => {
    return {
      label: `${flairText}`,
      value: flairText,
    };
  });
}

/**
 * Convert a flairGroups object into a human-readable string.
 */
export function getFlairBreakdown(
  flairGroups: Record<string, string[]>
): string {
  let flairBreakdown = "";

    Object.keys(flairGroups).forEach(flairText => {
    const users = flairGroups[flairText];
    const count = users.length;
    const usernames = users.map(u => `• u/${u}`).join('\n');
    flairBreakdown += `${flairText} (${count} user${count === 1 ? '' : 's'}):\n${usernames}\n\n`;
    });

  return flairBreakdown.trim();
}