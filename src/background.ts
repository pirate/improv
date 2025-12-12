import type {
	CapturePageDataRequest,
	CapturePageDataResponse,
	ExecuteJsRequest,
	ExecuteJsResponse,
	GrabModeActivateRequest,
	GrabModeDeactivateRequest,
	GrabbedElement,
	InjectUserscriptRequest,
	Message,
} from "./types";

// ============================================================================
// CSP Nonce Detection
// ============================================================================

// Store nonces per tab/frame - key is `${tabId}:${frameId}`
const nonceCache: Map<string, string> = new Map();

// Regex to extract nonce from CSP header
const CSP_NONCE_RE = /'nonce-([A-Za-z0-9+/=_-]+)'/;

/**
 * Extract nonce from Content-Security-Policy header value
 */
function extractNonceFromCsp(cspValue: string): string | null {
	const match = cspValue.match(CSP_NONCE_RE);
	return match ? match[1] : null;
}

/**
 * Listen for response headers to extract CSP nonces
 */
chrome.webRequest.onHeadersReceived.addListener(
	(details) => {
		const { tabId, frameId, responseHeaders } = details;
		if (!responseHeaders || tabId < 0) return;

		// Look for Content-Security-Policy header
		for (const header of responseHeaders) {
			if (
				header.name.toLowerCase() === "content-security-policy" &&
				header.value
			) {
				const nonce = extractNonceFromCsp(header.value);
				if (nonce) {
					const key = `${tabId}:${frameId}`;
					nonceCache.set(key, nonce);
					console.log(
						`[Improv] Captured CSP nonce for tab ${tabId}, frame ${frameId}: ${nonce.slice(0, 8)}...`,
					);
				}
				break;
			}
		}
	},
	{ urls: ["<all_urls>"], types: ["main_frame", "sub_frame"] },
	["responseHeaders"],
);

// Clean up nonces when tabs are closed
chrome.tabs.onRemoved.addListener((tabId) => {
	// Remove all nonces for this tab
	for (const key of nonceCache.keys()) {
		if (key.startsWith(`${tabId}:`)) {
			nonceCache.delete(key);
		}
	}
});

// Clean up nonces when navigating away
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
	const key = `${details.tabId}:${details.frameId}`;
	nonceCache.delete(key);
});

/**
 * Get the cached nonce for a tab/frame
 */
function getNonceForTab(tabId: number, frameId = 0): string | null {
	return nonceCache.get(`${tabId}:${frameId}`) || null;
}

// ============================================================================
// userScripts API Configuration
// ============================================================================

let userScriptsAvailable = false;

/**
 * Check if userScripts API is available (Chrome 138+ style check)
 * Requires "Allow User Scripts" toggle to be enabled in extension settings
 */
function isUserScriptsAvailable(): boolean {
	try {
		if (!chrome.userScripts) return false;
		// This throws if the "Allow User Scripts" toggle is not enabled
		chrome.userScripts.getScripts();
		return true;
	} catch {
		return false;
	}
}

// Configure the USER_SCRIPT world to enable messaging and relax CSP
// This allows user scripts to use eval/Function which is needed for dynamic code
async function configureUserScriptWorld() {
	try {
		// Check if userScripts API is available (requires "Allow User Scripts" toggle in Chrome 138+)
		if (!isUserScriptsAvailable()) {
			console.warn(
				"[Improv] userScripts API not available. To enable:\n" +
					"1. Go to chrome://extensions\n" +
					"2. Click on 'Improv' extension details\n" +
					"3. Enable 'Allow User Scripts' toggle\n" +
					"4. Reload this extension",
			);
			return false;
		}

		// Check if execute method exists (Chrome 135+)
		// biome-ignore lint/suspicious/noExplicitAny: chrome.userScripts.execute() is Chrome 135+ API without types
		if (typeof (chrome.userScripts as any).execute !== "function") {
			console.warn(
				"[Improv] chrome.userScripts.execute not available - need Chrome 135+",
			);
			return false;
		}

		await chrome.userScripts.configureWorld({
			csp: "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
			messaging: true,
		});

		userScriptsAvailable = true;
		console.log("[Improv] userScripts API configured successfully");
		return true;
	} catch (err) {
		console.warn("[Improv] Failed to configure userScripts:", err);
		return false;
	}
}

