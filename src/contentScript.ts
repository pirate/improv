import type {
	CapturePageDataResponse,
	ExecuteJsResponse,
	GrabbedElement,
	Message,
} from "./types";

// Console log capture - limit to last 100 entries to prevent memory issues
const consoleLogs: string[] = [];
const MAX_CONSOLE_LOGS = 100;
const originalConsole = {
	log: console.log,
	error: console.error,
	warn: console.warn,
	info: console.info,
};

// Helper to add log and trim if needed
function addLog(entry: string) {
	consoleLogs.push(entry);
	if (consoleLogs.length > MAX_CONSOLE_LOGS) {
		consoleLogs.shift();
	}
}

// Override console methods to capture output
console.log = (...args: unknown[]) => {
	originalConsole.log(...args);
	addLog(`[LOG] ${args.map((a) => String(a)).join(" ")}`);
};
console.error = (...args: unknown[]) => {
	originalConsole.error(...args);
	addLog(`[ERROR] ${args.map((a) => String(a)).join(" ")}`);
};
console.warn = (...args: unknown[]) => {
	originalConsole.warn(...args);
	addLog(`[WARN] ${args.map((a) => String(a)).join(" ")}`);
};
console.info = (...args: unknown[]) => {
	originalConsole.info(...args);
	addLog(`[INFO] ${args.map((a) => String(a)).join(" ")}`);
};

// ============================================================================
// GRAB MODE - Element selection overlay
// ============================================================================

let grabModeActive = false;
let highlightOverlay: HTMLDivElement | null = null;
let currentHoveredElement: Element | null = null;

// Generate XPath for an element
function getXPath(element: Element): string {
	if (element.id) {
		return `//*[@id="${element.id}"]`;
	}

	const parts: string[] = [];
	let current: Element | null = element;

	while (current && current.nodeType === Node.ELEMENT_NODE) {
		let index = 1;
		let sibling: Element | null = current.previousElementSibling;

		while (sibling) {
			if (sibling.tagName === current.tagName) {
				index++;
			}
			sibling = sibling.previousElementSibling;
		}

		const tagName = current.tagName.toLowerCase();
		const part =
			index > 1 || current.nextElementSibling?.tagName === current.tagName
				? `${tagName}[${index}]`
				: tagName;
		parts.unshift(part);

		current = current.parentElement;
	}

	return `/${parts.join("/")}`;
}

// Create the highlight overlay element
function createHighlightOverlay(): HTMLDivElement {
	const overlay = document.createElement("div");
	overlay.id = "improv-grab-overlay";
	overlay.style.cssText = `
		position: fixed;
		pointer-events: none;
		border: 2px solid #8b5cf6;
		background: rgba(139, 92, 246, 0.1);
		z-index: 2147483647;
		transition: all 0.1s ease-out;
		border-radius: 4px;
		display: none;
	`;

	// Add a label to show element info
	const label = document.createElement("div");
	label.id = "improv-grab-label";
	label.style.cssText = `
		position: absolute;
		top: -24px;
		left: 0;
		background: #8b5cf6;
		color: white;
		font-size: 11px;
		font-family: system-ui, -apple-system, sans-serif;
		padding: 2px 6px;
		border-radius: 3px;
		white-space: nowrap;
		max-width: 300px;
		overflow: hidden;
		text-overflow: ellipsis;
	`;
	overlay.appendChild(label);

	document.body.appendChild(overlay);
	return overlay;
}

// Update overlay position
function updateOverlayPosition(element: Element) {
	if (!highlightOverlay) return;

	const rect = element.getBoundingClientRect();
	highlightOverlay.style.display = "block";
	highlightOverlay.style.top = `${rect.top}px`;
	highlightOverlay.style.left = `${rect.left}px`;
	highlightOverlay.style.width = `${rect.width}px`;
	highlightOverlay.style.height = `${rect.height}px`;

	const label = highlightOverlay.querySelector(
		"#improv-grab-label",
	) as HTMLDivElement;
	if (label) {
		const tagName = element.tagName.toLowerCase();
		const id = element.id ? `#${element.id}` : "";
		const classes = element.className
			? `.${String(element.className).split(" ").slice(0, 2).join(".")}`
			: "";
		label.textContent = `${tagName}${id}${classes}`;
	}
}

// Hide overlay
function hideOverlay() {
	if (highlightOverlay) {
		highlightOverlay.style.display = "none";
	}
}

