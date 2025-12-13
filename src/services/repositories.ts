import type { RepositoryScript } from "../types";

// Cache for repository scripts to avoid repeated API calls
const scriptCache = new Map<
	string,
	{ scripts: RepositoryScript[]; timestamp: number }
>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

interface GreasyforkApiResponse {
	id: number;
	name: string;
	description: string;
	version: string;
	url: string;
	code_url: string;
	total_installs: number;
	daily_installs: number;
	fan_score: number;
	good_ratings: number;
	ok_ratings: number;
	bad_ratings: number;
	users: { id: number; name: string; url: string }[];
	created_at: string;
	code_updated_at: string;
}

/**
 * Normalize domain for API calls (strip www. prefix)
 */
function normalizeDomain(domain: string): string {
	return domain.replace(/^www\./, "");
}

/**
 * Fetch userscripts from Greasyfork for a specific domain
 */
async function fetchGreasyforkScriptsInternal(
	domain: string,
): Promise<RepositoryScript[]> {
	const normalizedDomain = normalizeDomain(domain);
	const apiUrl = `https://api.greasyfork.org/en/scripts/by-site/${encodeURIComponent(normalizedDomain)}.json`;

	const response = await fetch(apiUrl);
	if (!response.ok) {
		if (response.status === 404) {
			return [];
		}
		throw new Error(
			`Greasyfork API error: ${response.status} ${response.statusText}`,
		);
	}

	const data: GreasyforkApiResponse[] = await response.json();

	return data.map((script) => ({
		id: script.id,
		name: script.name,
		description: script.description || "",
		version: script.version,
		url: script.url,
		codeUrl: script.code_url,
		totalInstalls: script.total_installs,
		dailyInstalls: script.daily_installs,
		fanScore: script.fan_score,
		goodRatings: script.good_ratings,
		okRatings: script.ok_ratings,
		badRatings: script.bad_ratings,
		authorName: script.users?.[0]?.name || "Unknown",
		createdAt: script.created_at,
		updatedAt: script.code_updated_at,
		source: "greasyfork" as const,
	}));
}

/**
 * Parse OpenUserJS HTML to extract script information
 */
function parseOpenUserJSHtml(html: string): RepositoryScript[] {
	const scripts: RepositoryScript[] = [];
	const seenIds = new Set<string>();
	const linkMatches = html.matchAll(
		/<a[^>]*href="\/scripts\/([^/]+)\/([^"]+)"[^>]*>([^<]*)<\/a>/g,
	);

	for (const linkMatch of linkMatches) {
		const author = linkMatch[1];
		const scriptSlug = linkMatch[2];
		const name = linkMatch[3].trim();

		if (!name || !scriptSlug || seenIds.has(scriptSlug)) continue;
		if (scriptSlug.includes(".") || name.length < 3) continue; // Skip non-script links

		seenIds.add(scriptSlug);

		// Try to find installs count near this script
		const installsMatch = html.match(
			new RegExp(
				`${scriptSlug}[\\s\\S]{0,500}?([\\d,]+)\\s*(?:installs?|users?)`,
				"i",
			),
		);
		const installs = installsMatch
			? Number.parseInt(installsMatch[1].replace(/,/g, ""), 10)
			: 0;

		scripts.push({
			id: `oujs-${author}-${scriptSlug}`,
			name: name,
			description: "", // Would need additional parsing
			version: "",
			url: `https://openuserjs.org/scripts/${author}/${scriptSlug}`,
			codeUrl: `https://openuserjs.org/install/${author}/${scriptSlug}.user.js`,
			totalInstalls: installs,
			dailyInstalls: 0,
			fanScore: 0,
			goodRatings: 0,
			okRatings: 0,
			badRatings: 0,
			authorName: author,
			createdAt: "",
			updatedAt: "",
			source: "openuserjs" as const,
		});
	}

	return scripts;
}

/**
 * Fetch userscripts from OpenUserJS for a specific domain
 * Note: OpenUserJS doesn't have a public API, so we scrape the search page
 */
async function fetchOpenUserJSScriptsInternal(
	domain: string,
): Promise<RepositoryScript[]> {
	const normalizedDomain = normalizeDomain(domain);
	const searchUrl = `https://openuserjs.org/?q=${encodeURIComponent(normalizedDomain)}`;

	try {
		const response = await fetch(searchUrl, {
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
				Accept:
					"text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
			},
		});

		if (!response.ok) {
			// OpenUserJS has aggressive rate limiting - silently return empty on errors
			if (response.status === 429) {
				console.warn("OpenUserJS rate limited, skipping");
				return [];
			}
			return [];
		}

		const html = await response.text();
		return parseOpenUserJSHtml(html);
	} catch (error) {
		// Network errors or parsing errors - silently return empty
		console.warn("Failed to fetch from OpenUserJS:", error);
		return [];
	}
}

/**
 * Fetch userscripts from all repositories for a specific domain
 * Returns a unified list from Greasyfork and OpenUserJS
 */
export async function fetchRepositoryScripts(
	domain: string,
): Promise<RepositoryScript[]> {
	// Check cache first
	const cacheKey = `all-${domain}`;
	const cached = scriptCache.get(cacheKey);
	if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
		return cached.scripts;
	}

	// Fetch from both sources in parallel
	const [greasyforkScripts, openUserJSScripts] = await Promise.all([
		fetchGreasyforkScriptsInternal(domain).catch((err) => {
			console.warn("Greasyfork fetch failed:", err);
			return [] as RepositoryScript[];
		}),
		fetchOpenUserJSScriptsInternal(domain).catch((err) => {
			console.warn("OpenUserJS fetch failed:", err);
			return [] as RepositoryScript[];
		}),
	]);

	// Combine and deduplicate by name (prefer Greasyfork as it has more metadata)
	const scriptMap = new Map<string, RepositoryScript>();

	// Add Greasyfork scripts first (higher quality metadata)
	for (const script of greasyforkScripts) {
		const key = script.name.toLowerCase().trim();
		scriptMap.set(key, script);
	}

	// Add OpenUserJS scripts (only if not already present)
	for (const script of openUserJSScripts) {
		const key = script.name.toLowerCase().trim();
		if (!scriptMap.has(key)) {
			scriptMap.set(key, script);
		}
	}

	const scripts = Array.from(scriptMap.values());

	// Cache the results
	scriptCache.set(cacheKey, { scripts, timestamp: Date.now() });

	return scripts;
}

/**
 * Fetch the actual script code from a repository
 */
export async function fetchScriptCode(codeUrl: string): Promise<string> {
	if (!codeUrl) {
		throw new Error("Script URL is missing or invalid");
	}

	let response: Response;
	try {
		response = await fetch(codeUrl, {
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
			},
		});
	} catch (fetchError) {
		// Network errors, CORS issues, or invalid URLs
		const message =
			fetchError instanceof Error ? fetchError.message : String(fetchError);
		throw new Error(`Network error fetching script: ${message}`);
	}

	if (!response.ok) {
		throw new Error(
			`Failed to fetch script code: ${response.status} ${response.statusText}`,
		);
	}
	return response.text();
}

/**
 * Clear the script cache (useful for manual refresh)
 */
export function clearScriptCache(domain?: string): void {
	if (domain) {
		// Clear all cache keys for this domain
		scriptCache.delete(domain);
		scriptCache.delete(`all-${domain}`);
		scriptCache.delete(normalizeDomain(domain));
		scriptCache.delete(`all-${normalizeDomain(domain)}`);
	} else {
		scriptCache.clear();
	}
}
