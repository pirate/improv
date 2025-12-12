export interface UserscriptMetadata {
	name: string;
	description: string;
	version: string;
	author: string;
	match: string[];
	include: string[];
	exclude: string[];
	grant: string[];
	runAt: string;
	namespace: string;
}

/**
 * Parse the // ==UserScript== metadata block from a userscript
 */
export function parseUserscriptMetadata(code: string): UserscriptMetadata {
	const metadata: UserscriptMetadata = {
		name: "",
		description: "",
		version: "",
		author: "",
		match: [],
		include: [],
		exclude: [],
		grant: [],
		runAt: "document-idle",
		namespace: "",
	};

	// Find the metadata block
	const metaBlockMatch = code.match(
		/\/\/\s*==UserScript==\s*([\s\S]*?)\/\/\s*==\/UserScript==/,
	);
	if (!metaBlockMatch) {
		return metadata;
	}

	const metaBlock = metaBlockMatch[1];
	const lines = metaBlock.split("\n");

	for (const line of lines) {
		const match = line.match(/\/\/\s*@(\S+)\s+(.*)/);
		if (!match) continue;

		const [, key, value] = match;
		const trimmedValue = value.trim();

		switch (key) {
			case "name":
				metadata.name = trimmedValue;
				break;
			case "description":
				metadata.description = trimmedValue;
				break;
			case "version":
				metadata.version = trimmedValue;
				break;
			case "author":
				metadata.author = trimmedValue;
				break;
			case "match":
				metadata.match.push(trimmedValue);
				break;
			case "include":
				metadata.include.push(trimmedValue);
				break;
			case "exclude":
				metadata.exclude.push(trimmedValue);
				break;
			case "grant":
				metadata.grant.push(trimmedValue);
				break;
			case "run-at":
				metadata.runAt = trimmedValue;
				break;
			case "namespace":
				metadata.namespace = trimmedValue;
				break;
		}
	}

	return metadata;
}

/**
 * Convert a @match or @include pattern to a regex string
 * Supports:
 * - Wildcard patterns like *://example.com/*
 * - Glob patterns like https://*.example.com/*
 * - Regular expressions (if wrapped in /.../)
 */
export function matchPatternToRegex(pattern: string): string {
	// If it's already a regex (wrapped in /.../)
	if (pattern.startsWith("/") && pattern.endsWith("/")) {
		return pattern.slice(1, -1);
	}

	// Handle special wildcards
	// * matches any characters
	// ? matches a single character (rarely used in userscripts)

	// Escape regex special characters except * and ?
	const regex = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		// Convert glob * to regex .*
		.replace(/\*/g, ".*")
		// Convert glob ? to regex .
		.replace(/\?/g, ".");

	// Wrap in ^ and $ for full match
	return `^${regex}$`;
}

/**
 * Convert all @match and @include patterns to a single combined regex
 */
export function metadataToMatchRegex(metadata: UserscriptMetadata): string {
	const allPatterns = [...metadata.match, ...metadata.include];

	if (allPatterns.length === 0) {
		// Default to matching all URLs if no patterns specified
		return ".*";
	}

	// Convert each pattern to regex and combine with OR
	const regexPatterns = allPatterns.map(matchPatternToRegex);

	// Combine all patterns with OR (|)
	if (regexPatterns.length === 1) {
		return regexPatterns[0];
	}

	return `(${regexPatterns.join("|")})`;
}
