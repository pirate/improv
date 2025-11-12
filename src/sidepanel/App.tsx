import { useState, useEffect, useRef } from "react";
import type { Userscript, ChatHistory, ChatMessage } from "../types";
import {
  getUserscripts,
  saveUserscript,
  deleteUserscript,
  getChatHistories,
  saveChatHistory,
  deleteChatHistory,
  getSettings,
  saveSettings,
  generateUUID,
  urlMatchesPattern,
  getCurrentTab,
} from "../utils";

export function App() {
  const [userscripts, setUserscripts] = useState<Userscript[]>([]);
  const [chatHistories, setChatHistories] = useState<ChatHistory[]>([]);
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [currentUrl, setCurrentUrl] = useState<string>("");
  const [currentTabId, setCurrentTabId] = useState<number | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [apiUrl, setApiUrl] = useState("https://api.openai.com/v1/chat/completions");
  const [apiKey, setApiKey] = useState("");
  const [modelName, setModelName] = useState("gpt-4o");
  const [editingScript, setEditingScript] = useState<Userscript | null>(null);
  const [pendingApproval, setPendingApproval] = useState<{ code: string; output: string } | null>(null);

  const currentChat = currentChatId
    ? chatHistories.find((c) => c.id === currentChatId)
    : null;

  const matchingUserscripts = userscripts.filter((script) =>
    urlMatchesPattern(currentUrl, script.matchUrls)
  );

  useEffect(() => {
    loadData();
    updateCurrentTab();

    // Listen for tab changes
    const handleTabUpdate = () => {
      updateCurrentTab();
    };
    chrome.tabs.onActivated.addListener(handleTabUpdate);
    chrome.tabs.onUpdated.addListener(handleTabUpdate);

    return () => {
      chrome.tabs.onActivated.removeListener(handleTabUpdate);
      chrome.tabs.onUpdated.removeListener(handleTabUpdate);
    };
  }, []);

  const loadData = async () => {
    const scripts = await getUserscripts();
    setUserscripts(scripts);
    const histories = await getChatHistories();
    setChatHistories(histories);
    const settings = await getSettings();
    setApiUrl(settings.apiUrl);
    setApiKey(settings.apiKey);
    setModelName(settings.modelName);
  };

  const updateCurrentTab = async () => {
    const tab = await getCurrentTab();
    if (tab) {
      setCurrentUrl(tab.url || "");
      setCurrentTabId(tab.id || null);
    }
  };

  const handleNewChat = async () => {
    if (!currentTabId) return;
    if (!apiKey) {
      alert("Please set your API key in settings first.");
      setShowSettings(true);
      return;
    }

    const userPrompt = prompt("What would you like to change on this page?");
    if (!userPrompt) return;

    // Capture page data
    const pageData = await capturePageData(currentTabId);

    const chatId = generateUUID();
    const newChat: ChatHistory = {
      id: chatId,
      userscriptId: null,
      apiUrl,
      modelName,
      messages: [],
      initialPrompt: userPrompt,
      initialUrl: pageData.url,
      initialScreenshot: pageData.screenshot,
      initialHtml: pageData.html,
      initialConsoleLog: pageData.consoleLog,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await saveChatHistory(newChat);
    setChatHistories([...chatHistories, newChat]);
    setCurrentChatId(chatId);

    // Start the conversation
    await sendMessageToLLM(chatId, userPrompt, pageData);
  };

  const capturePageData = async (tabId: number) => {
    const requestId = generateUUID();
    return new Promise<{
      screenshot: string;
      html: string;
      consoleLog: string;
      url: string;
    }>((resolve) => {
      chrome.runtime.sendMessage(
        {
          type: "CAPTURE_PAGE_DATA",
          tabId,
          requestId,
        },
        (response) => {
          resolve(response);
        }
      );
    });
  };

  const executeJs = async (tabId: number, code: string): Promise<{ result: string; error?: string }> => {
    const requestId = generateUUID();
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          type: "EXECUTE_JS",
          tabId,
          code,
          requestId,
        },
        (response) => {
          resolve(response);
        }
      );
    });
  };

  const sendMessageToLLM = async (
    chatId: string,
    userMessage: string,
    pageData?: { screenshot: string; html: string; consoleLog: string; url: string }
  ) => {
    const chat = chatHistories.find((c) => c.id === chatId);
    if (!chat || !currentTabId) return;

    // Add user message
    const userMsg: ChatMessage = {
      id: generateUUID(),
      role: "user",
      content: userMessage,
      timestamp: Date.now(),
    };

    chat.messages.push(userMsg);
    chat.updatedAt = Date.now();
    await saveChatHistory(chat);
    setChatHistories([...chatHistories]);

    // Prepare messages for API
    const messages = [];

    // System message
    messages.push({
      role: "system",
      content: `You are an AI assistant that helps users create custom JavaScript code to modify web pages. You have two tools available:

1. execute_js(code: string) - Execute JavaScript code on the current page and see the output. Use this to test changes and explore the page structure.
2. submit_final_userscript(matchUrls: string, jsScript: string) - Submit the final userscript when ready. matchUrls should be a regex pattern matching the target URLs.

After each execute_js call, ask the user if the changes look correct. If yes, save using submit_final_userscript. If no, continue iterating based on their feedback.

Current page URL: ${pageData?.url || chat.initialUrl}`,
    });

    // Add initial context if this is the first message
    if (chat.messages.length === 1 && pageData) {
      messages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: `User request: ${userMessage}

Page HTML (truncated):
${pageData.html.slice(0, 10000)}

Console logs:
${pageData.consoleLog.slice(0, 2000)}`,
          },
          {
            type: "image_url",
            image_url: {
              url: pageData.screenshot,
            },
          },
        ],
      });
    } else {
      // Add conversation history
      for (const msg of chat.messages) {
        if (msg.role === "user" && msg !== userMsg) {
          messages.push({ role: "user", content: msg.content });
        } else if (msg.role === "assistant") {
          const assistantMsg: any = { role: "assistant", content: msg.content };
          if (msg.toolCalls) {
            assistantMsg.tool_calls = msg.toolCalls.map((tc) => ({
              id: tc.id,
              type: tc.type,
              function: {
                name: tc.function.name,
                arguments: tc.function.arguments,
              },
            }));
          }
          messages.push(assistantMsg);
        }
        // Add tool results
        if (msg.toolResults) {
          for (const result of msg.toolResults) {
            messages.push({
              role: "tool",
              tool_call_id: result.toolCallId,
              content: result.output,
            });
          }
        }
      }
      messages.push({ role: "user", content: userMessage });
    }

    // Call OpenAI API
    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: modelName,
          messages,
          tools: [
            {
              type: "function",
              function: {
                name: "execute_js",
                description: "Execute JavaScript code on the current page to test changes",
                parameters: {
                  type: "object",
                  properties: {
                    code: {
                      type: "string",
                      description: "The JavaScript code to execute",
                    },
                  },
                  required: ["code"],
                },
              },
            },
            {
              type: "function",
              function: {
                name: "submit_final_userscript",
                description: "Submit the final userscript when the changes are approved by the user",
                parameters: {
                  type: "object",
                  properties: {
                    matchUrls: {
                      type: "string",
                      description: "Regex pattern for matching URLs where this script should run",
                    },
                    jsScript: {
                      type: "string",
                      description: "The final JavaScript code for the userscript",
                    },
                  },
                  required: ["matchUrls", "jsScript"],
                },
              },
            },
          ],
        }),
      });

      const data = await response.json();
      const assistantMessage = data.choices[0].message;

      // Handle tool calls
      if (assistantMessage.tool_calls) {
        for (const toolCall of assistantMessage.tool_calls) {
          if (toolCall.function.name === "execute_js") {
            const args = JSON.parse(toolCall.function.arguments);
            const result = await executeJs(currentTabId, args.code);

            // Store pending approval
            setPendingApproval({
              code: args.code,
              output: result.error || result.result,
            });

            // Add assistant message with tool call
            const assistantMsg: ChatMessage = {
              id: generateUUID(),
              role: "assistant",
              content: assistantMessage.content || "",
              timestamp: Date.now(),
              toolCalls: assistantMessage.tool_calls.map((tc: any) => ({
                id: tc.id,
                type: tc.type,
                function: {
                  name: tc.function.name,
                  arguments: tc.function.arguments,
                },
              })),
              toolResults: [
                {
                  toolCallId: toolCall.id,
                  output: result.error ? `Error: ${result.error}` : result.result,
                },
              ],
            };

            chat.messages.push(assistantMsg);
            chat.updatedAt = Date.now();
            await saveChatHistory(chat);
            setChatHistories([...chatHistories]);
            return;
          } else if (toolCall.function.name === "submit_final_userscript") {
            const args = JSON.parse(toolCall.function.arguments);

            // Create userscript
            const scriptId = generateUUID();
            const newScript: Userscript = {
              id: scriptId,
              name: `Script for ${new URL(chat.initialUrl).hostname}`,
              matchUrls: args.matchUrls,
              jsScript: args.jsScript,
              createdAt: Date.now(),
              updatedAt: Date.now(),
              enabled: true,
            };

            await saveUserscript(newScript);
            setUserscripts([...userscripts, newScript]);

            // Link chat to userscript
            chat.userscriptId = scriptId;
            chat.updatedAt = Date.now();
            await saveChatHistory(chat);
            setChatHistories([...chatHistories]);

            // Add success message
            const successMsg: ChatMessage = {
              id: generateUUID(),
              role: "assistant",
              content: "Userscript created successfully! It will now run automatically on matching pages.",
              timestamp: Date.now(),
            };
            chat.messages.push(successMsg);
            await saveChatHistory(chat);
            setChatHistories([...chatHistories]);
            return;
          }
        }
      } else {
        // Regular assistant message
        const assistantMsg: ChatMessage = {
          id: generateUUID(),
          role: "assistant",
          content: assistantMessage.content,
          timestamp: Date.now(),
        };
        chat.messages.push(assistantMsg);
        chat.updatedAt = Date.now();
        await saveChatHistory(chat);
        setChatHistories([...chatHistories]);
      }
    } catch (error) {
      console.error("Error calling LLM:", error);
      const errorMsg: ChatMessage = {
        id: generateUUID(),
        role: "assistant",
        content: `Error: ${error instanceof Error ? error.message : String(error)}`,
        timestamp: Date.now(),
      };
      chat.messages.push(errorMsg);
      await saveChatHistory(chat);
      setChatHistories([...chatHistories]);
    }
  };

  const handleApprove = async () => {
    if (!currentChatId) return;
    setPendingApproval(null);
    await sendMessageToLLM(currentChatId, "Yes, that looks correct. Please save this as a userscript.");
  };

  const handleReject = async (action: "continue" | "refresh") => {
    setPendingApproval(null);
    if (action === "continue") {
      const feedback = prompt("What needs to be changed?");
      if (feedback && currentChatId) {
        await sendMessageToLLM(currentChatId, feedback);
      }
    } else if (action === "refresh" && currentChatId) {
      // Reset chat and try again
      const chat = chatHistories.find((c) => c.id === currentChatId);
      if (chat && currentTabId) {
        chat.messages = [];
        chat.updatedAt = Date.now();
        await saveChatHistory(chat);
        setChatHistories([...chatHistories]);

        const pageData = await capturePageData(currentTabId);
        await sendMessageToLLM(currentChatId, chat.initialPrompt, pageData);
      }
    }
  };

  const handleSendMessage = async () => {
    if (!currentChatId) return;
    const input = document.getElementById("chat-input") as HTMLInputElement;
    const message = input.value.trim();
    if (!message) return;
    input.value = "";
    await sendMessageToLLM(currentChatId, message);
  };

  const handleDeleteScript = async (id: string) => {
    if (confirm("Delete this userscript?")) {
      await deleteUserscript(id);
      setUserscripts(userscripts.filter((s) => s.id !== id));
      setChatHistories(chatHistories.filter((c) => c.userscriptId !== id));
    }
  };

  const handleToggleScript = async (script: Userscript) => {
    script.enabled = !script.enabled;
    script.updatedAt = Date.now();
    await saveUserscript(script);
    setUserscripts([...userscripts]);
  };

  const handleSaveSettings = async () => {
    await saveSettings({ apiUrl, apiKey, modelName });
    setShowSettings(false);
  };

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 p-4 flex justify-between items-center">
        <h1 className="text-lg font-semibold">Improv</h1>
        <button
          onClick={() => setShowSettings(true)}
          className="px-3 py-1 text-sm bg-gray-100 hover:bg-gray-200 rounded"
        >
          Settings
        </button>
      </div>

      {/* Userscripts List */}
      <div className="bg-white border-b border-gray-200 p-4 max-h-[33vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-3">
          <h2 className="text-sm font-semibold">Active Userscripts</h2>
          <button
            onClick={handleNewChat}
            className="px-3 py-1 text-xs bg-blue-500 text-white rounded hover:bg-blue-600"
          >
            New Script
          </button>
        </div>
        {matchingUserscripts.length === 0 ? (
          <p className="text-xs text-gray-500">No scripts for this page</p>
        ) : (
          <div className="space-y-2">
            {matchingUserscripts.map((script) => (
              <div key={script.id} className="flex items-center gap-2 p-2 bg-gray-50 rounded text-xs">
                <input
                  type="checkbox"
                  checked={script.enabled}
                  onChange={() => handleToggleScript(script)}
                  className="w-4 h-4"
                />
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{script.name}</div>
                  <div className="text-gray-500 truncate">{script.matchUrls}</div>
                </div>
                <button
                  onClick={() => setEditingScript(script)}
                  className="px-2 py-1 text-xs bg-gray-200 rounded hover:bg-gray-300"
                >
                  Edit
                </button>
                <button
                  onClick={() => handleDeleteScript(script.id)}
                  className="px-2 py-1 text-xs bg-red-100 text-red-600 rounded hover:bg-red-200"
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Chat Interface */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {currentChat ? (
          <>
            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {currentChat.messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`text-sm ${
                    msg.role === "user" ? "text-right" : "text-left"
                  }`}
                >
                  <div
                    className={`inline-block max-w-[80%] p-3 rounded-lg ${
                      msg.role === "user"
                        ? "bg-blue-500 text-white"
                        : "bg-gray-200 text-gray-800"
                    }`}
                  >
                    <div className="whitespace-pre-wrap">{msg.content}</div>
                    {msg.toolResults && (
                      <div className="mt-2 p-2 bg-black/10 rounded text-xs font-mono">
                        {msg.toolResults.map((r) => r.output).join("\n")}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Approval UI */}
            {pendingApproval && (
              <div className="border-t border-gray-200 bg-yellow-50 p-4">
                <div className="text-sm font-medium mb-2">Does this look correct?</div>
                <div className="text-xs bg-white p-2 rounded mb-3 font-mono max-h-32 overflow-y-auto">
                  {pendingApproval.output}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={handleApprove}
                    className="flex-1 px-3 py-2 text-sm bg-green-500 text-white rounded hover:bg-green-600"
                  >
                    Yes, save it
                  </button>
                  <button
                    onClick={() => handleReject("continue")}
                    className="flex-1 px-3 py-2 text-sm bg-orange-500 text-white rounded hover:bg-orange-600"
                  >
                    Keep trying
                  </button>
                  <button
                    onClick={() => handleReject("refresh")}
                    className="flex-1 px-3 py-2 text-sm bg-red-500 text-white rounded hover:bg-red-600"
                  >
                    Refresh & retry
                  </button>
                </div>
              </div>
            )}

            {/* Input */}
            <div className="border-t border-gray-200 p-4 bg-white">
              <div className="flex gap-2">
                <input
                  id="chat-input"
                  type="text"
                  placeholder="Type your message..."
                  className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                  onKeyPress={(e) => e.key === "Enter" && handleSendMessage()}
                />
                <button
                  onClick={handleSendMessage}
                  className="px-4 py-2 text-sm bg-blue-500 text-white rounded hover:bg-blue-600"
                >
                  Send
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">
            Click "New Script" to start creating a userscript
          </div>
        )}
      </div>

      {/* Settings Modal */}
      {showSettings && (
        <div className="absolute inset-0 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6">
            <h2 className="text-lg font-semibold mb-4">Settings</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">API URL</label>
                <input
                  type="text"
                  value={apiUrl}
                  onChange={(e) => setApiUrl(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">API Key</label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Model Name</label>
                <input
                  type="text"
                  value={modelName}
                  onChange={(e) => setModelName(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
            <div className="flex gap-2 mt-6">
              <button
                onClick={handleSaveSettings}
                className="flex-1 px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
              >
                Save
              </button>
              <button
                onClick={() => setShowSettings(false)}
                className="flex-1 px-4 py-2 bg-gray-200 rounded hover:bg-gray-300"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Script Modal */}
      {editingScript && (
        <div className="absolute inset-0 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full p-6 max-h-[90vh] overflow-y-auto">
            <h2 className="text-lg font-semibold mb-4">Edit Userscript</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Name</label>
                <input
                  type="text"
                  value={editingScript.name}
                  onChange={(e) =>
                    setEditingScript({ ...editingScript, name: e.target.value })
                  }
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Match URLs (Regex)</label>
                <input
                  type="text"
                  value={editingScript.matchUrls}
                  onChange={(e) =>
                    setEditingScript({ ...editingScript, matchUrls: e.target.value })
                  }
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">JavaScript Code</label>
                <textarea
                  value={editingScript.jsScript}
                  onChange={(e) =>
                    setEditingScript({ ...editingScript, jsScript: e.target.value })
                  }
                  rows={15}
                  className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
            <div className="flex gap-2 mt-6">
              <button
                onClick={async () => {
                  editingScript.updatedAt = Date.now();
                  await saveUserscript(editingScript);
                  setUserscripts([...userscripts]);
                  setEditingScript(null);
                }}
                className="flex-1 px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
              >
                Save
              </button>
              <button
                onClick={() => setEditingScript(null)}
                className="flex-1 px-4 py-2 bg-gray-200 rounded hover:bg-gray-300"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