// Truncate data URLs but keep everything else
function truncateDataUrls(html: string): string {
	return html.replace(
		/(data:[^;]+;base64,)[A-Za-z0-9+/]{100,}={0,2}/g,
		"$1[...base64 data truncated...]",
	);
}

// Extract element data for grabbed element
function extractElementData(element: Element): GrabbedElement {
	const attributes: Record<string, string> = {};
	for (const attr of Array.from(element.attributes)) {
		attributes[attr.name] = attr.value;
	}

	// Get text content (no truncation)
	const textContent = (element.textContent || "").trim();

	// Get outer HTML with only data URLs truncated (includes the element and all its contents)
	const outerHTML = truncateDataUrls(element.outerHTML);

	return {
		xpath: getXPath(element),
		tagName: element.tagName.toLowerCase(),
		attributes,
		textContent,
		outerHTML,
	};
}

// Mouse move handler for grab mode
function handleGrabModeMouseMove(e: MouseEvent) {
	if (!grabModeActive) return;

	// Get element under cursor, ignoring our overlay
	const target = document.elementFromPoint(e.clientX, e.clientY);
	if (
		!target ||
		target === highlightOverlay ||
		target.id === "improv-grab-overlay" ||
		target.id === "improv-grab-label"
	) {
		return;
	}

	// Skip if same element
	if (target === currentHoveredElement) return;

	currentHoveredElement = target;
	updateOverlayPosition(target);
}

// Click handler for grab mode
function handleGrabModeClick(e: MouseEvent) {
	if (!grabModeActive) return;

	e.preventDefault();
	e.stopPropagation();

	const target = document.elementFromPoint(e.clientX, e.clientY);
	if (
		!target ||
		target === highlightOverlay ||
		target.id === "improv-grab-overlay" ||
		target.id === "improv-grab-label"
	) {
		return;
	}

	// Extract element data and send to sidepanel
	const elementData = extractElementData(target);
	chrome.runtime.sendMessage({
		type: "GRAB_MODE_ELEMENT_SELECTED",
		element: elementData,
	});
}

// Keydown handler for grab mode (Escape to exit)
function handleGrabModeKeyDown(e: KeyboardEvent) {
	if (!grabModeActive) return;

	if (e.key === "Escape") {
		e.preventDefault();
		e.stopPropagation();
		deactivateGrabMode();
		// Notify sidepanel that grab mode was deactivated
		chrome.runtime.sendMessage({
			type: "GRAB_MODE_STATE_CHANGE",
			active: false,
		});
	}
}

// Activate grab mode
function activateGrabMode() {
	if (grabModeActive) return;

	grabModeActive = true;

	// Create overlay if not exists
	if (!highlightOverlay) {
		highlightOverlay = createHighlightOverlay();
	}

	// Add event listeners with capture to intercept clicks
	document.addEventListener("mousemove", handleGrabModeMouseMove, true);
	document.addEventListener("click", handleGrabModeClick, true);
	document.addEventListener("keydown", handleGrabModeKeyDown, true);

	// Add visual indicator that grab mode is active
	document.body.style.cursor = "crosshair";

	originalConsole.log("[Improv] Grab mode activated");
}

// Deactivate grab mode
function deactivateGrabMode() {
	if (!grabModeActive) return;

	grabModeActive = false;

	// Remove event listeners
	document.removeEventListener("mousemove", handleGrabModeMouseMove, true);
	document.removeEventListener("click", handleGrabModeClick, true);
	document.removeEventListener("keydown", handleGrabModeKeyDown, true);

	// Hide and remove overlay
	if (highlightOverlay) {
		highlightOverlay.remove();
		highlightOverlay = null;
	}

	// Reset cursor
	document.body.style.cursor = "";
	currentHoveredElement = null;

	originalConsole.log("[Improv] Grab mode deactivated");
}

// Truncate high-entropy strings
const truncateHighEntropyStrings = (input: string): string => {
	let result = input.replace(
		/(data:[^;]+;base64,)[A-Za-z0-9+/]{100,}={0,2}/g,
		"$1[...truncated...]",
	);
	result = result.replace(/([A-Za-z0-9+/]{500,}={0,2})/g, "[...truncated...]");
	return result;
};

// Unique ID for communicating results from injected scripts
const IMPROV_RESULT_EVENT = "improv-script-result";

// Listen for results from injected scripts
window.addEventListener(IMPROV_RESULT_EVENT, ((e: CustomEvent) => {
	const { requestId, output, error } = e.detail;
	// Store the result temporarily for the message handler to pick up
	(window as unknown as Record<string, unknown>)[
		`__improv_result_${requestId}`
	] = { output, error };
}) as EventListener);

