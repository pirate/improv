import type { AppState, ChatHistory, Userscript } from "./types";

export const getCurrentTab = async () => {
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	return tab;
};

/**
 * Storage utilities using chrome.storage.local
 */
export const storage = {
	get: async <T>(key: string, defaultValue?: T): Promise<T | undefined> => {
		try {
			const result = await chrome.storage.local.get(key);
			return result[key] ?? defaultValue;
		} catch (error) {
			console.error("Storage get error:", error);
			return defaultValue;
		}
	},
	set: async <T>(key: string, value: T): Promise<void> => {
		try {
			await chrome.storage.local.set({ [key]: value });
			console.log(
				"Storage set:",
				key,
				Array.isArray(value) ? `(${value.length} items)` : typeof value,
			);
		} catch (error) {
			console.error("Storage set error:", error);
			throw error; // Re-throw so callers know it failed
		}
	},
	remove: async (key: string): Promise<void> => {
		try {
			await chrome.storage.local.remove(key);
		} catch (error) {
			console.error("Storage remove error:", error);
		}
	},
};

// Userscript storage
export const getUserscripts = async (): Promise<Userscript[]> => {
	return (await storage.get<Userscript[]>("userscripts")) ?? [];
};

export const saveUserscript = async (userscript: Userscript): Promise<void> => {
	const userscripts = await getUserscripts();
	const index = userscripts.findIndex((u) => u.id === userscript.id);
	if (index >= 0) {
		userscripts[index] = userscript;
	} else {
		userscripts.push(userscript);
	}
	try {
		await storage.set("userscripts", userscripts);
		console.log(
			"Saved userscript:",
			userscript.id,
			"Total:",
			userscripts.length,
		);
	} catch (error) {
		console.error("Failed to save userscript:", error);
		throw error; // Re-throw so UI can show error
	}
};

export const deleteUserscript = async (id: string): Promise<void> => {
	const userscripts = await getUserscripts();
	const filtered = userscripts.filter((u) => u.id !== id);
	await storage.set("userscripts", filtered);

	// Also delete associated chat histories
	const chatHistories = await getChatHistories();
	const filteredChats = chatHistories.filter((c) => c.userscriptId !== id);
	await storage.set("chatHistories", filteredChats);
};

// Chat history storage
export const getChatHistories = async (): Promise<ChatHistory[]> => {
	return (await storage.get<ChatHistory[]>("chatHistories")) ?? [];
};

export const getChatHistory = async (
	id: string,
): Promise<ChatHistory | undefined> => {
	const chatHistories = await getChatHistories();
	return chatHistories.find((c) => c.id === id);
};

export const saveChatHistory = async (
	chatHistory: ChatHistory,
): Promise<void> => {
	const chatHistories = await getChatHistories();
	const index = chatHistories.findIndex((c) => c.id === chatHistory.id);

	// Don't store screenshots in chat history to save storage space
	// Screenshots can be very large and cause quota issues
	const chatToSave = { ...chatHistory, initialScreenshot: "" };

	if (index >= 0) {
		chatHistories[index] = chatToSave;
	} else {
		chatHistories.push(chatToSave);
	}

	try {
		await storage.set("chatHistories", chatHistories);
	} catch (error) {
		console.error("Failed to save chat history:", error);
		// If storage failed, try without HTML (which can also be large)
		const minimalChat = { ...chatToSave, initialHtml: "[too large to store]" };
		if (index >= 0) {
			chatHistories[index] = minimalChat;
		} else {
			chatHistories[chatHistories.length - 1] = minimalChat;
		}
		await storage.set("chatHistories", chatHistories);
	}
};

export const deleteChatHistory = async (id: string): Promise<void> => {
	const chatHistories = await getChatHistories();
	const filtered = chatHistories.filter((c) => c.id !== id);
	await storage.set("chatHistories", filtered);
};

// Settings storage
export const getSettings = async () => {
	const apiUrl = await storage.get<string>(
		"apiUrl",
		"https://api.openai.com/v1/chat/completions",
	);
	const apiKey = await storage.get<string>("apiKey", "");
	const modelName = await storage.get<string>("modelName", "gpt-5.2");
	return { apiUrl, apiKey, modelName };
};

export const saveSettings = async (settings: {
	apiUrl: string;
	apiKey: string;
	modelName: string;
}) => {
	await storage.set("apiUrl", settings.apiUrl);
	await storage.set("apiKey", settings.apiKey);
	await storage.set("modelName", settings.modelName);
};

// Generate UUID v4
export const generateUUID = (): string => {
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		const v = c === "x" ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
};

// Check if URL matches pattern
export const urlMatchesPattern = (url: string, pattern: string): boolean => {
	try {
		const regex = new RegExp(pattern);
		return regex.test(url);
	} catch {
		return false;
	}
};

// Truncate high-entropy strings (like data URLs)
export const truncateHighEntropyStrings = (input: string): string => {
	// Truncate data URLs
	let result = input.replace(
		/(data:[^;]+;base64,)[A-Za-z0-9+/]{100,}={0,2}/g,
		"$1[...truncated...]",
	);
	// Truncate other long high-entropy strings (e.g., inline scripts with long encoded data)
	result = result.replace(/([A-Za-z0-9+/]{500,}={0,2})/g, "[...truncated...]");
	return result;
};

// Extract domain from URL
export const getDomainFromUrl = (url: string): string => {
	try {
		const urlObj = new URL(url);
		return urlObj.hostname;
	} catch {
		return "";
	}
};

