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
  getDomainFromUrl,
} from "../utils";

type StatusState = "IDLE" | "SENDING_TO_LLM" | "WAITING_FOR_LLM_RESPONSE" | "RUNNING_JS_ON_PAGE";

export function App() {
  const [userscripts, setUserscripts] = useState<Userscript[]>([]);
  const [chatHistories, setChatHistories] = useState<ChatHistory[]>([]);
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [currentUrl, setCurrentUrl] = useState<string>("");
  const [currentTabId, setCurrentTabId] = useState<number | null>(null);
  const [currentScreenshot, setCurrentScreenshot] = useState<string>("");
  const [showSettings, setShowSettings] = useState(false);
  const [apiUrl, setApiUrl] = useState("https://api.openai.com/v1/chat/completions");
  const [apiKey, setApiKey] = useState("");
  const [modelName, setModelName] = useState("gpt-4o");
  const [editingScript, setEditingScript] = useState<Userscript | null>(null);
  const [pendingApproval, setPendingApproval] = useState<{ code: string; output: string } | null>(null);
  const [awaitingInitialPrompt, setAwaitingInitialPrompt] = useState(false);
  const [status, setStatus] = useState<StatusState>("IDLE");
  const [error, setError] = useState<string | null>(null);
  const [expandedSystemPrompt, setExpandedSystemPrompt] = useState(false);
  const [expandedHtml, setExpandedHtml] = useState(false);
  const chatInputRef = useRef<HTMLInputElement>(null);
  const lastScreenshotCaptureRef = useRef<number>(0);

  const currentChat = currentChatId
    ? chatHistories.find((c) => c.id === currentChatId)
    : null;

  const currentDomain = getDomainFromUrl(currentUrl);
  const domainChatHistories = chatHistories
    .filter((chat) => chat.domain === currentDomain)
    .sort((a, b) => b.updatedAt - a.updatedAt);

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

  // When chat histories change (e.g., new chat created, chat updated),
  // update current chat selection if needed
  useEffect(() => {
    const domain = getDomainFromUrl(currentUrl);
    if (domain && chatHistories.length > 0) {
      const domainChats = chatHistories
        .filter((chat) => chat.domain === domain && chat.initialUrl)
        .sort((a, b) => b.updatedAt - a.updatedAt);

      // If we don't have a current chat or current chat is not for this domain, select most recent
      const currentChatDomain = currentChat?.domain;
      if (!currentChatId || currentChatDomain !== domain) {
        if (domainChats.length > 0) {
          setCurrentChatId(domainChats[0].id);
        } else {
          setCurrentChatId(null);
        }
      }
    } else if (!currentUrl || !domain) {
      // No valid URL/domain, clear chat
      setCurrentChatId(null);
    }
  }, [chatHistories]);

  // Reset expanded states when chat changes
  useEffect(() => {
    setExpandedSystemPrompt(false);
    setExpandedHtml(false);
  }, [currentChatId]);

  const loadData = async () => {
    const scripts = await getUserscripts();
    const histories = await getChatHistories();

    // Filter out incompatible data
    const validScripts = scripts.filter((s: any) => s.chatHistoryId !== undefined);
    const validHistories = histories.filter((h: any) => h.domain);

    setUserscripts(validScripts);
    setChatHistories(validHistories);
    const settings = await getSettings();
    setApiUrl(settings.apiUrl);
    setApiKey(settings.apiKey);
    setModelName(settings.modelName);
  };

  const updateCurrentTab = async () => {
    const tab = await getCurrentTab();
    if (tab) {
      const newUrl = tab.url || "";
      const oldUrl = currentUrl;
      const oldDomain = getDomainFromUrl(oldUrl);
      const newDomain = getDomainFromUrl(newUrl);

      setCurrentUrl(newUrl);
      setCurrentTabId(tab.id || null);

      // Capture screenshot for preview, debounced to max 1x/second to avoid quota limits
      if (tab.id) {
        const now = Date.now();
        const timeSinceLastCapture = now - lastScreenshotCaptureRef.current;

        // Only capture if at least 1 second has passed since last capture
        if (timeSinceLastCapture >= 1000) {
          lastScreenshotCaptureRef.current = now;
          try {
            const pageData = await capturePageData(tab.id, true);
            setCurrentScreenshot(pageData.screenshot);
          } catch (error) {
            console.error("Failed to capture screenshot:", error);
            setCurrentScreenshot("");
          }
        }
      }

      // If domain changed, update the UI
      if (newDomain !== oldDomain) {
        // Clear UI state
        setError(null);
        setAwaitingInitialPrompt(false);
        setExpandedSystemPrompt(false);
        setExpandedHtml(false);
        setPendingApproval(null);

        // Load fresh chat histories and find most recent for this domain
        const histories = await getChatHistories();
        const validHistories = histories.filter((h: any) => h.domain);
        setChatHistories(validHistories);

        if (newDomain) {
          const domainChats = validHistories
            .filter((chat: any) => chat.domain === newDomain && chat.initialUrl)
            .sort((a: any, b: any) => b.updatedAt - a.updatedAt);

          if (domainChats.length > 0) {
            setCurrentChatId(domainChats[0].id);
          } else {
            // No chat for this domain
            setCurrentChatId(null);
          }
        } else {
          setCurrentChatId(null);
        }
      }
    }
  };

  const handleNewChat = async () => {
    if (!currentTabId) return;
    if (!apiKey) {
      setError("Please set your API key in settings first.");
      setShowSettings(true);
      return;
    }

    setError(null);

    // Capture page data first
    const pageData = await capturePageData(currentTabId);

    // Validate we got valid page data
    if (!pageData.url || !pageData.html) {
      // Use the specific error from capturePageData if available
      if (pageData.error) {
        setError(pageData.error);
        return;
      }

      // Check if it's a restricted page
      const tab = await getCurrentTab();
      const url = tab?.url || "";

      if (url.startsWith("chrome://") || url.startsWith("edge://") || url.startsWith("about:") || url.startsWith("chrome-extension://")) {
        setError(`Cannot modify restricted pages like "${url.split("://")[0]}://" URLs. Please navigate to a regular website.`);
      } else if (!url) {
        setError("Failed to capture page data. Please make sure you have a web page open.");
      } else {
        setError("Failed to capture page data. Try reloading the page and clicking 'New Chat' again.");
      }
      return;
    }

    const chatId = generateUUID();
    const scriptId = generateUUID();
    const domain = getDomainFromUrl(pageData.url);

    // Create chat history
    const newChat: ChatHistory = {
      id: chatId,
      domain,
      apiUrl,
      modelName,
      messages: [],
      initialPrompt: "", // Will be filled when user sends first message
      initialUrl: pageData.url,
      initialScreenshot: pageData.screenshot,
      initialHtml: pageData.html,
      initialConsoleLog: pageData.consoleLog,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // Create empty userscript (will be filled when LLM submits)
    const newScript: Userscript = {
      id: scriptId,
      name: `New Script for ${domain}`,
      matchUrls: `https?://${domain.replace(/\./g, "\\.")}.*`, // Default regex for domain
      jsScript: "", // Empty until LLM fills it
      chatHistoryId: chatId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      enabled: false, // Disabled until JS is added
    };

    await saveChatHistory(newChat);
    await saveUserscript(newScript);

    setChatHistories([...chatHistories, newChat]);
    setUserscripts([...userscripts, newScript]);
    setCurrentChatId(chatId);
    setAwaitingInitialPrompt(true);

    // Focus the input field
    setTimeout(() => {
      chatInputRef.current?.focus();
    }, 100);
  };

  const capturePageData = async (tabId: number, includeScreenshot: boolean = true) => {
    const requestId = generateUUID();
    return new Promise<{
      screenshot: string;
      html: string;
      consoleLog: string;
      url: string;
      error?: string;
    }>((resolve) => {
      chrome.runtime.sendMessage(
        {
          type: "CAPTURE_PAGE_DATA",
          tabId,
          requestId,
          includeScreenshot,
        },
        (response) => {
          if (chrome.runtime.lastError) {
            console.error("Error capturing page data:", chrome.runtime.lastError);
            resolve({
              screenshot: "",
              html: "",
              consoleLog: "",
              url: "",
              error: chrome.runtime.lastError.message || "Unknown runtime error",
            });
          } else if (!response) {
            console.error("No response from page capture");
            resolve({
              screenshot: "",
              html: "",
              consoleLog: "",
              url: "",
              error: "No response from content script. The page may not be ready yet.",
            });
          } else if (!response.url) {
            console.error("Invalid response from page capture:", response);
            resolve({
              screenshot: "",
              html: "",
              consoleLog: "",
              url: "",
              error: "Content script returned invalid data. Try reloading the page.",
            });
          } else {
            resolve(response);
          }
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

    // If this is the initial prompt, update the chat
    if (awaitingInitialPrompt && !chat.initialPrompt) {
      chat.initialPrompt = userMessage;
      setAwaitingInitialPrompt(false);
    }

    setStatus("SENDING_TO_LLM");

    // Always capture fresh page data including screenshot for current DOM state
    const currentPageData = pageData || await capturePageData(currentTabId, true);

    // Update last capture time to coordinate with tab update debouncing
    if (!pageData) {
      lastScreenshotCaptureRef.current = Date.now();
    }

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

    // System message with current page state
    messages.push({
      role: "system",
      content: `You are an AI assistant that helps users create custom JavaScript code to modify web pages. You have two tools available:

1. execute_js(code: string) - Execute JavaScript code on the current page and see the output. Use this to test changes and explore the page structure.
2. submit_final_userscript(matchUrls: string, jsScript: string) - Submit the final userscript when ready. matchUrls should be a regex pattern matching the target URLs.

After each execute_js call, ask the user if the changes look correct. If yes, save using submit_final_userscript. If no, continue iterating based on their feedback.

Current page URL: ${currentPageData.url || chat.initialUrl}

Current page HTML (high-entropy strings like data URLs have been truncated):
${currentPageData.html.slice(0, 200000)}

Recent console logs:
${currentPageData.consoleLog.slice(0, 20000)}`,
    });

    // Add initial context if this is the first message (with screenshot)
    if (chat.messages.length === 1 && currentPageData.screenshot) {
      const content: any[] = [
        {
          type: "text",
          text: `User request: ${userMessage}`,
        },
        {
          type: "image_url",
          image_url: {
            url: currentPageData.screenshot,
          },
        },
      ];

      messages.push({
        role: "user",
        content,
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
      setStatus("WAITING_FOR_LLM_RESPONSE");
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

      // Check for API errors
      if (!response.ok || !data.choices || data.choices.length === 0) {
        throw new Error(data.error?.message || `API error: ${response.status} ${response.statusText}`);
      }

      const assistantMessage = data.choices[0].message;

      // Handle tool calls
      if (assistantMessage.tool_calls) {
        for (const toolCall of assistantMessage.tool_calls) {
          if (toolCall.function.name === "execute_js") {
            setStatus("RUNNING_JS_ON_PAGE");
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
            setStatus("IDLE");
            return;
          } else if (toolCall.function.name === "submit_final_userscript") {
            const args = JSON.parse(toolCall.function.arguments);

            // Find existing userscript for this chat (created in handleNewChat)
            const existingScript = userscripts.find((s) => s.chatHistoryId === chatId);

            if (existingScript) {
              // Update existing userscript with LLM's code
              existingScript.matchUrls = args.matchUrls;
              existingScript.jsScript = args.jsScript;
              existingScript.name = chat.initialPrompt?.slice(0, 100) || `Script for ${new URL(chat.initialUrl).hostname}`;
              existingScript.enabled = true; // Enable now that it has code
              existingScript.updatedAt = Date.now();

              await saveUserscript(existingScript);
              setUserscripts([...userscripts]);
            } else {
              // Fallback: create new userscript if somehow it doesn't exist
              const scriptId = generateUUID();
              const newScript: Userscript = {
                id: scriptId,
                name: chat.initialPrompt?.slice(0, 100) || `Script for ${new URL(chat.initialUrl).hostname}`,
                matchUrls: args.matchUrls,
                jsScript: args.jsScript,
                chatHistoryId: chatId,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                enabled: true,
              };

              await saveUserscript(newScript);
              setUserscripts([...userscripts, newScript]);
            }

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
            setStatus("IDLE");
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
        setStatus("IDLE");
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
      setStatus("IDLE");
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
      // Just focus the input field so user can type feedback
      setTimeout(() => {
        chatInputRef.current?.focus();
      }, 100);
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
    if (!currentChatId || !currentTabId) return;
    const input = document.getElementById("chat-input") as HTMLInputElement;
    const message = input.value.trim();
    if (!message) return;
    input.value = "";

    // If this is the first message, we need to send the page data
    const chat = chatHistories.find((c) => c.id === currentChatId);
    if (chat && awaitingInitialPrompt) {
      const pageData = {
        screenshot: chat.initialScreenshot,
        html: chat.initialHtml,
        consoleLog: chat.initialConsoleLog,
        url: chat.initialUrl,
      };
      await sendMessageToLLM(currentChatId, message, pageData);
    } else {
      await sendMessageToLLM(currentChatId, message);
    }
  };

  const handleDeleteScript = async (id: string) => {
    const script = userscripts.find((s) => s.id === id);
    if (!script) return;

    // Delete both the userscript and its associated chat history
    await deleteUserscript(id);
    if (script.chatHistoryId) {
      await deleteChatHistory(script.chatHistoryId);
      setChatHistories(chatHistories.filter((c) => c.id !== script.chatHistoryId));

      // If we're currently viewing this chat, clear it
      if (currentChatId === script.chatHistoryId) {
        setCurrentChatId(null);
      }
    }
    setUserscripts(userscripts.filter((s) => s.id !== id));
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
        <div className="flex items-center gap-3">
          {/* Status Indicator */}
          <div className="flex items-center gap-2 text-xs">
            <div className={`w-2 h-2 rounded-full ${
              status === "IDLE" ? "bg-green-500" :
              status === "SENDING_TO_LLM" ? "bg-yellow-500 animate-pulse" :
              status === "WAITING_FOR_LLM_RESPONSE" ? "bg-blue-500 animate-pulse" :
              "bg-purple-500 animate-pulse"
            }`} />
            <span className="text-gray-600">
              {status === "IDLE" ? "Idle" :
               status === "SENDING_TO_LLM" ? "Sending..." :
               status === "WAITING_FOR_LLM_RESPONSE" ? "Waiting..." :
               "Running JS..."}
            </span>
          </div>
          <button
            onClick={() => setShowSettings(true)}
            className="px-3 py-1 text-sm bg-gray-100 hover:bg-gray-200 rounded"
          >
            Settings
          </button>
        </div>
      </div>

      {/* Current Page Info */}
      {currentUrl && (
        <div className="bg-white border-b border-gray-200 p-3 flex items-center gap-3">
          {currentScreenshot && (
            <img
              src={currentScreenshot}
              alt="Page preview"
              className="w-16 h-12 object-cover rounded border border-gray-200"
            />
          )}
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium text-gray-500">Current Page</div>
            <div className="text-sm truncate">{currentUrl}</div>
          </div>
        </div>
      )}

      {/* Error Banner */}
      {error && (
        <div className="bg-red-50 border-b border-red-200 p-3 flex items-center justify-between">
          <div className="text-sm text-red-800">{error}</div>
          <button
            onClick={() => setError(null)}
            className="text-red-600 hover:text-red-800 text-xs font-semibold"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Chat Histories & Userscripts */}
      <div className="bg-white border-b border-gray-200 p-4 max-h-[40vh] overflow-y-auto">
        {/* Chat Histories Section */}
        <div className="mb-4">
          <div className="flex justify-between items-center mb-2">
            <h2 className="text-sm font-semibold text-purple-900">Chat Histories</h2>
            <button
              onClick={handleNewChat}
              className="px-3 py-1 text-xs bg-purple-500 text-white rounded hover:bg-purple-600"
            >
              New Chat
            </button>
          </div>
          {domainChatHistories.length === 0 ? (
            <p className="text-xs text-gray-500">No chats for this domain</p>
          ) : (
            <div className="space-y-1">
              {domainChatHistories.map((chat) => (
                <div
                  key={chat.id}
                  onClick={() => setCurrentChatId(chat.id)}
                  className={`p-2 rounded text-xs cursor-pointer border ${
                    currentChatId === chat.id
                      ? "bg-purple-50 border-purple-300"
                      : "bg-purple-50/30 border-purple-100 hover:bg-purple-50/60"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-purple-900 truncate">
                        {chat.initialPrompt || "New chat"}
                      </div>
                      <div className="text-purple-600 font-mono text-[10px]">
                        {chat.id.slice(0, 8)}
                      </div>
                      <div className="text-purple-500 text-[10px]">
                        {chat.messages.length} messages
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Userscripts Section */}
        <div>
          <h2 className="text-sm font-semibold text-blue-900 mb-2">Active Userscripts</h2>
          {matchingUserscripts.length === 0 ? (
            <p className="text-xs text-gray-500">No scripts for this page</p>
          ) : (
            <div className="space-y-1">
              {matchingUserscripts.map((script) => (
                <div key={script.id} className="flex items-center gap-2 p-2 bg-blue-50 border border-blue-100 rounded text-xs">
                  <input
                    type="checkbox"
                    checked={script.enabled}
                    onChange={() => handleToggleScript(script)}
                    className="w-4 h-4"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-blue-900 truncate">{script.name}</div>
                    <div className="text-blue-600 font-mono text-[10px]">{script.id.slice(0, 8)}</div>
                    {script.chatHistoryId && (
                      <div className="text-blue-500 text-[10px]">
                        from chat: {script.chatHistoryId.slice(0, 8)}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => setEditingScript(script)}
                    className="px-2 py-1 text-xs bg-blue-200 text-blue-900 rounded hover:bg-blue-300"
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
      </div>

      {/* Chat Interface */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {currentChat ? (
          <>
            {/* Chat Info Header */}
            <div className="bg-white border-b border-gray-200 p-3 flex items-center justify-between">
              <div className="text-xs text-gray-500">
                Chat: <span className="font-mono">{currentChat.id.slice(0, 8)}</span>
              </div>
              <button
                onClick={async () => {
                  currentChat.messages = [];
                  currentChat.updatedAt = Date.now();
                  await saveChatHistory(currentChat);
                  setChatHistories([...chatHistories]);
                  setPendingApproval(null);
                }}
                className="px-2 py-1 text-xs bg-red-100 text-red-600 rounded hover:bg-red-200"
              >
                Clear Chat
              </button>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {/* Show system prompt with initial context */}
              {currentChat.initialUrl && currentChat.messages.length > 0 && (
                <div className="text-sm">
                  <div className="bg-gray-100 p-3 rounded-lg">
                    <details className="text-xs">
                      <summary className="cursor-pointer font-medium text-gray-700 mb-1">
                        System Context
                      </summary>
                      <div className="mt-2 space-y-2">
                        <div>
                          <div className="font-medium text-gray-600">System Prompt:</div>
                          <div
                            className="text-gray-800 mt-1 cursor-pointer hover:bg-gray-50 p-1 rounded"
                            onClick={() => setExpandedSystemPrompt(!expandedSystemPrompt)}
                            title="Click to expand/collapse"
                          >
                            {expandedSystemPrompt ? (
                              `You are an AI assistant that helps users create custom JavaScript code to modify web pages. You have two tools available:

1. execute_js(code: string) - Execute JavaScript code on the current page and see the output. Use this to test changes and explore the page structure.
2. submit_final_userscript(matchUrls: string, jsScript: string) - Submit the final userscript when ready. matchUrls should be a regex pattern matching the target URLs.

After each execute_js call, ask the user if the changes look correct. If yes, save using submit_final_userscript. If no, continue iterating based on their feedback.`
                            ) : (
                              "You are an AI assistant that helps users create custom JavaScript code to modify web pages..."
                            )}
                          </div>
                        </div>
                        <div>
                          <div className="font-medium text-gray-600">Initial URL:</div>
                          <div className="text-gray-800 mt-1 break-all">{currentChat.initialUrl}</div>
                        </div>
                        {currentChat.initialHtml && (
                          <div>
                            <div className="font-medium text-gray-600">HTML:</div>
                            <div
                              className="text-gray-800 mt-1 font-mono text-[10px] max-h-60 overflow-y-auto bg-white p-2 rounded cursor-pointer hover:bg-gray-50"
                              onClick={() => setExpandedHtml(!expandedHtml)}
                              title="Click to expand/collapse"
                            >
                              {expandedHtml ? currentChat.initialHtml : `${currentChat.initialHtml.slice(0, 500)}...`}
                            </div>
                          </div>
                        )}
                        {currentChat.initialScreenshot && (
                          <div>
                            <div className="font-medium text-gray-600 mb-1">Screenshot:</div>
                            <img
                              src={currentChat.initialScreenshot}
                              alt="Initial page"
                              className="max-w-full rounded border border-gray-300"
                            />
                          </div>
                        )}
                      </div>
                    </details>
                  </div>
                </div>
              )}

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
              {awaitingInitialPrompt && (
                <div className="mb-2 text-xs text-gray-600 bg-blue-50 p-2 rounded">
                  What would you like to change on this page? Describe the modifications you want to make.
                </div>
              )}
              <div className="flex gap-2">
                <input
                  ref={chatInputRef}
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
