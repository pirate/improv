export interface Userscript {
  id: string;
  name: string;
  matchUrls: string; // Regex pattern as string
  jsScript: string;
  chatHistoryId: string | null; // null if created manually, otherwise references the chat it came from
  createdAt: number;
  updatedAt: number;
  enabled: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: "execute_js" | "submit_final_userscript";
    arguments: string; // JSON string
  };
}

export interface ToolResult {
  toolCallId: string;
  output: string;
}

export interface ChatHistory {
  id: string;
  domain: string; // Domain of the page (e.g., "example.com")
  apiUrl: string;
  modelName: string;
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

export type Message =
  | ExecuteJsRequest
  | ExecuteJsResponse
  | CapturePageDataRequest
  | CapturePageDataResponse
  | InjectUserscriptRequest;

export interface AppState {
  userscripts: Userscript[];
  chatHistories: ChatHistory[];
  currentChatId: string | null;
  apiUrl: string;
  apiKey: string;
  modelName: string;
}
