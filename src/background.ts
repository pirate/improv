import type { Message, ExecuteJsRequest, CapturePageDataRequest, InjectUserscriptRequest, ExecuteJsResponse, CapturePageDataResponse } from "./types";

// Open sidepanel when extension icon is clicked
chrome.action.onClicked.addListener(async (tab) => {
	if (tab.id) {
		await chrome.sidePanel.open({ tabId: tab.id });
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
		const response = await chrome.tabs.sendMessage(request.tabId, request);
		return response as ExecuteJsResponse;
	} catch (error) {
		return {
			type: "EXECUTE_JS_RESPONSE",
			requestId: request.requestId,
			result: "",
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function handleCapturePageData(request: CapturePageDataRequest): Promise<CapturePageDataResponse> {
	try {
		// Get HTML and console logs from content script
		const contentResponse = await chrome.tabs.sendMessage(request.tabId, request) as CapturePageDataResponse;

		// Capture screenshot
		const screenshot = await chrome.tabs.captureVisibleTab(undefined, { format: "png" });

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
		await chrome.tabs.sendMessage(request.tabId, request);
	} catch (error) {
		console.error("Error injecting userscript:", error);
	}
}