/**
 * Inject and execute JavaScript code by creating a <script> tag.
 * Uses a nonce if provided (from intercepted CSP headers) to bypass CSP.
 */
function injectAndExecuteJs(
	code: string,
	requestId: string,
	nonce?: string | null,
): Promise<{ output: string; error?: string }> {
	return new Promise((resolve) => {
		// Wrap the code to capture console output and errors
		const wrappedCode = `
(function() {
	const logs = [];
	let scriptError = null;
	
	// Save original console methods
	const origLog = console.log;
	const origError = console.error;
	const origWarn = console.warn;
	const origInfo = console.info;
	
	// Override console methods
	console.log = (...args) => {
		origLog.apply(console, args);
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
		origError.apply(console, args);
		try { logs.push("[ERROR] " + args.map(a => String(a)).join(" ")); } catch {}
	};
	console.warn = (...args) => {
		origWarn.apply(console, args);
		try { logs.push("[WARN] " + args.map(a => String(a)).join(" ")); } catch {}
	};
	console.info = (...args) => {
		origInfo.apply(console, args);
		try { logs.push("[INFO] " + args.map(a => String(a)).join(" ")); } catch {}
	};
	
	try {
		${code}
	} catch (e) {
		scriptError = e instanceof Error ? e.message : String(e);
		origError.call(console, "[Improv] Script error:", scriptError);
	}
	
	// Restore console methods
	console.log = origLog;
	console.error = origError;
	console.warn = origWarn;
	console.info = origInfo;
	
	// Send result back via custom event
	const output = logs.length > 0 
		? logs.join("\\n") 
		: scriptError ? "" : "Script executed successfully (no console output)";
	
	window.dispatchEvent(new CustomEvent("${IMPROV_RESULT_EVENT}", {
		detail: { requestId: "${requestId}", output, error: scriptError }
	}));
})();
`;

		// Create and inject the script element
		const scriptEl = document.createElement("script");
		scriptEl.textContent = wrappedCode;

		// Use the nonce from intercepted CSP headers if provided
		if (nonce) {
			scriptEl.setAttribute("nonce", nonce);
			originalConsole.log(
				"[Improv] Using CSP nonce from headers:",
				nonce.slice(0, 8) + "...",
			);
		}

		// Listen for the result
		const resultKey = `__improv_result_${requestId}`;
		const checkResult = () => {
			const result = (window as unknown as Record<string, unknown>)[
				resultKey
			] as { output: string; error?: string } | undefined;
			if (result) {
				delete (window as unknown as Record<string, unknown>)[resultKey];
				resolve(result);
			} else {
				// Script might have failed to execute at all (CSP blocked it)
				resolve({
					output: "",
					error:
						"Script injection blocked by CSP. The page may use a strict Content Security Policy that cannot be bypassed.",
				});
			}
		};

		// Inject the script
		(document.head || document.documentElement).appendChild(scriptEl);
		scriptEl.remove();

		// Check for result after a short delay (script should execute synchronously)
		setTimeout(checkResult, 50);
	});
}

// Message handler
chrome.runtime.onMessage.addListener(
	(message: Message, sender, sendResponse) => {
		if (message.type === "PING") {
			sendResponse({ type: "PONG" });
			return true;
		}

		// Handle code injection request from background script
		if (message.type === "INJECT_AND_EXECUTE_JS") {
			injectAndExecuteJs(message.code, message.requestId, message.nonce).then(
				sendResponse,
			);
			return true; // Keep channel open for async response
		}

		// Legacy EXECUTE_JS handler (redirect to background)
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
			const html = truncateHighEntropyStrings(
				document.documentElement.outerHTML,
			);
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

		// Grab mode message handlers
		if (message.type === "GRAB_MODE_ACTIVATE") {
			activateGrabMode();
			sendResponse({ success: true });
			return true;
		}

		if (message.type === "GRAB_MODE_DEACTIVATE") {
			deactivateGrabMode();
			sendResponse({ success: true });
			return true;
		}
	},
);

// Userscript auto-execution is now handled by background.js
// using chrome.webNavigation.onCompleted and chrome.scripting.executeScript
// This bypasses CSP restrictions

// Clean up grab mode if the page is navigated away
window.addEventListener("beforeunload", () => {
	if (grabModeActive) {
		deactivateGrabMode();
	}
});
