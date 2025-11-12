import type { Message, ExecuteJsResponse, CapturePageDataResponse } from "./types";

// Console log capture
const consoleLogs: string[] = [];
const originalConsole = {
	log: console.log,
	error: console.error,
	warn: console.warn,
	info: console.info,
};

// Override console methods to capture output
console.log = (...args: unknown[]) => {
	originalConsole.log(...args);
	consoleLogs.push(`[LOG] ${args.map(a => String(a)).join(" ")}`);
};
console.error = (...args: unknown[]) => {
	originalConsole.error(...args);
	consoleLogs.push(`[ERROR] ${args.map(a => String(a)).join(" ")}`);
};
console.warn = (...args: unknown[]) => {
	originalConsole.warn(...args);
	consoleLogs.push(`[WARN] ${args.map(a => String(a)).join(" ")}`);
};
console.info = (...args: unknown[]) => {
	originalConsole.info(...args);
	consoleLogs.push(`[INFO] ${args.map(a => String(a)).join(" ")}`);
};

// Truncate high-entropy strings
const truncateHighEntropyStrings = (html: string): string => {
	html = html.replace(/(data:[^;]+;base64,)[A-Za-z0-9+/]{100,}={0,2}/g, "$1[...truncated...]");
	html = html.replace(/([A-Za-z0-9+/]{500,}={0,2})/g, "[...truncated...]");
	return html;
};

// Message handler
chrome.runtime.onMessage.addListener((message: Message, sender, sendResponse) => {
	if (message.type === "EXECUTE_JS") {
		const tempConsoleLogs: string[] = [];
		const tempOriginalConsole = {
			log: console.log,
			error: console.error,
			warn: console.warn,
			info: console.info,
		};

		// Temporarily override console to capture this execution's output
		console.log = (...args: unknown[]) => {
			tempOriginalConsole.log(...args);
			tempConsoleLogs.push(`[LOG] ${args.map(a => String(a)).join(" ")}`);
		};
		console.error = (...args: unknown[]) => {
			tempOriginalConsole.error(...args);
			tempConsoleLogs.push(`[ERROR] ${args.map(a => String(a)).join(" ")}`);
		};
		console.warn = (...args: unknown[]) => {
			tempOriginalConsole.warn(...args);
			tempConsoleLogs.push(`[WARN] ${args.map(a => String(a)).join(" ")}`);
		};
		console.info = (...args: unknown[]) => {
			tempOriginalConsole.info(...args);
			tempConsoleLogs.push(`[INFO] ${args.map(a => String(a)).join(" ")}`);
		};

		try {
			// Execute the code
			const result = eval(message.code);

			// Restore console
			console.log = tempOriginalConsole.log;
			console.error = tempOriginalConsole.error;
			console.warn = tempOriginalConsole.warn;
			console.info = tempOriginalConsole.info;

			const response: ExecuteJsResponse = {
				type: "EXECUTE_JS_RESPONSE",
				requestId: message.requestId,
				result: tempConsoleLogs.join("\n") + (result !== undefined ? `\nReturn value: ${String(result)}` : ""),
			};
			sendResponse(response);
		} catch (error) {
			// Restore console
			console.log = tempOriginalConsole.log;
			console.error = tempOriginalConsole.error;
			console.warn = tempOriginalConsole.warn;
			console.info = tempOriginalConsole.info;

			const response: ExecuteJsResponse = {
				type: "EXECUTE_JS_RESPONSE",
				requestId: message.requestId,
				result: tempConsoleLogs.join("\n"),
				error: error instanceof Error ? error.message : String(error),
			};
			sendResponse(response);
		}
		return true; // Keep the message channel open for async response
	}

	if (message.type === "CAPTURE_PAGE_DATA") {
		// Capture screenshot (handled by background script)
		// Here we just send HTML and console logs
		const html = truncateHighEntropyStrings(document.documentElement.outerHTML);
		const consoleLog = consoleLogs.join("\n");

		const response: CapturePageDataResponse = {
			type: "CAPTURE_PAGE_DATA_RESPONSE",
			requestId: message.requestId,
			screenshot: "", // Will be filled by background script
			html,
			consoleLog,
			url: window.location.href,
		};
		sendResponse(response);
		return true;
	}

	if (message.type === "INJECT_USERSCRIPT") {
		try {
			eval(message.script);
		} catch (error) {
			console.error("Userscript execution error:", error);
		}
	}
});

// Load and execute matching userscripts on page load
(async () => {
	try {
		const result = await chrome.storage.local.get("userscripts");
		const userscripts = result.userscripts || [];
		const currentUrl = window.location.href;

		for (const script of userscripts) {
			if (script.enabled) {
				try {
					const regex = new RegExp(script.matchUrls);
					if (regex.test(currentUrl)) {
						console.log(`[Improv] Executing userscript: ${script.name}`);
						eval(script.jsScript);
					}
				} catch (error) {
					console.error(`[Improv] Error in userscript ${script.name}:`, error);
				}
			}
		}
	} catch (error) {
		console.error("[Improv] Error loading userscripts:", error);
	}
})();
