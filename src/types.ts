export interface Userscript {
	id: string;
	name: string;
	matchUrls: string; // Regex pattern for URL matching
	jsScript: string; // JavaScript code
	chatHistoryId: string; // References the chat history for this mod (1:1 relationship)
	createdAt: number;
	updatedAt: number;
	enabled: boolean;
	// Optional source attribution for imported scripts
	sourceUrl?: string; // URL to the original script page (e.g., Greasyfork page)
	sourceType?: "greasyfork" | "openuserjs" | "manual";
}

// Script from a userscript repository (e.g., Greasyfork, OpenUserJS)
export interface RepositoryScript {
	id: number | string; // number for Greasyfork, string for OpenUserJS
	name: string;
	description: string;
	version: string;
	url: string; // URL to the script page
	codeUrl: string; // URL to download the script code
	totalInstalls: number;
	dailyInstalls: number;
	fanScore: number;
	goodRatings: number;
	okRatings: number;
	badRatings: number;
	authorName: string;
	createdAt: string;
	updatedAt: string;
	source: "greasyfork" | "openuserjs"; // Which repository this script is from
}

// Snapshot of userscript state at a point in time
export interface UserscriptSnapshot {
	name: string;
	matchUrls: string;
	jsScript: string;
	enabled: boolean;
}

export interface ChatMessage {
	id: string;
	role: "user" | "assistant" | "system";
	content: string;
	timestamp: number;
	toolCalls?: ToolCall[];
	toolResults?: ToolResult[];
	// Snapshot of the userscript state BEFORE this message was sent
	// Only stored on user messages for revert functionality (reverts to this state)
	scriptSnapshot?: UserscriptSnapshot;
	// Grabbed elements included with this message (for displaying thumbnails)
	grabbedElements?: GrabbedElement[];
}

export interface ToolCall {
	id: string;
	type: "function";
	function: {
		name: "execute_js";
		arguments: string; // JSON string
	};
}

export interface ToolResult {
	toolCallId: string;
	output: string;
}

export interface ChatHistory {
	id: string;
	domain: string; // Domain for quick filtering by current tab
	messages: ChatMessage[];
	initialPrompt: string;
	initialUrl: string;
	initialScreenshot: string; // base64 data URL
	initialHtml: string;
	initialConsoleLog: string;
	createdAt: number;
	updatedAt: number;
}

export interface ExecuteJsRequest {
	type: "EXECUTE_JS";
	tabId: number;
	code: string;
	requestId: string;
}

export interface ExecuteJsResponse {
	type: "EXECUTE_JS_RESPONSE";
	requestId: string;
	result: string;
	error?: string;
}

export interface CapturePageDataRequest {
	type: "CAPTURE_PAGE_DATA";
	tabId: number;
	requestId: string;
	includeScreenshot?: boolean;
}

export interface CapturePageDataResponse {
	type: "CAPTURE_PAGE_DATA_RESPONSE";
	requestId: string;
	screenshot: string;
	html: string;
	consoleLog: string;
	url: string;
}

export interface InjectUserscriptRequest {
	type: "INJECT_USERSCRIPT";
	tabId: number;
	script: string;
}

// Grab Mode types
export interface GrabbedElement {
	xpath: string;
	tagName: string;
	attributes: Record<string, string>;
	textContent: string;
	outerHTML: string; // Full HTML with only data URLs truncated
	screenshot?: string; // Base64 screenshot of just this element
}

export interface GrabModeActivateRequest {
	type: "GRAB_MODE_ACTIVATE";
	tabId: number;
}

export interface GrabModeDeactivateRequest {
	type: "GRAB_MODE_DEACTIVATE";
	tabId: number;
}

export interface GrabModeElementSelectedMessage {
	type: "GRAB_MODE_ELEMENT_SELECTED";
	element: GrabbedElement;
}

export interface GrabModeStateChangeMessage {
	type: "GRAB_MODE_STATE_CHANGE";
	active: boolean;
}

export interface PingRequest {
	type: "PING";
}

export interface PongResponse {
	type: "PONG";
}

export type Message =
	| ExecuteJsRequest
	| ExecuteJsResponse
	| CapturePageDataRequest
	| CapturePageDataResponse
	| InjectUserscriptRequest
	| GrabModeActivateRequest
	| GrabModeDeactivateRequest
	| GrabModeElementSelectedMessage
	| GrabModeStateChangeMessage
	| PingRequest
	| PongResponse;
