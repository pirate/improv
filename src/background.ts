import type { Message, ExecuteJsRequest, CapturePageDataRequest, InjectUserscriptRequest, ExecuteJsResponse, CapturePageDataResponse } from "./types";

// Open sidepanel when extension icon is clicked
chrome.action.onClicked.addListener(async (tab) => {
	if (tab.id) {
		await chrome.sidePanel.open({ tabId: tab.id });
	}
});

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
			if (script.enabled) {
				try {
					const regex = new RegExp(script.matchUrls);
					if (regex.test(currentUrl)) {
						console.log(`[Improv] Auto-executing userscript: ${script.name}`);

						// Execute using chrome.scripting to bypass CSP
						await chrome.scripting.executeScript({
							target: { tabId: details.tabId },
							world: "MAIN",
							func: (scriptCode: string, scriptName: string) => {
								console.log(`[Improv] Executing userscript: ${scriptName}`);
								try {
									const fn = new Function(scriptCode);
									fn();
								} catch (error) {
									console.error(`[Improv] Error in userscript ${scriptName}:`, error);
								}
							},
							args: [script.jsScript, script.name],
						});
					}
				} catch (error) {
					console.error(`[Improv] Error checking/executing userscript ${script.name}:`, error);
				}
			}
		}
	} catch (error) {
		console.error("[Improv] Error loading userscripts:", error);
	}
});

// Message handler for communication between sidepanel and content script
chrome.runtime.onMessage.addListener((message: Message, sender, sendResponse) => {
	if (message.type === "EXECUTE_JS") {
		handleExecuteJs(message).then(sendResponse);
		return true;
	}

	if (message.type === "CAPTURE_PAGE_DATA") {
		handleCapturePageData(message).then(sendResponse);
		return true;
	}

	if (message.type === "INJECT_USERSCRIPT") {
		handleInjectUserscript(message).then(() => sendResponse({ success: true }));
		return true;
	}
});

async function handleExecuteJs(request: ExecuteJsRequest): Promise<ExecuteJsResponse> {
	try {
		// Use chrome.scripting.executeScript to bypass CSP restrictions
		// This executes in the MAIN world (page context) instead of ISOLATED world
		const results = await chrome.scripting.executeScript({
			target: { tabId: request.tabId },
			world: "MAIN",
			func: (code: string) => {
				// Capture console output
				const logs: string[] = [];
				const originalConsole = {
					log: console.log,
					error: console.error,
					warn: console.warn,
					info: console.info,
				};

				// Override console methods temporarily
				console.log = (...args: any[]) => {
					originalConsole.log(...args);
					logs.push(`[LOG] ${args.map(a => String(a)).join(" ")}`);
				};
				console.error = (...args: any[]) => {
					originalConsole.error(...args);
					logs.push(`[ERROR] ${args.map(a => String(a)).join(" ")}`);
				};
				console.warn = (...args: any[]) => {
					originalConsole.warn(...args);
					logs.push(`[WARN] ${args.map(a => String(a)).join(" ")}`);
				};
				console.info = (...args: any[]) => {
					originalConsole.info(...args);
					logs.push(`[INFO] ${args.map(a => String(a)).join(" ")}`);
				};

				try {
					// Execute the code using Function constructor (works in MAIN world)
					const fn = new Function(code);
					const result = fn();

					// Restore console
					console.log = originalConsole.log;
					console.error = originalConsole.error;
					console.warn = originalConsole.warn;
					console.info = originalConsole.info;

					const output = logs.join("\n") + (result !== undefined ? `\nReturn value: ${String(result)}` : "");
					return { success: true, output, error: null };
				} catch (error) {
					// Restore console
					console.log = originalConsole.log;
					console.error = originalConsole.error;
					console.warn = originalConsole.warn;
					console.info = originalConsole.info;

					return {
						success: false,
						output: logs.join("\n"),
						error: error instanceof Error ? error.message : String(error),
					};
				}
			},
			args: [request.code],
		});

		if (results && results[0] && results[0].result) {
			const result = results[0].result as { success: boolean; output: string; error: string | null };
			if (result.success) {
				return {
					type: "EXECUTE_JS_RESPONSE",
					requestId: request.requestId,
					result: result.output,
				};
			} else {
				return {
					type: "EXECUTE_JS_RESPONSE",
					requestId: request.requestId,
					result: result.output,
					error: result.error || undefined,
				};
			}
		} else {
			return {
				type: "EXECUTE_JS_RESPONSE",
				requestId: request.requestId,
				result: "",
				error: "No result from script execution",
			};
		}
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
		console.log("Content script not loaded, attempting injection on tab", tabId);

		try {
			// Get tab info to check if it's a valid URL
			const tab = await chrome.tabs.get(tabId);

			// Check if URL is valid for script injection
			if (!tab.url) {
				console.error("Tab has no URL, cannot inject script");
				return false;
			}

			if (tab.url.startsWith("chrome://") ||
			    tab.url.startsWith("edge://") ||
			    tab.url.startsWith("about:") ||
			    tab.url.startsWith("chrome-extension://")) {
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

async function handleCapturePageData(request: CapturePageDataRequest): Promise<CapturePageDataResponse> {
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
		const contentResponse = await chrome.tabs.sendMessage(request.tabId, request) as CapturePageDataResponse;

		// Capture screenshot only if requested (defaults to true for backwards compatibility)
		let screenshot = "";
		if (request.includeScreenshot !== false) {
			try {
				screenshot = await chrome.tabs.captureVisibleTab(undefined, { format: "png" });
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

async function handleInjectUserscript(request: InjectUserscriptRequest): Promise<void> {
	try {
		// Use chrome.scripting.executeScript to bypass CSP restrictions
		await chrome.scripting.executeScript({
			target: { tabId: request.tabId },
			world: "MAIN",
			func: (script: string) => {
				try {
					const fn = new Function(script);
					fn();
				} catch (error) {
					console.error("[Improv] Userscript execution error:", error);
				}
			},
			args: [request.script],
		});
	} catch (error) {
		console.error("Error injecting userscript:", error);
	}
}