// Initialize on load
configureUserScriptWorld();

// Open sidepanel when extension icon is clicked
chrome.action.onClicked.addListener(async (tab) => {
	if (tab.id) {
		await chrome.sidePanel.open({ tabId: tab.id });
	}
});

// Script execution results stored in session storage
// Key: scriptId, Value: { success: boolean, error?: string, timestamp: number }
interface ScriptExecutionResult {
	success: boolean;
	error?: string;
	timestamp: number;
}

// Store execution results in chrome.storage.session for persistence across sidepanel reopens
async function storeExecutionResult(
	scriptId: string,
	success: boolean,
	error?: string,
) {
	const result: ScriptExecutionResult = {
		success,
		error,
		timestamp: Date.now(),
	};

	// Get existing results and update
	const stored = await chrome.storage.session.get("scriptExecutionResults");
	const results = stored.scriptExecutionResults || {};
	results[scriptId] = result;
	await chrome.storage.session.set({ scriptExecutionResults: results });

	// Notify sidepanel of the update
	chrome.runtime
		.sendMessage({
			type: "SCRIPT_EXECUTION_RESULT",
			scriptId,
			...result,
		})
		.catch(() => {
			// Sidepanel might not be open, ignore error
		});
}

// Auto-inject matching userscripts when pages load
chrome.webNavigation.onCompleted.addListener(async (details) => {
	// Only handle main frame (not iframes)
	if (details.frameId !== 0) return;

	try {
		const result = await chrome.storage.local.get("userscripts");
		const userscripts = result.userscripts || [];

		const tab = await chrome.tabs.get(details.tabId);
		const currentUrl = tab.url || details.url;

		for (const script of userscripts) {
			if (script.enabled && script.jsScript) {
				try {
					const regex = new RegExp(script.matchUrls);
					if (regex.test(currentUrl)) {
						console.log(`[Improv] Auto-executing userscript: ${script.name}`);
						try {
							await executeUserScript(details.tabId, script.jsScript);
							await storeExecutionResult(script.id, true);
						} catch (execError) {
							const errorMsg =
								execError instanceof Error
									? execError.message
									: String(execError);
							console.error(
								`[Improv] Userscript execution failed: ${script.name}`,
								errorMsg,
							);
							await storeExecutionResult(script.id, false, errorMsg);
						}
					}
				} catch (error) {
					const errorMsg =
						error instanceof Error ? error.message : String(error);
					console.error(
						`[Improv] Error checking/executing userscript ${script.name}:`,
						error,
					);
					await storeExecutionResult(script.id, false, errorMsg);
				}
			}
		}
	} catch (error) {
		console.error("[Improv] Error loading userscripts:", error);
	}
});

/**
 * Execute a user script in a tab using chrome.userScripts.execute()
 * This bypasses CSP because USER_SCRIPT world is exempt from page CSP
 */
async function executeUserScript(tabId: number, code: string): Promise<void> {
	// biome-ignore lint/suspicious/noExplicitAny: chrome.userScripts.execute() is Chrome 135+ API without types
	await (chrome.userScripts as any).execute({
		target: { tabId },
		js: [{ code }],
		world: "USER_SCRIPT",
	});
}

// Message handler for communication between sidepanel and content script
chrome.runtime.onMessage.addListener(
	(message: Message, sender, sendResponse) => {
		if (message.type === "EXECUTE_JS") {
			handleExecuteJs(message).then(sendResponse);
			return true;
		}

		if (message.type === "CAPTURE_PAGE_DATA") {
			handleCapturePageData(message).then(sendResponse);
			return true;
		}

		if (message.type === "INJECT_USERSCRIPT") {
			handleInjectUserscript(message).then(() =>
				sendResponse({ success: true }),
			);
			return true;
		}

		// Grab mode handlers - forward to content script
		if (message.type === "GRAB_MODE_ACTIVATE") {
			handleGrabModeActivate(message).then(sendResponse);
			return true;
		}

		if (message.type === "GRAB_MODE_DEACTIVATE") {
			handleGrabModeDeactivate(message).then(sendResponse);
			return true;
		}

		// Forward element selection from content script to sidepanel with screenshot
		if (message.type === "GRAB_MODE_ELEMENT_SELECTED") {
			// Capture screenshot while the highlight overlay is still visible
			handleGrabModeElementSelected(message, sender).then(() => {
				// Message already sent in handler
			});
			return false; // Don't send the original message, we'll send an enhanced one
		}

		// Forward grab mode state change from content script to sidepanel
		if (message.type === "GRAB_MODE_STATE_CHANGE") {
			// This comes from content script (e.g., user pressed Escape)
			// The sidepanel listens to runtime.onMessage for this
			return false;
		}
	},
);

