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
	if (message.type === "PING") {
		sendResponse({ type: "PONG" });
		return true;
	}

	// EXECUTE_JS is now handled by background.js using chrome.scripting.executeScript
	// This bypasses CSP restrictions
	if (message.type === "EXECUTE_JS") {
		sendResponse({
			type: "EXECUTE_JS_RESPONSE",
			requestId: message.requestId,
			result: "",
			error: "EXECUTE_JS should be handled by background script",
		});
		return true;
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

	// INJECT_USERSCRIPT is now handled by background.js using chrome.scripting.executeScript
	// This bypasses CSP restrictions
	if (message.type === "INJECT_USERSCRIPT") {
		// No-op, background script handles this
		return true;
	}
});

// Userscript auto-execution is now handled by background.js
// using chrome.webNavigation.onCompleted and chrome.scripting.executeScript
// This bypasses CSP restrictions