// Maximum characters for HTML sent to LLM (~30k tokens ≈ 120k chars, but being conservative)
const MAX_HTML_CHARS = 80000;

/**
 * Build a shallow DOM tree representation for large pages.
 * Similar to accessibility tree / buildDOMTree.js style output.
 * Returns a compact representation showing structure without full content.
 */
export const buildShallowDOMTree = (
	html: string,
	maxLength: number,
): string => {
	// Parse HTML using DOMParser if available, otherwise use regex-based approach
	const parser = new DOMParser();
	const doc = parser.parseFromString(html, "text/html");

	const output: string[] = [];
	let charCount = 0;

	// Important attributes to keep
	const importantAttrs = [
		"id",
		"class",
		"href",
		"src",
		"type",
		"name",
		"value",
		"placeholder",
		"aria-label",
		"aria-labelledby",
		"role",
		"data-testid",
		"data-id",
		"alt",
		"title",
		"for",
		"action",
		"method",
	];

	// Elements to skip entirely
	const skipTags = new Set([
		"script",
		"style",
		"noscript",
		"svg",
		"path",
		"meta",
		"link",
	]);

	// Elements that are interactive/important - show more detail
	const interactiveTags = new Set([
		"a",
		"button",
		"input",
		"select",
		"textarea",
		"form",
		"label",
		"img",
		"video",
		"audio",
		"iframe",
	]);

	function processNode(node: Node, depth: number): boolean {
		if (charCount >= maxLength) return false;

		const indent = "  ".repeat(depth);

		if (node.nodeType === Node.TEXT_NODE) {
			const text = (node.textContent || "").trim();
			if (text && text.length > 0) {
				// Truncate long text
				const displayText =
					text.length > 100 ? `${text.slice(0, 100)}...` : text;
				const line = `${indent}"${displayText}"\n`;
				if (charCount + line.length > maxLength) return false;
				output.push(line);
				charCount += line.length;
			}
			return true;
		}

		if (node.nodeType !== Node.ELEMENT_NODE) return true;

		const el = node as Element;
		const tagName = el.tagName.toLowerCase();

		// Skip certain tags
		if (skipTags.has(tagName)) return true;

		// Build attribute string
		const attrs: string[] = [];
		for (const attrName of importantAttrs) {
			const value = el.getAttribute(attrName);
			if (value) {
				// Truncate long attribute values
				const displayValue =
					value.length > 80 ? `${value.slice(0, 80)}...` : value;
				attrs.push(`${attrName}="${displayValue}"`);
			}
		}

		const attrStr = attrs.length > 0 ? ` ${attrs.join(" ")}` : "";

		// Check if element has children
		const hasChildren = el.childNodes.length > 0;
		const isInteractive = interactiveTags.has(tagName);

		// For non-interactive elements with just text, show inline
		if (
			!isInteractive &&
			el.childNodes.length === 1 &&
			el.childNodes[0].nodeType === Node.TEXT_NODE
		) {
			const text = (el.textContent || "").trim();
			if (text) {
				const displayText =
					text.length > 100 ? `${text.slice(0, 100)}...` : text;
				const line = `${indent}<${tagName}${attrStr}>${displayText}</${tagName}>\n`;
				if (charCount + line.length > maxLength) return false;
				output.push(line);
				charCount += line.length;
				return true;
			}
		}

		// Opening tag
		const openTag = hasChildren
			? `${indent}<${tagName}${attrStr}>\n`
			: `${indent}<${tagName}${attrStr} />\n`;

		if (charCount + openTag.length > maxLength) return false;
		output.push(openTag);
		charCount += openTag.length;

		// Process children (limit depth for non-interactive elements)
		if (hasChildren) {
			const maxDepth = isInteractive ? 10 : 6;
			if (depth < maxDepth) {
				for (const child of Array.from(el.childNodes)) {
					if (!processNode(child, depth + 1)) return false;
				}
			} else if (el.childNodes.length > 0) {
				const ellipsis = `${indent}  [...${el.childNodes.length} children]\n`;
				if (charCount + ellipsis.length <= maxLength) {
					output.push(ellipsis);
					charCount += ellipsis.length;
				}
			}

			// Closing tag
			const closeTag = `${indent}</${tagName}>\n`;
			if (charCount + closeTag.length > maxLength) return false;
			output.push(closeTag);
			charCount += closeTag.length;
		}

		return true;
	}

	// Start from body
	const body = doc.body;
	if (body) {
		output.push("<body>\n");
		charCount += 7;
		for (const child of Array.from(body.childNodes)) {
			if (!processNode(child, 1)) break;
		}
		if (charCount < maxLength) {
			output.push("</body>\n");
		}
	}

	return output.join("");
};

/**
 * Prepare HTML for sending to LLM.
 * If HTML is small enough, send as-is (truncated).
 * If too large, build a shallow DOM tree representation.
 */
export const prepareHtmlForLLM = (
	html: string,
): { content: string; isShallow: boolean } => {
	// First, truncate high-entropy strings
	const cleaned = truncateHighEntropyStrings(html);

	if (cleaned.length <= MAX_HTML_CHARS) {
		return { content: cleaned, isShallow: false };
	}

	// For large pages, build shallow DOM tree
	const shallow = buildShallowDOMTree(html, MAX_HTML_CHARS);
	return { content: shallow, isShallow: true };
};
