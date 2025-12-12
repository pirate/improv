import { useEffect, useRef, useState } from "react";
import {
	clearScriptCache,
	fetchRepositoryScripts,
	fetchScriptCode,
} from "../services/repositories";
import type {
	ChatHistory,
	ChatMessage,
	GrabbedElement,
	RepositoryScript,
	Userscript,
	UserscriptSnapshot,
} from "../types";
import {
	deleteChatHistory,
	deleteUserscript,
	generateUUID,
	getChatHistories,
	getCurrentTab,
	getDomainFromUrl,
	getSettings,
	getUserscripts,
	prepareHtmlForLLM,
	saveChatHistory,
	saveSettings,
	saveUserscript,
	urlMatchesPattern,
} from "../utils";
import {
	metadataToMatchRegex,
	parseUserscriptMetadata,
} from "../utils/userscriptParser";

type StatusState =
	| "IDLE"
	| "SENDING_TO_LLM"
	| "WAITING_FOR_LLM_RESPONSE"
	| "RUNNING_JS_ON_PAGE";

export function App() {
	const [userscripts, setUserscripts] = useState<Userscript[]>([]);
	const [chatHistories, setChatHistories] = useState<ChatHistory[]>([]);
	const [currentChatId, setCurrentChatId] = useState<string | null>(null);
	const [currentUrl, setCurrentUrl] = useState<string>("");
	const [currentTabId, setCurrentTabId] = useState<number | null>(null);
	const [currentScreenshot, setCurrentScreenshot] = useState<string>("");
	const [showSettings, setShowSettings] = useState(false);
	const [apiUrl, setApiUrl] = useState(
		"https://api.openai.com/v1/chat/completions",
	);
	const [apiKey, setApiKey] = useState("");
	const [modelName, setModelName] = useState("gpt-5.2");

	const [pendingApproval, setPendingApprovalState] = useState<{
		code: string;
		output: string;
	} | null>(null);

	// Restore pendingApproval from chrome.storage.session on mount
	useEffect(() => {
		chrome.storage.session.get("pendingApproval").then((result) => {
			if (result.pendingApproval) {
				setPendingApprovalState(result.pendingApproval);
			}
		});
	}, []);

	// Wrapper to persist pendingApproval to chrome.storage.session
	const setPendingApproval = (
		value: { code: string; output: string } | null,
	) => {
		if (value) {
			chrome.storage.session.set({ pendingApproval: value });
		} else {
			chrome.storage.session.remove("pendingApproval");
		}
		setPendingApprovalState(value);
	};
	const [rejectionFeedback, setRejectionFeedback] = useState("");
	const [awaitingInitialPrompt, setAwaitingInitialPrompt] = useState(false);
	const [status, setStatus] = useState<StatusState>("IDLE");
	const [error, setError] = useState<string | null>(null);
	const [expandedSystemPrompt, setExpandedSystemPrompt] = useState(false);
	const [expandedHtml, setExpandedHtml] = useState(false);
	const [repositoryScripts, setRepositoryScripts] = useState<
		RepositoryScript[]
	>([]);
	const [repositoryLoading, setRepositoryLoading] = useState(false);
	const [repositoryError, setRepositoryError] = useState<string | null>(null);
	const [repositoryExpanded, setRepositoryExpanded] = useState(true);
	const [importingScriptId, setImportingScriptId] = useState<number | null>(
		null,
	);
	const [repositorySortBy, setRepositorySortBy] = useState<
		"installs" | "rating" | "updated"
	>("updated");
	// Grab mode state
	const [grabModeActive, setGrabModeActive] = useState(false);
	const [grabbedElements, setGrabbedElements] = useState<GrabbedElement[]>([]);
	const [grabScreenshot, setGrabScreenshot] = useState<string | null>(null);
	// Edit message state
	const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
	const [editingMessageContent, setEditingMessageContent] = useState("");
	const chatInputRef = useRef<HTMLTextAreaElement>(null);
	const editInputRef = useRef<HTMLTextAreaElement>(null);
	const messagesContainerRef = useRef<HTMLDivElement>(null);
	// Abort controller for cancelling LLM requests
	const abortControllerRef = useRef<AbortController | null>(null);
	const lastScreenshotCaptureRef = useRef<number>(0);
	// Script execution results (scriptId -> { success, error?, timestamp })
	const [scriptExecutionResults, setScriptExecutionResults] = useState<
		Record<string, { success: boolean; error?: string; timestamp: number }>
	>({});

	const currentChat = currentChatId
		? chatHistories.find((c) => c.id === currentChatId)
		: null;

	const currentDomain = getDomainFromUrl(currentUrl);
	const domainChatHistories = chatHistories
		.filter((chat) => chat.domain === currentDomain)
		.sort((a, b) => b.updatedAt - a.updatedAt);

	const matchingUserscripts = userscripts.filter((script) =>
		urlMatchesPattern(currentUrl, script.matchUrls),
	);

	// Helper to clear execution result for a script (called when script is modified)
	const clearExecutionResult = async (scriptId: string) => {
		setScriptExecutionResults((prev) => {
			const updated = { ...prev };
			delete updated[scriptId];
			return updated;
		});
		// Also update chrome.storage.session
		const stored = await chrome.storage.session.get("scriptExecutionResults");
		const results = stored.scriptExecutionResults || {};
		delete results[scriptId];
		await chrome.storage.session.set({ scriptExecutionResults: results });
	};

	useEffect(() => {
		loadData();
		updateCurrentTab();

		// Load script execution results from session storage
		chrome.storage.session.get("scriptExecutionResults").then((result) => {
			if (result.scriptExecutionResults) {
				setScriptExecutionResults(result.scriptExecutionResults);
			}
		});

		// Listen for tab changes
		const handleTabUpdate = () => {
			updateCurrentTab();
		};
		chrome.tabs.onActivated.addListener(handleTabUpdate);
		chrome.tabs.onUpdated.addListener(handleTabUpdate);

		// Listen for script execution result updates
		const handleMessage = (message: {
			type: string;
			scriptId?: string;
			success?: boolean;
			error?: string;
			timestamp?: number;
		}) => {
			if (message.type === "SCRIPT_EXECUTION_RESULT" && message.scriptId) {
				setScriptExecutionResults((prev) => ({
					...prev,
					[message.scriptId as string]: {
						success: message.success ?? false,
						error: message.error,
						timestamp: message.timestamp ?? Date.now(),
					},
				}));
			}
		};
		chrome.runtime.onMessage.addListener(handleMessage);

		return () => {
			chrome.tabs.onActivated.removeListener(handleTabUpdate);
			chrome.tabs.onUpdated.removeListener(handleTabUpdate);
			chrome.runtime.onMessage.removeListener(handleMessage);
		};
	}, []);

	// When chat histories change (e.g., new chat created, chat updated),
	// update current chat selection if needed
	useEffect(() => {
		const domain = getDomainFromUrl(currentUrl);
		if (domain && chatHistories.length > 0) {
			const domainChats = chatHistories
				.filter((chat) => chat.domain === domain)
				.sort((a, b) => b.updatedAt - a.updatedAt);

			// Check if current chat is valid for this domain
			const currentChatIsValid =
				currentChatId && domainChats.some((chat) => chat.id === currentChatId);

			// If we don't have a valid current chat for this domain, select most recent
			if (!currentChatIsValid) {
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
	}, [chatHistories, currentUrl, currentChatId]);

	// Reset expanded states when chat changes
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset on chat change
	useEffect(() => {
		setExpandedSystemPrompt(false);
		setExpandedHtml(false);
	}, [currentChatId]);

	// Fetch repository scripts when domain changes
	useEffect(() => {
		const fetchRepoScripts = async () => {
			if (!currentDomain) {
				setRepositoryScripts([]);
				return;
			}

			setRepositoryLoading(true);
			setRepositoryError(null);

			try {
				const scripts = await fetchRepositoryScripts(currentDomain);
				setRepositoryScripts(scripts);
			} catch (err) {
				console.error("Failed to fetch repository scripts:", err);
				setRepositoryError(
					err instanceof Error ? err.message : "Failed to fetch scripts",
				);
				setRepositoryScripts([]);
			} finally {
				setRepositoryLoading(false);
			}
		};

		fetchRepoScripts();
	}, [currentDomain]);

	// Listen for grab mode element selection and state changes
	useEffect(() => {
		const handleMessage = (message: {
			type: string;
			element?: GrabbedElement;
			active?: boolean;
			screenshot?: string;
		}) => {
			// Handle element selection with screenshot (from background script)
			if (
				message.type === "GRAB_MODE_ELEMENT_SELECTED_WITH_SCREENSHOT" &&
				message.element
			) {
				const element = message.element;
				// Add the element to grabbed elements list
				setGrabbedElements((prev) => {
					// Check if element already exists (by xpath)
					const exists = prev.some((e) => e.xpath === element.xpath);
					if (exists) return prev;
					return [...prev, element];
				});
				// Store the screenshot (with purple highlight visible)
				if (message.screenshot) {
					setGrabScreenshot(message.screenshot);
				}
			}
			// Handle grab mode state change (e.g., user pressed Escape)
			if (message.type === "GRAB_MODE_STATE_CHANGE") {
				setGrabModeActive(message.active ?? false);
			}
		};

		chrome.runtime.onMessage.addListener(handleMessage);
		return () => {
			chrome.runtime.onMessage.removeListener(handleMessage);
		};
	}, []);

	// Track previous tab ID to detect actual tab changes
	const prevTabIdRef = useRef<number | null>(null);

	// Deactivate grab mode when tab actually changes (not on initial load)
	useEffect(() => {
		if (
			prevTabIdRef.current !== null &&
			prevTabIdRef.current !== currentTabId &&
			grabModeActive
		) {
			setGrabModeActive(false);
			if (prevTabIdRef.current) {
				chrome.runtime.sendMessage({
					type: "GRAB_MODE_DEACTIVATE",
					tabId: prevTabIdRef.current,
				});
			}
		}
		prevTabIdRef.current = currentTabId;
	}, [currentTabId, grabModeActive]);

	// Handle Escape key for various actions
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				// First priority: abort LLM request if waiting
				if (
					status === "SENDING_TO_LLM" ||
					status === "WAITING_FOR_LLM_RESPONSE"
				) {
					e.preventDefault();
					if (abortControllerRef.current) {
						abortControllerRef.current.abort();
						abortControllerRef.current = null;
					}
					setStatus("IDLE");
					return;
				}

				// Second priority: exit grab mode
				if (grabModeActive && currentTabId) {
					e.preventDefault();
					setGrabModeActive(false);
					chrome.runtime.sendMessage({
						type: "GRAB_MODE_DEACTIVATE",
						tabId: currentTabId,
					});
					return;
				}
			}
		};

		document.addEventListener("keydown", handleKeyDown);
		return () => {
			document.removeEventListener("keydown", handleKeyDown);
		};
	}, [grabModeActive, currentTabId, status]);

	const loadData = async () => {
		const scripts = await getUserscripts();
		const histories = await getChatHistories();

		// Filter out incompatible data (scripts must have chatHistoryId property, can be null or string)
		// Use 'in' operator to check if property exists, rather than checking value
		const validScripts = scripts.filter(
			(s) => s && typeof s === "object" && "chatHistoryId" in s,
		);
		const validHistories = histories.filter(
			(h) => h && typeof h === "object" && "domain" in h && h.domain,
		);

		console.log(
			"Loaded scripts:",
			scripts.length,
			"Valid:",
			validScripts.length,
		);
		console.log(
			"Loaded histories:",
			histories.length,
			"Valid:",
			validHistories.length,
		);

		setUserscripts(validScripts as Userscript[]);
		setChatHistories(validHistories as ChatHistory[]);
		const settings = await getSettings();
		setApiUrl(settings.apiUrl ?? "https://api.openai.com/v1/chat/completions");
		setApiKey(settings.apiKey ?? "");
		setModelName(settings.modelName ?? "gpt-5.2");
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

						// If URL changed within same domain and we have a current chat, update its context
						// Note: We update the in-memory chat but don't save screenshots to storage
						// Fresh page data will be captured when sending messages to LLM
						if (
							newUrl !== oldUrl &&
							newDomain === oldDomain &&
							currentChatId &&
							pageData.html
						) {
							const chat = chatHistories.find((c) => c.id === currentChatId);
							if (chat) {
								// Update the chat's page context in memory for next LLM call
								chat.initialUrl = pageData.url || newUrl;
								chat.initialScreenshot = pageData.screenshot; // Keep in memory
								chat.initialHtml = pageData.html;
								chat.initialConsoleLog = pageData.consoleLog;
								chat.updatedAt = Date.now();
								// Don't save to storage on every navigation - too much data
								// saveChatHistory will be called when user sends a message
								setChatHistories([...chatHistories]);
							}
						}
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
				const validHistories = histories.filter(
					(h: Partial<ChatHistory>) => h.domain,
				);
				setChatHistories(validHistories);

				if (newDomain) {
					const domainChats = validHistories
						.filter((chat: ChatHistory) => chat.domain === newDomain)
						.sort(
							(a: ChatHistory, b: ChatHistory) => b.updatedAt - a.updatedAt,
						);

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
		if (!currentTabId) {
			setError(
				"No active tab found. Please make sure you have a web page open.",
			);
			return;
		}
		if (!apiKey) {
			setError("Please set your API key in settings first.");
			setShowSettings(true);
			return;
		}

		setError(null);

		try {
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

				if (
					url.startsWith("chrome://") ||
					url.startsWith("edge://") ||
					url.startsWith("about:") ||
					url.startsWith("chrome-extension://")
				) {
					setError(
						`Cannot modify restricted pages like "${url.split("://")[0]}://" URLs. Please navigate to a regular website.`,
					);
				} else if (!url) {
					setError(
						"Failed to capture page data. Please make sure you have a web page open.",
					);
				} else {
					setError(
						"Failed to capture page data. Try reloading the page and clicking 'New Mod' again.",
					);
				}
				return;
			}

			const chatId = generateUUID();
			const scriptId = generateUUID();
			const domain = getDomainFromUrl(pageData.url);

			// Truncate large data to avoid storage quota issues
			const maxHtmlSize = 150000;
			const truncatedHtml =
				pageData.html.length > maxHtmlSize
					? `${pageData.html.slice(0, maxHtmlSize)}\n<!-- truncated -->`
					: pageData.html;

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
				initialHtml: truncatedHtml,
				initialConsoleLog: pageData.consoleLog.slice(0, 10000),
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
				enabled: true, // Enabled by default
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
		} catch (err) {
			console.error("Error creating new mod:", err);
			if (err instanceof Error && err.message.includes("quota")) {
				setError(
					"Storage quota exceeded. Please delete some old mods to free up space.",
				);
			} else {
				setError(
					`Failed to create mod: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
	};

	const capturePageData = async (tabId: number, includeScreenshot = true) => {
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
						console.error(
							"Error capturing page data:",
							chrome.runtime.lastError,
						);
						resolve({
							screenshot: "",
							html: "",
							consoleLog: "",
							url: "",
							error:
								chrome.runtime.lastError.message || "Unknown runtime error",
						});
					} else if (!response) {
						console.error("No response from page capture");
						resolve({
							screenshot: "",
							html: "",
							consoleLog: "",
							url: "",
							error:
								"No response from content script. The page may not be ready yet.",
						});
					} else if (!response.url) {
						console.error("Invalid response from page capture:", response);
						resolve({
							screenshot: "",
							html: "",
							consoleLog: "",
							url: "",
							error:
								"Content script returned invalid data. Try reloading the page.",
						});
					} else {
						resolve(response);
					}
				},
			);
		});
	};

	const executeJs = async (
		tabId: number,
		code: string,
	): Promise<{ result: string; error?: string }> => {
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
				},
			);
		});
	};

	const sendMessageToLLM = async (
		chatId: string,
		userMessage: string,
		pageData?: {
			screenshot: string;
			html: string;
			consoleLog: string;
			url: string;
		},
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
		const currentPageData =
			pageData || (await capturePageData(currentTabId, true));

		// Update last capture time to coordinate with tab update debouncing
		if (!pageData) {
			lastScreenshotCaptureRef.current = Date.now();
		}

		// Update chat's page context with fresh data so LLM always sees current state
		if (currentPageData.url && currentPageData.html) {
			chat.initialUrl = currentPageData.url;
			chat.initialScreenshot = currentPageData.screenshot;
			chat.initialHtml = currentPageData.html;
			chat.initialConsoleLog = currentPageData.consoleLog;
		}

		// Get current script snapshot for revert functionality
		const currentScript = userscripts.find((s) => s.chatHistoryId === chatId);
		const scriptSnapshot: UserscriptSnapshot | undefined = currentScript
			? {
					name: currentScript.name,
					matchUrls: currentScript.matchUrls,
					jsScript: currentScript.jsScript,
					enabled: currentScript.enabled,
				}
			: undefined;

		// Add user message with script snapshot
		const userMsg: ChatMessage = {
			id: generateUUID(),
			role: "user",
			content: userMessage,
			timestamp: Date.now(),
			scriptSnapshot,
		};

		chat.messages.push(userMsg);
		chat.updatedAt = Date.now();
		await saveChatHistory(chat);
		setChatHistories([...chatHistories]);

		// Prepare messages for API
		const messages = [];

		// Prepare HTML for LLM (uses shallow DOM tree for large pages)
		const { content: htmlContent, isShallow } = prepareHtmlForLLM(
			currentPageData.html,
		);

		// System message with current page state
		const htmlDescription = isShallow
			? "Current page DOM structure (simplified tree representation due to page size):"
			: "Current page HTML (high-entropy strings like data URLs have been truncated):";

		messages.push({
			role: "system",
			content: `You are an AI assistant that helps users create custom JavaScript code to modify web pages. You have two tools available:

1. execute_js(code: string) - Execute JavaScript code on the current page and see the output. Use this to test changes and explore the page structure.
2. submit_final_userscript(matchUrls: string, jsScript: string) - Submit the final userscript when ready. matchUrls should be a regex pattern matching the target URLs.

After each execute_js call, ask the user if the changes look correct. If yes, save using submit_final_userscript. If no, continue iterating based on their feedback.

Current page URL: ${currentPageData.url || chat.initialUrl}

${htmlDescription}
${htmlContent}

Recent console logs:
${currentPageData.consoleLog.slice(0, 10000)}`,
		});

		// Use grab screenshot if available (shows highlighted elements), otherwise use current page screenshot
		const screenshotToUse = grabScreenshot || currentPageData.screenshot;

		// Add initial context if this is the first message (with screenshot)
		if (chat.messages.length === 1 && screenshotToUse) {
			const content: (
				| { type: "text"; text: string }
				| { type: "image_url"; image_url: { url: string } }
			)[] = [
				{
					type: "text",
					text: `User request: ${userMessage}${grabScreenshot ? "\n\n(Screenshot shows the element(s) I selected highlighted in purple)" : ""}`,
				},
				{
					type: "image_url",
					image_url: {
						url: screenshotToUse,
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
					const assistantMsg: {
						role: string;
						content: string;
						tool_calls?: {
							id: string;
							type: string;
							function: { name: string; arguments: string };
						}[];
					} = { role: "assistant", content: msg.content };
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

			// Create abort controller for this request
			abortControllerRef.current = new AbortController();

			const response = await fetch(apiUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${apiKey}`,
				},
				signal: abortControllerRef.current.signal,
				body: JSON.stringify({
					model: modelName,
					messages,
					tools: [
						{
							type: "function",
							function: {
								name: "execute_js",
								description:
									"Execute JavaScript code on the current page to test changes",
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
								description:
									"Submit the final userscript when the changes are approved by the user",
								parameters: {
									type: "object",
									properties: {
										matchUrls: {
											type: "string",
											description:
												"Regex pattern for matching URLs where this script should run",
										},
										jsScript: {
											type: "string",
											description:
												"The final JavaScript code for the userscript",
										},
									},
									required: ["matchUrls", "jsScript"],
								},
							},
						},
					],
				}),
			});

			// Check response status first
			if (!response.ok) {
				let errorMessage = `API error: ${response.status} ${response.statusText}`;
				try {
					const errorData = await response.json();
					if (errorData.error?.message) {
						errorMessage = errorData.error.message;
					}
				} catch {
					// Response wasn't JSON, try to get text
					try {
						const errorText = await response.text();
						if (errorText) {
							errorMessage = `API error: ${errorText.slice(0, 200)}`;
						}
					} catch {
						// Ignore
					}
				}
				throw new Error(errorMessage);
			}

			let data;
			try {
				data = await response.json();
			} catch (parseError) {
				throw new Error("Failed to parse API response as JSON");
			}

			// Check for missing choices
			if (!data.choices || data.choices.length === 0) {
				throw new Error(data.error?.message || "API returned no choices");
			}

			const assistantMessage = data.choices[0].message;

			// Handle tool calls
			if (assistantMessage.tool_calls) {
				for (const toolCall of assistantMessage.tool_calls) {
					if (toolCall.function.name === "execute_js") {
						setStatus("RUNNING_JS_ON_PAGE");
						const args = JSON.parse(toolCall.function.arguments);
						const result = await executeJs(currentTabId, args.code);

						// Also save the code to the userscript so user can see it in the editor
						const scriptToUpdate = userscripts.find(
							(s) => s.chatHistoryId === chatId,
						);
						if (scriptToUpdate) {
							scriptToUpdate.jsScript = args.code;
							scriptToUpdate.updatedAt = Date.now();
							// Don't enable yet - wait for user approval
							await saveUserscript(scriptToUpdate);
							// Clear stale execution result since script changed
							await clearExecutionResult(scriptToUpdate.id);
							setUserscripts([...userscripts]);
						}

						// Store pending approval with output info
						const output = result.error
							? `Error: ${result.error}`
							: result.result ||
								"Script executed successfully (no console output)";

						console.log("[Improv] Setting pendingApproval:", {
							code: args.code.slice(0, 100),
							output,
						});
						setPendingApproval({
							code: args.code,
							output,
						});

						// Add assistant message with tool call
						const assistantMsg: ChatMessage = {
							id: generateUUID(),
							role: "assistant",
							content: assistantMessage.content || "",
							timestamp: Date.now(),
							toolCalls: assistantMessage.tool_calls.map(
								(tc: {
									id: string;
									type: string;
									function: { name: string; arguments: string };
								}) => ({
									id: tc.id,
									type: tc.type,
									function: {
										name: tc.function.name,
										arguments: tc.function.arguments,
									},
								}),
							),
							toolResults: [
								{
									toolCallId: toolCall.id,
									output: result.error
										? `Error: ${result.error}`
										: result.result,
								},
							],
						};

						chat.messages.push(assistantMsg);
						chat.updatedAt = Date.now();
						await saveChatHistory(chat);
						setChatHistories([...chatHistories]);
						setStatus("IDLE");
						return;
					}
					if (toolCall.function.name === "submit_final_userscript") {
						const args = JSON.parse(toolCall.function.arguments);

						// Find existing userscript for this chat (created in handleNewChat)
						const existingScript = userscripts.find(
							(s) => s.chatHistoryId === chatId,
						);

						let updatedScript: Userscript;
						if (existingScript) {
							// Update existing userscript with LLM's code
							existingScript.matchUrls = args.matchUrls;
							existingScript.jsScript = args.jsScript;
							existingScript.name =
								chat.initialPrompt?.slice(0, 100) ||
								`Script for ${new URL(chat.initialUrl).hostname}`;
							existingScript.enabled = true; // Enable now that it has code
							existingScript.updatedAt = Date.now();
							updatedScript = existingScript;

							await saveUserscript(existingScript);
							setUserscripts([...userscripts]);
						} else {
							// Fallback: create new userscript if somehow it doesn't exist
							const scriptId = generateUUID();
							updatedScript = {
								id: scriptId,
								name:
									chat.initialPrompt?.slice(0, 100) ||
									`Script for ${new URL(chat.initialUrl).hostname}`,
								matchUrls: args.matchUrls,
								jsScript: args.jsScript,
								chatHistoryId: chatId,
								createdAt: Date.now(),
								updatedAt: Date.now(),
								enabled: true,
							};

							await saveUserscript(updatedScript);
							setUserscripts([...userscripts, updatedScript]);
						}

						// Add success message
						const successMsg: ChatMessage = {
							id: generateUUID(),
							role: "assistant",
							content:
								"Userscript saved! It will now run automatically on matching pages.",
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

				// Try to extract and save code from the message
				if (assistantMessage.content) {
					const codeSaved = await extractAndSaveCodeFromMessage(
						assistantMessage.content,
						chatId,
					);
					if (codeSaved) {
						// Add a note that the code was auto-saved
						const savedMsg: ChatMessage = {
							id: generateUUID(),
							role: "assistant",
							content: "✓ Code detected and saved to userscript.",
							timestamp: Date.now(),
						};
						chat.messages.push(savedMsg);
						await saveChatHistory(chat);
						setChatHistories([...chatHistories]);
					}
				}

				setStatus("IDLE");
			}
		} catch (error) {
			// Check if this was an abort (user pressed Escape)
			if (error instanceof Error && error.name === "AbortError") {
				// Don't add error message, just reset status
				// User message is still in chat, they can edit it or type a new one
				setStatus("IDLE");
				return;
			}

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
		} finally {
			abortControllerRef.current = null;
		}
	};

	const handleApprove = async () => {
		if (!currentChatId || !pendingApproval) return;

		const chat = chatHistories.find((c) => c.id === currentChatId);
		if (!chat) return;

		// Script is already saved as draft from execute_js, just enable it
		const existingScript = userscripts.find(
			(s) => s.chatHistoryId === currentChatId,
		);

		if (existingScript) {
			// Enable the script and update name if needed
			existingScript.name =
				chat.initialPrompt?.slice(0, 100) ||
				`Script for ${getDomainFromUrl(chat.initialUrl)}`;
			existingScript.enabled = true;
			existingScript.updatedAt = Date.now();

			await saveUserscript(existingScript);
			setUserscripts([...userscripts]);
		}

		// Add a confirmation message to the chat
		const confirmMsg: ChatMessage = {
			id: generateUUID(),
			role: "assistant",
			content:
				"Userscript finalized! It will now run automatically on matching pages.",
			timestamp: Date.now(),
		};
		chat.messages.push(confirmMsg);
		chat.updatedAt = Date.now();
		await saveChatHistory(chat);
		setChatHistories([...chatHistories]);

		setPendingApproval(null);
	};

	const handleReject = async (action: "continue" | "refresh") => {
		const feedback = rejectionFeedback.trim();
		setPendingApproval(null);
		setRejectionFeedback("");

		if (action === "continue" && currentChatId) {
			// Keep iterating - send feedback to LLM to refine the draft
			const message = feedback
				? `That didn't work. ${feedback}`
				: "That didn't work as expected. Please try a different approach.";
			await sendMessageToLLM(currentChatId, message);
		} else if (action === "refresh" && currentChatId) {
			// Start over - clear chat messages and reset script draft
			const chat = chatHistories.find((c) => c.id === currentChatId);
			const script = userscripts.find((s) => s.chatHistoryId === currentChatId);

			if (chat) {
				chat.messages = [];
				chat.updatedAt = Date.now();
				await saveChatHistory(chat);
				setChatHistories([...chatHistories]);
			}

			// Clear the script draft
			if (script) {
				script.jsScript = "";
				script.enabled = false;
				script.updatedAt = Date.now();
				await saveUserscript(script);
				setUserscripts([...userscripts]);
			}

			// Re-send initial prompt to start fresh
			if (chat && currentTabId && chat.initialPrompt) {
				const pageData = await capturePageData(currentTabId);
				await sendMessageToLLM(currentChatId, chat.initialPrompt, pageData);
			}
		}
	};

	const handleSendMessage = async () => {
		if (!currentChatId || !currentTabId) return;
		const input = document.getElementById("chat-input") as HTMLTextAreaElement;
		let message = input.value.trim();
		if (!message) return;
		input.value = "";
		// Reset textarea height
		input.style.height = "auto";

		// Append grabbed elements context if any
		const grabbedContext = formatGrabbedElementsForPrompt();
		if (grabbedContext) {
			message = `${message}\n\nThe user has selected the following elements on the page for context:${grabbedContext}`;
			// Clear grabbed elements and screenshot after sending
			setGrabbedElements([]);
			setGrabScreenshot(null);
			// Deactivate grab mode
			if (grabModeActive) {
				setGrabModeActive(false);
				chrome.runtime.sendMessage({
					type: "GRAB_MODE_DEACTIVATE",
					tabId: currentTabId,
				});
			}
		}

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
			setChatHistories(
				chatHistories.filter((c) => c.id !== script.chatHistoryId),
			);

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

	const handleImportScript = async (repoScript: RepositoryScript) => {
		setImportingScriptId(repoScript.id);
		try {
			// Fetch the script code
			const code = await fetchScriptCode(repoScript.codeUrl);

			// Parse metadata from the script
			const metadata = parseUserscriptMetadata(code);
			const matchRegex = metadataToMatchRegex(metadata);

			const sourceName =
				repoScript.source === "openuserjs" ? "OpenUserJS" : "Greasyfork";

			// Always create a chat history for 1:1 relationship with userscript
			const chatId = generateUUID();
			const scriptId = generateUUID();

			// Try to capture page data for context (optional - may fail on restricted pages)
			let pageData = {
				screenshot: "",
				html: "",
				consoleLog: "",
				url: currentUrl,
			};
			if (currentTabId) {
				try {
					const captured = await capturePageData(currentTabId);
					if (captured.url) {
						pageData = captured;
					}
				} catch {
					// Ignore capture errors - we'll use current URL
				}
			}

			const domain = getDomainFromUrl(pageData.url || currentUrl);

			// Create chat history
			const newChat: ChatHistory = {
				id: chatId,
				domain,
				apiUrl,
				modelName,
				messages: [],
				initialPrompt: `Imported: ${repoScript.name} (from ${sourceName})`,
				initialUrl: pageData.url || currentUrl,
				initialScreenshot: pageData.screenshot,
				initialHtml: pageData.html,
				initialConsoleLog: pageData.consoleLog,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};

			// Create userscript linked to chat
			const newScript: Userscript = {
				id: scriptId,
				name: metadata.name || repoScript.name,
				matchUrls: matchRegex,
				jsScript: code,
				chatHistoryId: chatId,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				enabled: true,
				sourceUrl: repoScript.url,
				sourceType:
					repoScript.source === "openuserjs" ? "openusersjs" : "greasyfork",
			};

			await saveChatHistory(newChat);
			await saveUserscript(newScript);

			setChatHistories([...chatHistories, newChat]);
			setUserscripts([...userscripts, newScript]);
			setCurrentChatId(chatId);
			// Inline editor will automatically show for the selected mod
		} catch (err) {
			console.error("Failed to import script:", err);
			setError(err instanceof Error ? err.message : "Failed to import script");
		} finally {
			setImportingScriptId(null);
		}
	};

	const handleRefreshRepository = () => {
		if (currentDomain) {
			clearScriptCache(currentDomain);
			setRepositoryLoading(true);
			setRepositoryError(null);
			fetchRepositoryScripts(currentDomain)
				.then(setRepositoryScripts)
				.catch((err) => {
					setRepositoryError(
						err instanceof Error ? err.message : "Failed to fetch scripts",
					);
					setRepositoryScripts([]);
				})
				.finally(() => setRepositoryLoading(false));
		}
	};

	// Edit message handlers
	const handleStartEditMessage = (msg: ChatMessage) => {
		setEditingMessageId(msg.id);
		setEditingMessageContent(msg.content);
		// Focus the edit input after render
		setTimeout(() => editInputRef.current?.focus(), 0);
	};

	const handleCancelEditMessage = () => {
		setEditingMessageId(null);
		setEditingMessageContent("");
	};

	const handleSaveEditMessage = async () => {
		if (!currentChat || !editingMessageId || !editingMessageContent.trim()) {
			handleCancelEditMessage();
			return;
		}

		// Find the index of the message being edited
		const messageIndex = currentChat.messages.findIndex(
			(m) => m.id === editingMessageId,
		);
		if (messageIndex === -1) {
			handleCancelEditMessage();
			return;
		}

		// Truncate messages after this point (keep messages up to and including the edited one)
		const truncatedMessages = currentChat.messages.slice(0, messageIndex);

		// Update the message content
		const editedMessage: ChatMessage = {
			...currentChat.messages[messageIndex],
			content: editingMessageContent.trim(),
			timestamp: Date.now(),
		};

		// Update chat with truncated history + edited message
		currentChat.messages = [...truncatedMessages, editedMessage];
		currentChat.updatedAt = Date.now();

		await saveChatHistory(currentChat);
		setChatHistories([...chatHistories]);

		// Clear editing state
		handleCancelEditMessage();

		// Clear pending approval since we're resending
		setPendingApproval(null);

		// Send the edited message to the LLM
		await sendMessageToLLM(currentChat.id, editingMessageContent.trim());
	};

	// Revert to a previous message state
	const handleRevertToMessage = async (msg: ChatMessage) => {
		if (!currentChat) return;

		// Find the index of this message
		const messageIndex = currentChat.messages.findIndex((m) => m.id === msg.id);
		if (messageIndex === -1) return;

		// Find the script for this chat
		const script = userscripts.find((s) => s.chatHistoryId === currentChat.id);

		// Truncate chat history to this point (keep messages up to and including this one)
		currentChat.messages = currentChat.messages.slice(0, messageIndex + 1);
		currentChat.updatedAt = Date.now();

		// Restore script snapshot if available
		if (msg.scriptSnapshot && script) {
			script.name = msg.scriptSnapshot.name;
			script.matchUrls = msg.scriptSnapshot.matchUrls;
			script.jsScript = msg.scriptSnapshot.jsScript;
			script.enabled = msg.scriptSnapshot.enabled;
			script.updatedAt = Date.now();

			await saveUserscript(script);
			setUserscripts([...userscripts]);
		}

		await saveChatHistory(currentChat);
		setChatHistories([...chatHistories]);

		// Clear any pending approval since we reverted
		setPendingApproval(null);
	};

	// Grab mode handlers
	const handleToggleGrabMode = async () => {
		if (!currentTabId) {
			setError("No active tab to enable grab mode");
			return;
		}

		const newState = !grabModeActive;
		setGrabModeActive(newState);

		try {
			const response = await new Promise<{ success: boolean; error?: string }>(
				(resolve) => {
					chrome.runtime.sendMessage(
						{
							type: newState ? "GRAB_MODE_ACTIVATE" : "GRAB_MODE_DEACTIVATE",
							tabId: currentTabId,
						},
						resolve,
					);
				},
			);

			if (!response.success) {
				setError(response.error || "Failed to toggle grab mode");
				setGrabModeActive(!newState);
			}
		} catch (err) {
			setError("Failed to toggle grab mode");
			setGrabModeActive(!newState);
		}
	};

	const handleRemoveGrabbedElement = (xpath: string) => {
		setGrabbedElements((prev) => prev.filter((e) => e.xpath !== xpath));
	};

	const handleClearGrabbedElements = () => {
		setGrabbedElements([]);
		setGrabScreenshot(null);
	};

	// Format grabbed elements for the prompt
	const formatGrabbedElementsForPrompt = (): string => {
		if (grabbedElements.length === 0) return "";

		return grabbedElements
			.map((el, idx) => {
				return `\n--- Selected Element ${idx + 1} ---
XPath: ${el.xpath}

HTML:
${el.outerHTML}`;
			})
			.join("\n");
	};

	// Extract JavaScript code blocks from LLM response and save to userscript
	const extractAndSaveCodeFromMessage = async (
		content: string,
		chatId: string,
	): Promise<boolean> => {
		// Match code blocks with js/javascript language or userscript metadata
		const codeBlockRegex = /```(?:js|javascript)?\s*\n([\s\S]*?)```/gi;
		const matches = [...content.matchAll(codeBlockRegex)];

		if (matches.length === 0) return false;

		// Find the largest code block (likely the main script)
		let bestCode = "";
		for (const match of matches) {
			const code = match[1].trim();
			// Prefer code with userscript metadata, otherwise take the longest
			if (code.includes("==UserScript==") || code.length > bestCode.length) {
				bestCode = code;
			}
		}

		if (!bestCode || bestCode.length < 20) return false;

		// Find the userscript for this chat
		const script = userscripts.find((s) => s.chatHistoryId === chatId);
		if (!script) return false;

		// Update the script
		script.jsScript = bestCode;
		script.enabled = true;
		script.updatedAt = Date.now();

		// Try to extract match pattern from userscript metadata
		const matchPatterns = bestCode.match(/@match\s+(.+)/g);
		if (matchPatterns && matchPatterns.length > 0) {
			// Convert @match patterns to regex
			const patterns = matchPatterns
				.map((m) => m.replace("@match", "").trim())
				.map((p) =>
					p.replace(/\*/g, ".*").replace(/\?/g, ".").replace(/\//g, "\\/"),
				);
			script.matchUrls = patterns.join("|");
		}

		await saveUserscript(script);
		setUserscripts([...userscripts]);

		return true;
	};

	const formatNumber = (num: number): string => {
		if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
		if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
		return num.toString();
	};

	const formatDate = (dateString: string): string => {
		const date = new Date(dateString);
		const now = new Date();
		const diffMs = now.getTime() - date.getTime();
		const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

		if (diffDays === 0) return "today";
		if (diffDays === 1) return "yesterday";
		if (diffDays < 7) return `${diffDays} days ago`;
		if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
		if (diffDays < 365) return `${Math.floor(diffDays / 30)} months ago`;
		return `${Math.floor(diffDays / 365)} years ago`;
	};

	const sortedRepositoryScripts = [...repositoryScripts].sort((a, b) => {
		switch (repositorySortBy) {
			case "installs":
				return b.totalInstalls - a.totalInstalls;
			case "rating":
				return b.goodRatings - a.goodRatings;
			case "updated":
				return (
					new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
				);
			default:
				return 0;
		}
	});

	// Get the currently selected script for inline editing
	const selectedScript = currentChatId
		? userscripts.find((s) => s.chatHistoryId === currentChatId)
		: null;

	return (
		<div className="flex flex-col h-screen bg-gray-50">
			{/* Sleek Header */}
			<div className="bg-gradient-to-r from-slate-800 to-slate-700 px-3 py-1.5 flex justify-between items-center shadow-sm">
				<span className="text-sm font-bold text-white tracking-wide">
					Stagehand Improv
				</span>
				<button
					type="button"
					onClick={handleNewChat}
					className="px-2 py-0.5 text-[10px] font-medium bg-white/20 text-white rounded hover:bg-white/30 transition-colors"
				>
					+ new mod
				</button>
				<button
					type="button"
					onClick={() => setShowSettings(true)}
					className="p-1 text-white/70 hover:text-white hover:bg-white/10 rounded transition-colors"
					title="Settings"
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						className="w-4 h-4"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
						aria-hidden="true"
					>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth={1.5}
							d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
						/>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth={1.5}
							d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
						/>
					</svg>
				</button>
			</div>

			{/* Error Banner */}
			{error && (
				<div className="bg-red-50 border-b border-red-200 px-3 py-2 flex items-center justify-between">
					<div className="text-xs text-red-800">{error}</div>
					<button
						type="button"
						onClick={() => setError(null)}
						className="text-red-600 hover:text-red-800 text-[10px] font-semibold"
					>
						Dismiss
					</button>
				</div>
			)}

			{/* Isometric Lego Brick Mods */}
			{domainChatHistories.length > 0 && (
				<div
					className="border-b border-gray-200 px-3 py-4"
					style={{
						background: "linear-gradient(180deg, #f8fafc 0%, #e2e8f0 100%)",
					}}
				>
					<div className="flex flex-wrap gap-4 items-end">
						{domainChatHistories.map((chat, idx) => {
							const associatedScript = userscripts.find(
								(s) => s.chatHistoryId === chat.id,
							);
							const isSelected = currentChatId === chat.id;
							const label =
								associatedScript?.name ||
								chat.initialPrompt?.slice(0, 20) ||
								"New mod";
							const displayLabel =
								label.length > 24 ? `${label.slice(0, 24)}..` : label;
							const studCols = Math.max(
								3,
								Math.ceil(displayLabel.length / 2.5),
							);
							// Brick dimensions
							const studSize = 16; // stud spacing
							const studR = 5; // stud radius
							const studH = 5; // stud height
							const padding = 10; // padding on sides
							const brickW = studCols * studSize + padding * 2;
							const brickD = studSize * 2 + padding; // depth for 2 rows
							const brickH = 26; // front face height
							const isoRatio = 0.5; // isometric Y compression
							const svgW = brickW + brickD * isoRatio + 4;
							const svgH = brickH + brickD * isoRatio + studH + 8;
							const oX = 2; // origin X offset
							const oY = studH + 4; // origin Y offset (space for studs)
							const id = `lego-${chat.id.slice(0, 8)}`;
							// Colors - cycle through yellow, red, blue for first 3, then use state-based colors
							const brickColors: [number, number, number][] = [
								[48, 100, 50], // yellow
								[0, 80, 50], // red
								[217, 91, 55], // blue
							];
							const [hue, sat, light] =
								idx < 3
									? brickColors[idx]
									: associatedScript?.enabled
										? [142, 71, 45]
										: [220, 9, 50];
							const topCol = `hsl(${hue}, ${sat}%, ${light + 15}%)`;
							const frontCol = `hsl(${hue}, ${sat}%, ${light}%)`;
							const sideCol = `hsl(${hue}, ${sat}%, ${light - 12}%)`;
							const studTopCol = `hsl(${hue}, ${sat}%, ${light + 20}%)`;
							const studSideCol = `hsl(${hue}, ${sat}%, ${light + 8}%)`;
							// Top face corners (parallelogram)
							const topFace = `M${oX},${oY + brickD * isoRatio} L${oX + brickD * isoRatio},${oY} L${oX + brickW + brickD * isoRatio},${oY} L${oX + brickW},${oY + brickD * isoRatio} Z`;
							// Right side face
							const sideFace = `M${oX + brickW},${oY + brickD * isoRatio} L${oX + brickW + brickD * isoRatio},${oY} L${oX + brickW + brickD * isoRatio},${oY + brickH} L${oX + brickW},${oY + brickD * isoRatio + brickH} Z`;
							return (
								<div
									key={chat.id}
									className={`relative group cursor-pointer transition-all hover:-translate-y-1 ${isSelected ? "-translate-y-0.5" : ""}`}
									onClick={() => setCurrentChatId(chat.id)}
									onKeyDown={(e) => {
										if (e.key === "Enter" || e.key === " ")
											setCurrentChatId(chat.id);
									}}
									role="button"
									tabIndex={0}
									title={
										associatedScript?.name || chat.initialPrompt || "New mod"
									}
									style={{
										filter: isSelected
											? "drop-shadow(3px 6px 6px rgba(0,0,0,0.5)) drop-shadow(0 0 8px rgba(0,0,0,0.3))"
											: "drop-shadow(2px 4px 3px rgba(0,0,0,0.25))",
									}}
								>
									<svg
										width={svgW}
										height={svgH}
										viewBox={`0 0 ${svgW} ${svgH}`}
									>
										<defs>
											<linearGradient
												id={`${id}-top`}
												x1="0%"
												y1="100%"
												x2="100%"
												y2="0%"
											>
												<stop offset="0%" stopColor={topCol} />
												<stop
													offset="100%"
													stopColor={`hsl(${hue}, ${sat}%, ${light + 22}%)`}
												/>
											</linearGradient>
										</defs>
										{/* Right side face */}
										<path d={sideFace} fill={sideCol} />
										{/* Front face */}
										<rect
											x={oX}
											y={oY + brickD * isoRatio}
											width={brickW}
											height={brickH}
											fill={frontCol}
										/>
										{/* Top face */}
										<path d={topFace} fill={`url(#${id}-top)`} />
										{/* 2xN Studs - back row first, then front row */}
										{[0, 1].map((row) =>
											Array.from({ length: studCols }).map((_, col) => {
												// Grid position on top face (in brick's local coords)
												const gx = padding + studSize * 0.5 + col * studSize;
												const gy =
													padding * 0.5 + studSize * 0.5 + row * studSize;
												// Convert to isometric: shift X by depth amount based on Y position
												const sx = oX + gx + (brickD - gy) * isoRatio;
												const sy = oY + gy * isoRatio;
												return (
													<g key={`${row}-${col}`}>
														{/* Cylinder side */}
														<path
															d={`M${sx - studR},${sy} v${-studH} a${studR},${studR * isoRatio} 0 0,1 ${studR * 2},0 v${studH} a${studR},${studR * isoRatio} 0 0,1 ${-studR * 2},0`}
															fill={studSideCol}
														/>
														{/* Cylinder top */}
														<ellipse
															cx={sx}
															cy={sy - studH}
															rx={studR}
															ry={studR * isoRatio}
															fill={studTopCol}
														/>
														{/* Specular highlight */}
														<ellipse
															cx={sx - 1.5}
															cy={sy - studH - 1}
															rx="2"
															ry="1"
															fill="white"
															opacity="0.5"
														/>
													</g>
												);
											}),
										)}
										{/* Checkbox */}
										{associatedScript && (
											<foreignObject
												x="8"
												y={oY + brickD * isoRatio + 5}
												width="14"
												height="14"
											>
												<input
													type="checkbox"
													checked={associatedScript.enabled}
													onChange={(e) => {
														e.stopPropagation();
														handleToggleScript(associatedScript);
													}}
													className="w-3.5 h-3.5"
													style={{ accentColor: "white" }}
												/>
											</foreignObject>
										)}
										{/* Label */}
										<text
											x={associatedScript ? 26 : 10}
											y={oY + brickD * isoRatio + 17}
											fontSize="11"
											fill="white"
											fontWeight="600"
											style={{ textShadow: "0 1px 2px rgba(0,0,0,0.4)" }}
										>
											{displayLabel}
										</text>
										{/* Execution status light */}
										{associatedScript && (
											<g>
												{(() => {
													const result =
														scriptExecutionResults[associatedScript.id];
													// Gray if never run, green if success, red if error
													const color = !result
														? "#9ca3af"
														: result.success
															? "#22c55e"
															: "#ef4444";
													const statusX = svgW - 12;
													const statusY = oY + brickD * isoRatio + 12;
													return (
														<>
															<circle
																cx={statusX}
																cy={statusY}
																r="4"
																fill={color}
																stroke="white"
																strokeWidth="1"
															/>
															{/* Glow effect - only for success/error */}
															{result && (
																<circle
																	cx={statusX}
																	cy={statusY}
																	r="6"
																	fill={color}
																	opacity="0.3"
																/>
															)}
														</>
													);
												})()}
											</g>
										)}
									</svg>
									{/* Tooltip for error */}
									{associatedScript &&
										scriptExecutionResults[associatedScript.id] &&
										!scriptExecutionResults[associatedScript.id].success && (
											<div
												className="absolute bottom-full right-0 mb-1 px-2 py-1 bg-red-600 text-white text-xs rounded shadow-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none max-w-[200px] z-50"
												style={{ whiteSpace: "pre-wrap" }}
											>
												{scriptExecutionResults[associatedScript.id].error ||
													"Script execution failed"}
											</div>
										)}
								</div>
							);
						})}
					</div>
				</div>
			)}

			{/* Community Scripts Section - shown when no mod is selected */}
			{!currentChat && (
				<div className="bg-white border-b border-gray-200 p-3 flex-1 overflow-y-auto">
					{/* Repository Scripts Section */}
					<div className="mt-4">
						<div className="flex justify-between items-center mb-2">
							<button
								type="button"
								onClick={() => setRepositoryExpanded(!repositoryExpanded)}
								className="flex items-center gap-1 text-sm font-semibold text-green-900 hover:text-green-700"
							>
								<span
									className={`transform transition-transform ${repositoryExpanded ? "rotate-90" : ""}`}
								>
									▶
								</span>
								Community Scripts
								{repositoryScripts.length > 0 && (
									<span className="ml-1 text-xs font-normal text-green-600">
										({repositoryScripts.length})
									</span>
								)}
							</button>
							<div className="flex items-center gap-2">
								<select
									value={repositorySortBy}
									onChange={(e) =>
										setRepositorySortBy(
											e.target.value as "installs" | "rating" | "updated",
										)
									}
									className="px-2 py-1 text-xs bg-white border border-green-200 rounded text-green-700 focus:outline-none focus:ring-1 focus:ring-green-500"
								>
									<option value="installs">Most Installs</option>
									<option value="rating">Best Rated</option>
									<option value="updated">Recently Updated</option>
								</select>
								<button
									type="button"
									onClick={handleRefreshRepository}
									disabled={repositoryLoading}
									className="px-2 py-1 text-xs bg-green-100 text-green-700 rounded hover:bg-green-200 disabled:opacity-50"
								>
									{repositoryLoading ? "..." : "Refresh"}
								</button>
							</div>
						</div>

						{repositoryExpanded && (
							<div className="space-y-2">
								{repositoryLoading && repositoryScripts.length === 0 && (
									<div className="text-xs text-gray-500 p-2 bg-gray-50 rounded">
										Loading scripts from repositories...
									</div>
								)}

								{repositoryError && (
									<div className="text-xs text-red-600 p-2 bg-red-50 rounded">
										{repositoryError}
									</div>
								)}

								{!repositoryLoading &&
									!repositoryError &&
									repositoryScripts.length === 0 && (
										<div className="text-xs text-gray-500 p-2 bg-gray-50 rounded">
											No scripts found for {currentDomain}
										</div>
									)}

								{sortedRepositoryScripts.map((script) => {
									const isImporting = importingScriptId === script.id;
									const alreadyImported = userscripts.some(
										(u) => u.sourceUrl === script.url,
									);

									return (
										<div
											key={script.id}
											className="p-2 bg-green-50 border border-green-100 rounded text-xs"
										>
											<div className="flex items-start justify-between gap-2">
												<div className="flex-1 min-w-0">
													<div
														className="font-medium text-green-900 truncate"
														title={script.name}
													>
														{script.name}
													</div>
													<div className="text-green-700 text-[10px] flex items-center gap-1">
														<span
															className={`px-1 rounded ${
																script.source === "greasyfork"
																	? "bg-green-200 text-green-800"
																	: "bg-blue-200 text-blue-800"
															}`}
														>
															{script.source === "greasyfork" ? "GF" : "OUJS"}
														</span>
														by {script.authorName}
														{script.version && ` • v${script.version}`}
													</div>
													<div className="text-green-600 text-[10px] mt-1 line-clamp-2">
														{script.description}
													</div>
													<div className="flex items-center gap-2 mt-1 text-[10px] text-green-600 flex-wrap">
														<span title="Total installs">
															{formatNumber(script.totalInstalls)} installs
														</span>
														<span>•</span>
														<span
															title={`${script.goodRatings} good, ${script.okRatings} ok, ${script.badRatings} bad`}
															className={
																script.goodRatings > script.badRatings * 2
																	? "text-green-700"
																	: script.badRatings > script.goodRatings
																		? "text-red-600"
																		: "text-yellow-600"
															}
														>
															{script.goodRatings}/{script.okRatings}/
															{script.badRatings} ratings
														</span>
														<span>•</span>
														<span
															title={`Updated: ${new Date(script.updatedAt).toLocaleDateString()}`}
														>
															updated {formatDate(script.updatedAt)}
														</span>
													</div>
												</div>
												<div className="flex flex-col gap-1">
													{alreadyImported ? (
														<span className="px-2 py-1 text-[10px] bg-gray-200 text-gray-600 rounded">
															Imported
														</span>
													) : (
														<button
															type="button"
															onClick={() => handleImportScript(script)}
															disabled={isImporting}
															className="px-2 py-1 text-[10px] bg-green-500 text-white rounded hover:bg-green-600 disabled:opacity-50"
															title="Import and open editor"
														>
															{isImporting ? "..." : "Use Mod"}
														</button>
													)}
													<a
														href={script.url}
														target="_blank"
														rel="noopener noreferrer"
														className="px-2 py-1 text-[10px] bg-gray-100 text-gray-700 rounded hover:bg-gray-200 text-center"
													>
														View
													</a>
												</div>
											</div>
										</div>
									);
								})}
							</div>
						)}
					</div>
				</div>
			)}

			{/* Chat Interface */}
			<div className="flex-1 flex flex-col overflow-hidden">
				{currentChat ? (
					<>
						{/* Inline Script Editor */}
						{selectedScript && (
							<div className="bg-gray-50 border-b border-gray-200 p-3 space-y-2">
								<div className="flex items-center justify-between">
									<div className="flex items-center gap-2">
										<input
											type="checkbox"
											checked={selectedScript.enabled}
											onChange={() => handleToggleScript(selectedScript)}
											className="w-4 h-4"
										/>
										<input
											type="text"
											value={selectedScript.name}
											onChange={(e) => {
												selectedScript.name = e.target.value;
												setUserscripts([...userscripts]);
											}}
											onBlur={async () => {
												selectedScript.updatedAt = Date.now();
												await saveUserscript(selectedScript);
											}}
											className="flex-1 px-2 py-1 text-sm font-medium bg-white border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
											placeholder="Mod name"
										/>
									</div>
									<div className="flex items-center gap-1">
										<button
											type="button"
											onClick={async () => {
												currentChat.messages = [];
												currentChat.updatedAt = Date.now();
												await saveChatHistory(currentChat);
												setChatHistories([...chatHistories]);
												setPendingApproval(null);
											}}
											className="px-2 py-1 text-[10px] bg-gray-100 text-gray-600 rounded hover:bg-gray-200"
											title="Clear chat history"
										>
											Clear Chat
										</button>
										<button
											type="button"
											onClick={() => handleDeleteScript(selectedScript.id)}
											className="px-2 py-1 text-[10px] bg-red-100 text-red-600 rounded hover:bg-red-200"
											title="Delete mod"
										>
											Delete
										</button>
									</div>
								</div>
								<input
									type="text"
									value={selectedScript.matchUrls}
									onChange={(e) => {
										selectedScript.matchUrls = e.target.value;
										setUserscripts([...userscripts]);
									}}
									onBlur={async () => {
										selectedScript.updatedAt = Date.now();
										await saveUserscript(selectedScript);
									}}
									className="w-full px-2 py-1 text-xs font-mono bg-white border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
									placeholder="Match URLs (regex)"
								/>
								<details className="text-xs" open={!!pendingApproval}>
									<summary className="cursor-pointer text-gray-600 hover:text-gray-800 select-none">
										{selectedScript.jsScript
											? `Script (${selectedScript.jsScript.split("\n").length} lines)${pendingApproval ? " - awaiting approval" : ""}`
											: pendingApproval
												? "Script (pending approval)"
												: "No script yet"}
									</summary>
									<textarea
										value={selectedScript.jsScript}
										onChange={(e) => {
											selectedScript.jsScript = e.target.value;
											setUserscripts([...userscripts]);
										}}
										onBlur={async () => {
											selectedScript.updatedAt = Date.now();
											await saveUserscript(selectedScript);
											// Clear stale execution result since script changed
											await clearExecutionResult(selectedScript.id);
										}}
										rows={8}
										className="w-full mt-1 px-2 py-1 text-xs font-mono bg-white border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
										placeholder="// JavaScript code here..."
									/>
								</details>
								{selectedScript.sourceUrl && (
									<div className="text-[10px] text-gray-500">
										Source:{" "}
										<a
											href={selectedScript.sourceUrl}
											target="_blank"
											rel="noopener noreferrer"
											className="text-blue-600 hover:underline"
										>
											{selectedScript.sourceType === "greasyfork"
												? "Greasyfork"
												: selectedScript.sourceType === "openusersjs"
													? "OpenUserJS"
													: "external"}
										</a>
									</div>
								)}
							</div>
						)}

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
													<div className="font-medium text-gray-600">
														System Prompt:
													</div>
													<div
														className="text-gray-800 mt-1 cursor-pointer hover:bg-gray-50 p-1 rounded"
														onClick={() =>
															setExpandedSystemPrompt(!expandedSystemPrompt)
														}
														onKeyDown={(e) => {
															if (e.key === "Enter" || e.key === " ") {
																setExpandedSystemPrompt(!expandedSystemPrompt);
															}
														}}
														role="button"
														tabIndex={0}
														title="Click to expand/collapse"
													>
														{expandedSystemPrompt
															? `You are an AI assistant that helps users create custom JavaScript code to modify web pages. You have two tools available:

1. execute_js(code: string) - Execute JavaScript code on the current page and see the output. Use this to test changes and explore the page structure.
2. submit_final_userscript(matchUrls: string, jsScript: string) - Submit the final userscript when ready. matchUrls should be a regex pattern matching the target URLs.

After each execute_js call, ask the user if the changes look correct. If yes, save using submit_final_userscript. If no, continue iterating based on their feedback.`
															: "You are an AI assistant that helps users create custom JavaScript code to modify web pages..."}
													</div>
												</div>
												<div>
													<div className="font-medium text-gray-600">
														Initial URL:
													</div>
													<div className="text-gray-800 mt-1 break-all">
														{currentChat.initialUrl}
													</div>
												</div>
												{currentChat.initialHtml && (
													<div>
														<div className="font-medium text-gray-600">
															HTML:
														</div>
														<div
															className="text-gray-800 mt-1 font-mono text-[10px] max-h-60 overflow-y-auto bg-white p-2 rounded cursor-pointer hover:bg-gray-50"
															onClick={() => setExpandedHtml(!expandedHtml)}
															onKeyDown={(e) => {
																if (e.key === "Enter" || e.key === " ") {
																	setExpandedHtml(!expandedHtml);
																}
															}}
															role="button"
															tabIndex={0}
															title="Click to expand/collapse"
														>
															{expandedHtml
																? currentChat.initialHtml
																: `${currentChat.initialHtml.slice(0, 500)}...`}
														</div>
													</div>
												)}
												{currentChat.initialScreenshot && (
													<div>
														<div className="font-medium text-gray-600 mb-1">
															Screenshot:
														</div>
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
									{editingMessageId === msg.id ? (
										/* Edit mode */
										<div className="inline-block max-w-[90%] w-full">
											<textarea
												ref={editInputRef}
												value={editingMessageContent}
												onChange={(e) =>
													setEditingMessageContent(e.target.value)
												}
												className="w-full p-3 text-sm border border-blue-400 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
												rows={3}
												onKeyDown={(e) => {
													if (e.key === "Enter" && !e.shiftKey) {
														e.preventDefault();
														handleSaveEditMessage();
													}
													if (e.key === "Escape") {
														handleCancelEditMessage();
													}
												}}
											/>
											<div className="flex justify-end gap-2 mt-1">
												<button
													type="button"
													onClick={handleCancelEditMessage}
													className="px-2 py-1 text-xs text-gray-600 hover:text-gray-800"
												>
													Cancel
												</button>
												<button
													type="button"
													onClick={handleSaveEditMessage}
													className="px-2 py-1 text-xs bg-blue-500 text-white rounded hover:bg-blue-600"
												>
													Save & Send
												</button>
											</div>
										</div>
									) : (
										/* Display mode */
										<div className="group inline-flex items-start gap-1">
											{msg.role === "user" && (
												<div className="flex flex-col opacity-0 group-hover:opacity-100 transition-opacity mt-2">
													<button
														type="button"
														onClick={() => handleStartEditMessage(msg)}
														className="p-1 text-gray-400 hover:text-gray-600"
														title="Edit message"
													>
														<svg
															xmlns="http://www.w3.org/2000/svg"
															className="w-3.5 h-3.5"
															fill="none"
															viewBox="0 0 24 24"
															stroke="currentColor"
														>
															<path
																strokeLinecap="round"
																strokeLinejoin="round"
																strokeWidth={2}
																d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
															/>
														</svg>
													</button>
													<button
														type="button"
														onClick={() => handleRevertToMessage(msg)}
														className="p-1 text-gray-400 hover:text-orange-600"
														title="Revert to this point"
													>
														<svg
															xmlns="http://www.w3.org/2000/svg"
															className="w-3.5 h-3.5"
															fill="none"
															viewBox="0 0 24 24"
															stroke="currentColor"
														>
															<path
																strokeLinecap="round"
																strokeLinejoin="round"
																strokeWidth={2}
																d="M3 10h10a5 5 0 015 5v2M3 10l4-4m-4 4l4 4"
															/>
														</svg>
													</button>
												</div>
											)}
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
									)}
								</div>
							))}
						</div>

						{/* Approval UI */}
						{pendingApproval && (
							<div className="border-t border-gray-200 bg-yellow-50 p-4">
								<div className="text-sm font-medium mb-2">
									Does this look correct?
								</div>
								<div className="text-xs bg-white p-2 rounded mb-3 font-mono max-h-32 overflow-y-auto">
									{pendingApproval.output}
								</div>
								<input
									type="text"
									value={rejectionFeedback}
									onChange={(e) => setRejectionFeedback(e.target.value)}
									placeholder="Optional: describe what's wrong..."
									className="w-full px-3 py-2 text-sm border border-gray-300 rounded mb-3 focus:outline-none focus:ring-2 focus:ring-orange-500"
									onKeyPress={(e) => {
										if (e.key === "Enter") {
											handleReject("continue");
										}
									}}
								/>
								<div className="flex gap-2">
									<button
										type="button"
										onClick={handleApprove}
										className="flex-1 px-3 py-2 text-sm bg-green-500 text-white rounded hover:bg-green-600"
									>
										Yes, save it
									</button>
									<button
										type="button"
										onClick={() => handleReject("continue")}
										className="flex-1 px-3 py-2 text-sm bg-orange-500 text-white rounded hover:bg-orange-600"
									>
										Keep trying
									</button>
									<button
										type="button"
										onClick={() => handleReject("refresh")}
										className="flex-1 px-3 py-2 text-sm bg-red-500 text-white rounded hover:bg-red-600"
									>
										Start over
									</button>
								</div>
							</div>
						)}

						{/* Grabbed Elements Display */}
						{grabbedElements.length > 0 && (
							<div className="border-t border-gray-200 bg-violet-50 p-3">
								<div className="flex items-center justify-between mb-2">
									<span className="text-xs font-medium text-violet-800">
										Selected Elements ({grabbedElements.length})
									</span>
									<button
										type="button"
										onClick={handleClearGrabbedElements}
										className="text-xs text-violet-600 hover:text-violet-800"
									>
										Clear all
									</button>
								</div>
								<div className="space-y-1 max-h-32 overflow-y-auto">
									{grabbedElements.map((el) => (
										<div
											key={el.xpath}
											className="flex items-center gap-2 p-2 bg-white rounded text-xs border border-violet-200"
										>
											<div className="flex-1 min-w-0">
												<div className="font-mono text-violet-900">
													&lt;{el.tagName}
													{el.attributes.id ? `#${el.attributes.id}` : ""}
													{el.attributes.class
														? `.${el.attributes.class.split(" ")[0]}`
														: ""}
													&gt;
												</div>
												<div className="text-violet-600 truncate">
													{el.textContent.slice(0, 50)}
													{el.textContent.length > 50 ? "..." : ""}
												</div>
											</div>
											<button
												type="button"
												onClick={() => handleRemoveGrabbedElement(el.xpath)}
												className="text-violet-400 hover:text-violet-600"
											>
												x
											</button>
										</div>
									))}
								</div>
							</div>
						)}

						{/* Input */}
						<div className="border-t border-gray-200 p-3 bg-white">
							{awaitingInitialPrompt && (
								<div className="mb-2 text-xs text-gray-600 bg-blue-50 p-2 rounded">
									What would you like to change on this page? Describe the
									modifications you want to make.
								</div>
							)}
							{/* Grab Mode Banner */}
							{grabModeActive && (
								<div className="mb-2 text-xs text-violet-700 bg-violet-100 p-2 rounded flex items-center justify-between">
									<span>
										Grab mode active. Click elements on the page to select them.
									</span>
									<button
										type="button"
										onClick={handleToggleGrabMode}
										className="text-violet-800 font-semibold hover:underline"
									>
										Done
									</button>
								</div>
							)}
							{/* Status Indicator */}
							<div className="flex items-center gap-2 mb-2 text-xs">
								<div
									className={`w-2 h-2 rounded-full ${
										status === "IDLE"
											? "bg-green-500"
											: status === "SENDING_TO_LLM"
												? "bg-yellow-500 animate-pulse"
												: status === "WAITING_FOR_LLM_RESPONSE"
													? "bg-blue-500 animate-pulse"
													: "bg-purple-500 animate-pulse"
									}`}
								/>
								<span className="text-gray-600">
									{status === "IDLE"
										? "Ready"
										: status === "SENDING_TO_LLM"
											? "Sending..."
											: status === "WAITING_FOR_LLM_RESPONSE"
												? "Thinking..."
												: "Running JS..."}
								</span>
							</div>
							<div className="flex gap-2">
								<button
									type="button"
									onClick={handleToggleGrabMode}
									className={`px-2 py-1.5 text-xs rounded transition-colors self-end ${
										grabModeActive
											? "bg-violet-500 text-white hover:bg-violet-600"
											: "bg-violet-100 text-violet-700 hover:bg-violet-200"
									}`}
									title="Select elements on the page to add context"
								>
									{grabModeActive ? "..." : "Grab"}
								</button>
								<textarea
									ref={chatInputRef}
									id="chat-input"
									placeholder={
										grabbedElements.length > 0
											? `Message (${grabbedElements.length} elements)...`
											: "Type your message..."
									}
									className="flex-1 px-2 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none min-h-[36px] max-h-[120px]"
									rows={1}
									onKeyDown={(e) => {
										if (e.key === "Enter" && !e.shiftKey) {
											e.preventDefault();
											handleSendMessage();
										}
									}}
									onInput={(e) => {
										// Auto-resize textarea
										const target = e.target as HTMLTextAreaElement;
										target.style.height = "auto";
										target.style.height = `${Math.min(target.scrollHeight, 120)}px`;
									}}
								/>
								<button
									type="button"
									onClick={handleSendMessage}
									className="px-3 py-1.5 text-sm bg-blue-500 text-white rounded hover:bg-blue-600 self-end"
								>
									Send
								</button>
							</div>
						</div>
					</>
				) : (
					<div className="flex-1 flex items-center justify-center text-gray-500 text-sm">
						Click "New Mod" to start creating a userscript
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
								<label className="block text-sm font-medium mb-1">
									API URL
								</label>
								<input
									type="text"
									value={apiUrl}
									onChange={(e) => setApiUrl(e.target.value)}
									className="w-full px-3 py-2 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
								/>
							</div>
							<div>
								<label className="block text-sm font-medium mb-1">
									API Key
								</label>
								<input
									type="password"
									value={apiKey}
									onChange={(e) => setApiKey(e.target.value)}
									className="w-full px-3 py-2 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
								/>
							</div>
							<div>
								<label className="block text-sm font-medium mb-1">
									Model Name
								</label>
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
								type="button"
								onClick={handleSaveSettings}
								className="flex-1 px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
							>
								Save
							</button>
							<button
								type="button"
								onClick={() => setShowSettings(false)}
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