/**
 * Handle execute_js requests from the sidepanel.
 *
 * Uses chrome.userScripts.execute() (Chrome 135+) which runs in the USER_SCRIPT world.
 * This world is exempt from page CSP, allowing us to execute dynamic code on any site.
 */
async function handleExecuteJs(
	request: ExecuteJsRequest,
): Promise<ExecuteJsResponse> {
	// Check if userScripts API is available
	if (!userScriptsAvailable) {
		// Try to configure it again in case it wasn't ready before
		await configureUserScriptWorld();

		if (!userScriptsAvailable) {
			return {
				type: "EXECUTE_JS_RESPONSE",
				requestId: request.requestId,
				result: "",
				error:
					"userScripts API not available. Go to chrome://extensions, click on Improv details, and enable 'Allow User Scripts' toggle. Then reload the extension.",
			};
		}
	}

	try {
		// Wrap the user code to capture console output
		const wrappedCode = `
(function() {
	const logs = [];
	let error = null;

	const originalLog = console.log;
	const originalError = console.error;
	const originalWarn = console.warn;
	const originalInfo = console.info;

	console.log = (...args) => {
		originalLog.apply(console, args);
		try {
			logs.push("[LOG] " + args.map(a => {
				if (typeof a === "object") {
					try { return JSON.stringify(a); } catch { return String(a); }
				}
				return String(a);
			}).join(" "));
		} catch {}
	};
	console.error = (...args) => {
		originalError.apply(console, args);
		try { logs.push("[ERROR] " + args.map(a => String(a)).join(" ")); } catch {}
	};
	console.warn = (...args) => {
		originalWarn.apply(console, args);
		try { logs.push("[WARN] " + args.map(a => String(a)).join(" ")); } catch {}
	};
	console.info = (...args) => {
		originalInfo.apply(console, args);
		try { logs.push("[INFO] " + args.map(a => String(a)).join(" ")); } catch {}
	};

	try {
		${request.code}
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
		originalError.call(console, "[Improv] Script error:", error);
	}

	console.log = originalLog;
	console.error = originalError;
	console.warn = originalWarn;
	console.info = originalInfo;

	const output = logs.length > 0
		? logs.join("\\n")
		: error ? "" : "Script executed successfully (no console output)";

	return { success: !error, output, error };
})();
`;

		// Use chrome.userScripts.execute() - CSP exempt in USER_SCRIPT world
		// biome-ignore lint/suspicious/noExplicitAny: chrome.userScripts.execute() is Chrome 135+ API without types
		const results = await (chrome.userScripts as any).execute({
			target: { tabId: request.tabId },
			js: [{ code: wrappedCode }],
			world: "USER_SCRIPT",
		});

		if (results?.[0]?.result) {
			const result = results[0].result as {
				success: boolean;
				output: string;
				error: string | null;
			};
			return {
				type: "EXECUTE_JS_RESPONSE",
				requestId: request.requestId,
				result: result.output,
				error: result.error || undefined,
			};
		}

		return {
			type: "EXECUTE_JS_RESPONSE",
			requestId: request.requestId,
			result: "Script executed successfully (no console output)",
			error: undefined,
		};
	} catch (error) {
		return {
			type: "EXECUTE_JS_RESPONSE",
			requestId: request.requestId,
			result: "",
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function ensureContentScript(tabId: number): Promise<boolean> {
	try {
		// Try to ping the content script
		await chrome.tabs.sendMessage(tabId, { type: "PING" });
		console.log("Content script already loaded on tab", tabId);
		return true;
	} catch (error) {
		// Content script not loaded, try to inject it
		console.log(
			"Content script not loaded, attempting injection on tab",
			tabId,
		);

		try {
			// Get tab info to check if it's a valid URL
			const tab = await chrome.tabs.get(tabId);

			// Check if URL is valid for script injection
			if (!tab.url) {
				console.error("Tab has no URL, cannot inject script");
				return false;
			}

			if (
				tab.url.startsWith("chrome://") ||
				tab.url.startsWith("edge://") ||
				tab.url.startsWith("about:") ||
				tab.url.startsWith("chrome-extension://")
			) {
				console.error("Cannot inject script on restricted page:", tab.url);
				return false;
			}

			// Inject the content script
			await chrome.scripting.executeScript({
				target: { tabId },
				files: ["contentScript.js"],
			});

			// Wait longer for it to initialize
			await new Promise((resolve) => setTimeout(resolve, 300));

			// Verify it loaded
			try {
				await chrome.tabs.sendMessage(tabId, { type: "PING" });
				console.log("Content script successfully injected on tab", tabId);
				return true;
			} catch (pingError) {
				console.error("Content script injected but not responding:", pingError);
				return false;
			}
		} catch (injectError) {
			console.error("Failed to inject content script:", injectError);
			return false;
		}
	}
}

async function handleCapturePageData(
	request: CapturePageDataRequest,
): Promise<CapturePageDataResponse> {
	try {
		// Ensure content script is loaded
		const scriptLoaded = await ensureContentScript(request.tabId);
		if (!scriptLoaded) {
			console.error("Content script could not be loaded on tab", request.tabId);

			// Try to get tab URL for better error message
			let tabUrl = "";
			try {
				const tab = await chrome.tabs.get(request.tabId);
				tabUrl = tab.url || "";
			} catch (e) {
				// Ignore
			}

			return {
				type: "CAPTURE_PAGE_DATA_RESPONSE",
				requestId: request.requestId,
				screenshot: "",
				html: "",
				consoleLog: "",
				url: tabUrl, // Return the URL so we can show a better error
			};
		}

		// Get HTML and console logs from content script
		const contentResponse = (await chrome.tabs.sendMessage(
			request.tabId,
			request,
		)) as CapturePageDataResponse;

		// Capture screenshot only if requested (defaults to true for backwards compatibility)
		let screenshot = "";
		if (request.includeScreenshot !== false) {
			try {
				screenshot = await chrome.tabs.captureVisibleTab(undefined, {
					format: "png",
				});
			} catch (screenshotError) {
				console.error("Failed to capture screenshot:", screenshotError);
				// Continue without screenshot
			}
		}

		return {
			...contentResponse,
			screenshot,
		};
	} catch (error) {
		console.error("Error capturing page data:", error);
		return {
			type: "CAPTURE_PAGE_DATA_RESPONSE",
			requestId: request.requestId,
			screenshot: "",
			html: "",
			consoleLog: "",
			url: "",
		};
	}
}

async function handleInjectUserscript(
	request: InjectUserscriptRequest,
): Promise<void> {
	try {
		await executeUserScript(request.tabId, request.script);
	} catch (error) {
		console.error("Error injecting userscript:", error);
	}
}

async function handleGrabModeActivate(
	request: GrabModeActivateRequest,
): Promise<{ success: boolean; error?: string }> {
	try {
		// Ensure content script is loaded
		const scriptLoaded = await ensureContentScript(request.tabId);
		if (!scriptLoaded) {
			return { success: false, error: "Content script could not be loaded" };
		}

		// Send activate message to content script
		await chrome.tabs.sendMessage(request.tabId, {
			type: "GRAB_MODE_ACTIVATE",
		});
		return { success: true };
	} catch (error) {
		console.error("Error activating grab mode:", error);
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function handleGrabModeDeactivate(
	request: GrabModeDeactivateRequest,
): Promise<{ success: boolean; error?: string }> {
	try {
		// Send deactivate message to content script
		await chrome.tabs.sendMessage(request.tabId, {
			type: "GRAB_MODE_DEACTIVATE",
		});
		return { success: true };
	} catch (error) {
		console.error("Error deactivating grab mode:", error);
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function handleGrabModeElementSelected(
	message: { type: string; element: GrabbedElement },
	sender: chrome.runtime.MessageSender,
): Promise<void> {
	const tabId = sender.tab?.id;
	const element = message.element;

	try {
		// Capture full page screenshot while the purple highlight overlay is still visible
		let screenshot = "";
		try {
			screenshot = await chrome.tabs.captureVisibleTab(undefined, {
				format: "png",
			});
		} catch (screenshotError) {
			console.error("Failed to capture grab mode screenshot:", screenshotError);
		}

		// Capture element-specific screenshot using debugger API
		let elementScreenshot = "";
		if (tabId && element.xpath) {
			try {
				elementScreenshot = await captureElementScreenshot(
					tabId,
					element.xpath,
				);
			} catch (elemError) {
				console.error("Failed to capture element screenshot:", elemError);
			}
		}

		// Add element screenshot to the element data
		const enhancedElement: GrabbedElement = {
			...element,
			screenshot: elementScreenshot,
		};

		// Send enhanced message with screenshots to sidepanel
		chrome.runtime.sendMessage({
			type: "GRAB_MODE_ELEMENT_SELECTED_WITH_SCREENSHOT",
			element: enhancedElement,
			screenshot,
			tabId,
		});
	} catch (error) {
		console.error("Error handling grab mode element selection:", error);
		// Still forward the original message without screenshots
		chrome.runtime.sendMessage({
			type: "GRAB_MODE_ELEMENT_SELECTED_WITH_SCREENSHOT",
			element,
			screenshot: "",
			tabId,
		});
	}
}

/**
 * Capture a screenshot of a specific element using the Chrome Debugger API
 */
async function captureElementScreenshot(
	tabId: number,
	xpath: string,
): Promise<string> {
	const target = { tabId };

	try {
		// Attach debugger
		await chrome.debugger.attach(target, "1.3");

		// Enable required domains
		await chrome.debugger.sendCommand(target, "DOM.enable");
		await chrome.debugger.sendCommand(target, "Page.enable");

		// Get document root
		const docResult = (await chrome.debugger.sendCommand(
			target,
			"DOM.getDocument",
		)) as { root: { nodeId: number } };

		// Convert XPath to a CSS selector or use evaluate
		// For XPath, we need to use DOM.performSearch or evaluate
		const searchResult = (await chrome.debugger.sendCommand(
			target,
			"DOM.performSearch",
			{ query: xpath },
		)) as { searchId: string; resultCount: number };

		if (searchResult.resultCount === 0) {
			await chrome.debugger.detach(target);
			return "";
		}

		// Get the node IDs from search
		const nodeResults = (await chrome.debugger.sendCommand(
			target,
			"DOM.getSearchResults",
			{
				searchId: searchResult.searchId,
				fromIndex: 0,
				toIndex: 1,
			},
		)) as { nodeIds: number[] };

		const nodeId = nodeResults.nodeIds[0];
		if (!nodeId) {
			await chrome.debugger.detach(target);
			return "";
		}

		// Scroll element into view
		await chrome.debugger.sendCommand(target, "DOM.scrollIntoViewIfNeeded", {
			nodeId,
		});

		// Get box model for element bounds
		const boxResult = (await chrome.debugger.sendCommand(
			target,
			"DOM.getBoxModel",
			{ nodeId },
		)) as { model: { border: number[] } };

		const q = boxResult.model.border; // [x1,y1,x2,y2,x3,y3,x4,y4]
		const xs = [q[0], q[2], q[4], q[6]];
		const ys = [q[1], q[3], q[5], q[7]];
		const x = Math.min(...xs);
		const y = Math.min(...ys);
		const width = Math.max(...xs) - x;
		const height = Math.max(...ys) - y;

		// Skip if element has no dimensions
		if (width <= 0 || height <= 0) {
			await chrome.debugger.detach(target);
			return "";
		}

		// Capture screenshot of just the element
		const screenshotResult = (await chrome.debugger.sendCommand(
			target,
			"Page.captureScreenshot",
			{
				format: "png",
				clip: { x, y, width, height, scale: 1 },
				captureBeyondViewport: true,
			},
		)) as { data: string };

		await chrome.debugger.detach(target);

		return `data:image/png;base64,${screenshotResult.data}`;
	} catch (error) {
		console.error("Failed to capture element screenshot:", error);
		try {
			await chrome.debugger.detach(target);
		} catch {
			// Ignore detach errors
		}
		return "";
	}
}
