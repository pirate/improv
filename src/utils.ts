import type { Userscript, ChatHistory, AppState } from "./types";

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
		} catch (error) {
			console.error("Storage set error:", error);
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
	await storage.set("userscripts", userscripts);
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

export const getChatHistory = async (id: string): Promise<ChatHistory | undefined> => {
	const chatHistories = await getChatHistories();
	return chatHistories.find((c) => c.id === id);
};

export const saveChatHistory = async (chatHistory: ChatHistory): Promise<void> => {
	const chatHistories = await getChatHistories();
	const index = chatHistories.findIndex((c) => c.id === chatHistory.id);
	if (index >= 0) {
		chatHistories[index] = chatHistory;
	} else {
		chatHistories.push(chatHistory);
	}
	await storage.set("chatHistories", chatHistories);
};

export const deleteChatHistory = async (id: string): Promise<void> => {
	const chatHistories = await getChatHistories();
	const filtered = chatHistories.filter((c) => c.id !== id);
	await storage.set("chatHistories", filtered);
};

// Settings storage
export const getSettings = async () => {
	const apiUrl = await storage.get<string>("apiUrl", "https://api.openai.com/v1/chat/completions");
	const apiKey = await storage.get<string>("apiKey", "");
	const modelName = await storage.get<string>("modelName", "gpt-4o");
	return { apiUrl, apiKey, modelName };
};

export const saveSettings = async (settings: { apiUrl: string; apiKey: string; modelName: string }) => {
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
export const truncateHighEntropyStrings = (html: string): string => {
	// Truncate data URLs
	html = html.replace(/(data:[^;]+;base64,)[A-Za-z0-9+/]{100,}={0,2}/g, "$1[...truncated...]");
	// Truncate other long high-entropy strings (e.g., inline scripts with long encoded data)
	html = html.replace(/([A-Za-z0-9+/]{500,}={0,2})/g, "[...truncated...]");
	return html;
};
