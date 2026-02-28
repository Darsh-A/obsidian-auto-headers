import {
	App,
	Editor,
	EditorPosition,
	EditorSuggest,
	EditorSuggestContext,
	EditorSuggestTriggerInfo,
	Plugin,
	PluginSettingTab,
	Setting,
	TAbstractFile,
	TFile
} from "obsidian";

interface HeadingAutolinkSettings {
	minChars: number;
	enableFuzzyMatching: boolean;
	minFuzzyScore: number;
	caseSensitive: boolean;
	insertAlias: boolean;
	includeFolderInPreview: boolean;
	maxPhraseWords: number;
	maxSuggestions: number;
	debugLogging: boolean;
	suppressWhenOtherSuggestionsOpen: boolean;
}

const DEFAULT_SETTINGS: HeadingAutolinkSettings = {
	minChars: 3,
	enableFuzzyMatching: true,
	minFuzzyScore: 18,
	caseSensitive: false,
	insertAlias: true,
	includeFolderInPreview: true,
	maxPhraseWords: 6,
	maxSuggestions: 20,
	debugLogging: false,
	suppressWhenOtherSuggestionsOpen: true
};

interface HeadingEntry {
	heading: string;
	headingLower: string;
	filePath: string;
	fileName: string;
	folderPath: string;
	level: number;
}

interface ScoredHeading {
	entry: HeadingEntry;
	score: number;
	matchType: "exact" | "prefix" | "substring" | "token" | "fuzzy";
}

class HeadingIndex {
	private readonly app: App;
	private readonly log: (...args: unknown[]) => void;
	private entriesByPath = new Map<string, HeadingEntry[]>();
	private allEntries: HeadingEntry[] = [];
	private pendingPaths = new Set<string>();
	private flushTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

	constructor(app: App, log: (...args: unknown[]) => void) {
		this.app = app;
		this.log = log;
	}

	initialize(): void {
		this.log("index.initialize");
		this.rebuildAll();
	}

	rebuildAll(): void {
		this.entriesByPath.clear();
		for (const file of this.app.vault.getMarkdownFiles()) {
			this.reindexFile(file);
		}
		this.refreshFlatCache();
		this.log("index.rebuildAll", {
			files: this.entriesByPath.size,
			headings: this.allEntries.length
		});
	}

	scheduleReindex(file: TFile): void {
		if (file.extension !== "md") {
			return;
		}

		this.pendingPaths.add(file.path);
		if (this.flushTimer !== null) {
			globalThis.clearTimeout(this.flushTimer);
		}

		this.flushTimer = globalThis.setTimeout(() => {
			const pathsToRefresh = Array.from(this.pendingPaths);
			this.pendingPaths.clear();
			this.flushTimer = null;

			for (const path of pathsToRefresh) {
				const abstract = this.app.vault.getAbstractFileByPath(path);
				if (abstract instanceof TFile && abstract.extension === "md") {
					this.reindexFile(abstract);
				} else {
					this.entriesByPath.delete(path);
				}
			}

			this.refreshFlatCache();
			this.log("index.flushReindex", {
				changedFiles: pathsToRefresh.length,
				headings: this.allEntries.length
			});
		}, 120);
	}

	handleRename(file: TAbstractFile, oldPath: string): void {
		this.entriesByPath.delete(oldPath);
		if (file instanceof TFile && file.extension === "md") {
			this.scheduleReindex(file);
		} else {
			this.refreshFlatCache();
		}
	}

	handleDelete(file: TAbstractFile): void {
		if (file instanceof TFile && file.extension === "md") {
			this.entriesByPath.delete(file.path);
			this.refreshFlatCache();
		}
	}

	search(query: string, settings: HeadingAutolinkSettings): ScoredHeading[] {
		const normalizedQuery = settings.caseSensitive ? query : query.toLowerCase();
		const queryTokens = tokenize(normalizedQuery);
		if (normalizedQuery.length < settings.minChars) {
			return [];
		}

		const results: ScoredHeading[] = [];

		for (const entry of this.allEntries) {
			const candidate = settings.caseSensitive ? entry.heading : entry.headingLower;
			const scoreResult = scoreCandidate(
				candidate,
				normalizedQuery,
				queryTokens,
				settings.enableFuzzyMatching,
				settings.minFuzzyScore
			);
			if (!scoreResult) {
				continue;
			}

			results.push({
				entry,
				score: scoreResult.score,
				matchType: scoreResult.matchType
			});
		}

		results.sort((a, b) => {
			if (b.score !== a.score) {
				return b.score - a.score;
			}
			if (a.entry.heading.length !== b.entry.heading.length) {
				return a.entry.heading.length - b.entry.heading.length;
			}
			if (a.entry.fileName !== b.entry.fileName) {
				return a.entry.fileName.localeCompare(b.entry.fileName);
			}
			return a.entry.heading.localeCompare(b.entry.heading);
		});

		const limited = results.slice(0, settings.maxSuggestions);
		this.log("search", {
			query,
			normalizedQuery,
			totalHeadings: this.allEntries.length,
			matches: results.length,
			returned: limited.length
		});
		return limited;
	}

	private reindexFile(file: TFile): void {
		const cache = this.app.metadataCache.getFileCache(file);
		const headings = cache?.headings ?? [];
		const entries: HeadingEntry[] = headings.map((heading) => ({
			heading: heading.heading,
			headingLower: heading.heading.toLowerCase(),
			filePath: file.path,
			fileName: file.basename,
			folderPath: file.parent?.path ?? "",
			level: heading.level
		}));

		this.entriesByPath.set(file.path, entries);
	}

	private refreshFlatCache(): void {
		this.allEntries = Array.from(this.entriesByPath.values()).flat();
	}
}

function tokenize(text: string): string[] {
	return text
		.split(/\s+/)
		.map((token) => token.trim())
		.filter((token) => token.length > 0);
}

function scoreCandidate(
	candidate: string,
	query: string,
	queryTokens: string[],
	enableFuzzy: boolean,
	minFuzzyScore: number
): { score: number; matchType: ScoredHeading["matchType"] } | null {
	if (candidate === query) {
		return { score: 1000, matchType: "exact" };
	}

	if (candidate.startsWith(query)) {
		return { score: 850 - Math.min(200, candidate.length - query.length), matchType: "prefix" };
	}

	const containsIndex = candidate.indexOf(query);
	if (containsIndex >= 0) {
		return { score: 650 - Math.min(150, containsIndex * 2), matchType: "substring" };
	}

	if (queryTokens.length > 1 && queryTokens.every((token) => candidate.includes(token))) {
		const totalTokenLength = queryTokens.reduce((sum, token) => sum + token.length, 0);
		return { score: 500 + Math.min(120, totalTokenLength * 5), matchType: "token" };
	}

	if (enableFuzzy) {
		const fuzzyScore = fuzzySubsequenceScore(candidate, query);
		if (fuzzyScore >= minFuzzyScore) {
			return { score: 250 + fuzzyScore, matchType: "fuzzy" };
		}
	}

	return null;
}

function fuzzySubsequenceScore(candidate: string, query: string): number {
	let score = 0;
	let queryIndex = 0;
	let previousHitIndex = -2;

	for (let i = 0; i < candidate.length && queryIndex < query.length; i++) {
		if (candidate[i] !== query[queryIndex]) {
			continue;
		}

		score += 8;
		if (i === 0 || candidate[i - 1] === " ") {
			score += 5;
		}
		if (i === previousHitIndex + 1) {
			score += 4;
		}

		previousHitIndex = i;
		queryIndex++;
	}

	if (queryIndex !== query.length) {
		return 0;
	}

	const completionPenalty = Math.max(0, candidate.length - query.length);
	return Math.max(1, score - Math.min(40, completionPenalty));
}

function escapeWikilinkPart(text: string): string {
	return text.replace(/([\\|[\]])/g, "\\$1");
}

function isPhraseChar(char: string): boolean {
	return /[A-Za-z0-9_'’-]/.test(char);
}

function extractPhraseFromSegment(segment: string, maxWords: number): { query: string; startOffset: number } | null {
	if (!segment) {
		return null;
	}

	let end = segment.length - 1;
	while (end >= 0 && !isPhraseChar(segment[end])) {
		end--;
	}
	if (end < 0) {
		return null;
	}

	let start = end;
	let words = 1;
	while (start > 0) {
		const prev = segment[start - 1];
		if (isPhraseChar(prev)) {
			start--;
			continue;
		}
		if (/\s/.test(prev)) {
			let scan = start - 1;
			while (scan >= 0 && /\s/.test(segment[scan])) {
				scan--;
			}
			if (scan >= 0 && isPhraseChar(segment[scan]) && words < Math.max(1, maxWords)) {
				words++;
				start = scan;
				while (start > 0 && isPhraseChar(segment[start - 1])) {
					start--;
				}
				continue;
			}
		}
		break;
	}

	const query = segment.slice(start, end + 1).trim();
	if (!query) {
		return null;
	}

	return { query, startOffset: start };
}

class HeadingEditorSuggest extends EditorSuggest<ScoredHeading> {
	private readonly plugin: HeadingAutolinkPlugin;
	private manualTriggerActive = false;

	constructor(app: App, plugin: HeadingAutolinkPlugin) {
		super(app);
		this.plugin = plugin;
	}

	triggerManual(editor: Editor, file: TFile): void {
		this.manualTriggerActive = true;
		(this as unknown as { trigger: (e: Editor, f: TFile, allowNoTrigger?: boolean) => void }).trigger(editor, file, true);
		globalThis.setTimeout(() => {
			this.manualTriggerActive = false;
		}, 250);
	}

	onTrigger(cursor: EditorPosition, editor: Editor, _file: TFile | null): EditorSuggestTriggerInfo | null {
		const settings = this.plugin.settings;
		if (!this.manualTriggerActive && settings.suppressWhenOtherSuggestionsOpen && this.plugin.hasForeignSuggestionPopupOpen()) {
			this.plugin.logDebug("trigger.skip", { reason: "foreign-suggestion-open" });
			return null;
		}

		const line = editor.getLine(cursor.line);
		const beforeCursor = line.slice(0, cursor.ch);
		if (!beforeCursor) {
			this.plugin.logDebug("trigger.skip", { reason: "empty-before-cursor" });
			return null;
		}

		const lastWikiOpen = beforeCursor.lastIndexOf("[[");
		const lastWikiClose = beforeCursor.lastIndexOf("]]");
		if (lastWikiOpen > lastWikiClose) {
			this.plugin.logDebug("trigger.skip", { reason: "inside-wikilink" });
			return null;
		}

		const maxChars = 120;
		const segmentStart = Math.max(0, beforeCursor.length - maxChars);
		const segment = beforeCursor.slice(segmentStart);
		const phrase = extractPhraseFromSegment(segment, settings.maxPhraseWords);
		if (!phrase) {
			this.plugin.logDebug("trigger.skip", { reason: "no-phrase-match", segment });
			return null;
		}

		const query = phrase.query;
		if (query.trim().length < settings.minChars) {
			this.plugin.logDebug("trigger.skip", {
				reason: "below-min-chars",
				query,
				minChars: settings.minChars
			});
			return null;
		}

		const start: EditorPosition = {
			line: cursor.line,
			ch: segmentStart + phrase.startOffset
		};
		this.plugin.logDebug("trigger.hit", { query, start, end: cursor });

		return {
			start,
			end: cursor,
			query
		};
	}

	getSuggestions(context: EditorSuggestContext): ScoredHeading[] {
		this.plugin.logDebug("suggest.get", { query: context.query });
		return this.plugin.headingIndex.search(context.query, this.plugin.settings);
	}

	renderSuggestion(suggestion: ScoredHeading, el: HTMLElement): void {
		el.addClass("heading-autolink-suggestion");

		const content = el.createDiv({ cls: "suggestion-content" });
		content.createDiv({
			cls: "suggestion-title",
			text: `${"#".repeat(Math.max(1, suggestion.entry.level))} ${suggestion.entry.heading}`
		});

		const subtitleParts = [suggestion.entry.fileName];
		if (this.plugin.settings.includeFolderInPreview && suggestion.entry.folderPath) {
			subtitleParts.push(suggestion.entry.folderPath);
		}
		subtitleParts.push(suggestion.matchType);

		content.createDiv({
			cls: "suggestion-note",
			text: subtitleParts.join("  •  ")
		});
	}

	selectSuggestion(suggestion: ScoredHeading): void {
		const context = this.context;
		if (!context) {
			return;
		}

		const link = this.buildLink(suggestion);
		this.plugin.logDebug("suggest.select", {
			query: context.query,
			link,
			file: suggestion.entry.filePath
		});
		context.editor.replaceRange(link, context.start, context.end);
		context.editor.setCursor({
			line: context.start.line,
			ch: context.start.ch + link.length
		});
	}

	private buildLink(suggestion: ScoredHeading): string {
		const escapedFile = escapeWikilinkPart(suggestion.entry.fileName);
		const escapedHeading = escapeWikilinkPart(suggestion.entry.heading);
		const baseTarget = `${escapedFile}#${escapedHeading}`;
		if (!this.plugin.settings.insertAlias) {
			return `[[${baseTarget}]]`;
		}

		const alias = escapedHeading;
		return `[[${baseTarget}|${alias}]]`;
	}
}

class HeadingAutolinkSettingTab extends PluginSettingTab {
	private readonly plugin: HeadingAutolinkPlugin;

	constructor(app: App, plugin: HeadingAutolinkPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("Behavior").setHeading();

		new Setting(containerEl)
			.setName("Minimum characters before suggestions")
			.setDesc("Suggestions appear once the active phrase reaches this length.")
			.addSlider((slider) =>
				slider
					.setLimits(1, 10, 1)
					.setValue(this.plugin.settings.minChars)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.minChars = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Enable fuzzy matching")
			.setDesc("Match headings using ordered character matching when direct matching fails.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.enableFuzzyMatching).onChange(async (value) => {
					this.plugin.settings.enableFuzzyMatching = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Minimum fuzzy score")
			.setDesc("Higher value is stricter (fewer fuzzy results). Lower value is more permissive.")
			.addSlider((slider) =>
				slider
					.setLimits(1, 80, 1)
					.setValue(this.plugin.settings.minFuzzyScore)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.minFuzzyScore = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Case-sensitive matching")
			.setDesc("Only show matches that respect exact capitalization.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.caseSensitive).onChange(async (value) => {
					this.plugin.settings.caseSensitive = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Insert link alias")
			.setDesc("Insert `[[File#Heading|Heading]]` instead of raw `[[File#Heading]]`.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.insertAlias).onChange(async (value) => {
					this.plugin.settings.insertAlias = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Show folder path in suggestions")
			.setDesc("Display each heading's parent folder in the suggestion subtitle.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.includeFolderInPreview).onChange(async (value) => {
					this.plugin.settings.includeFolderInPreview = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Maximum words in a typed phrase")
			.setDesc("Controls multi-word phrase capture for trigger detection.")
			.addSlider((slider) =>
				slider
					.setLimits(1, 12, 1)
					.setValue(this.plugin.settings.maxPhraseWords)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.maxPhraseWords = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Maximum number of suggestions")
			.setDesc("Upper bound for suggestions returned per query.")
			.addSlider((slider) =>
				slider
					.setLimits(5, 50, 1)
					.setValue(this.plugin.settings.maxSuggestions)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.maxSuggestions = value;
						await this.plugin.saveSettings();
					})
				);

		new Setting(containerEl)
			.setName("Debug logging")
			.setDesc("Write detailed plugin diagnostics to the developer console.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.debugLogging).onChange(async (value) => {
					this.plugin.settings.debugLogging = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Compatibility with other suggesters")
			.setDesc("When another suggestion popup is open, suppress auto-trigger. Use the command to trigger heading suggestions manually.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.suppressWhenOtherSuggestionsOpen).onChange(async (value) => {
					this.plugin.settings.suppressWhenOtherSuggestionsOpen = value;
					await this.plugin.saveSettings();
				})
			);
	}
}

export default class HeadingAutolinkPlugin extends Plugin {
	settings: HeadingAutolinkSettings = DEFAULT_SETTINGS;
	headingIndex!: HeadingIndex;
	private editorSuggest!: HeadingEditorSuggest;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.logDebug("plugin.onload");

		this.headingIndex = new HeadingIndex(this.app, (...args) => this.logDebug(...args));
		this.headingIndex.initialize();

		this.editorSuggest = new HeadingEditorSuggest(this.app, this);
		this.registerEditorSuggest(this.editorSuggest);
		this.addSettingTab(new HeadingAutolinkSettingTab(this.app, this));
		this.addCommand({
			id: "trigger-heading-autolink-suggestions",
			name: "Trigger heading suggestions",
			editorCallback: (editor) => {
				const file = this.app.workspace.getActiveFile();
				if (!(file instanceof TFile)) {
					return;
				}
				this.editorSuggest.triggerManual(editor, file);
			}
		});

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file instanceof TFile) {
					this.logDebug("event.vault.modify", { path: file.path });
					this.headingIndex.scheduleReindex(file);
				}
			})
		);

		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				this.logDebug("event.vault.rename", {
					oldPath,
					newPath: file.path
				});
				this.headingIndex.handleRename(file, oldPath);
			})
		);

		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				this.logDebug("event.vault.delete", { path: file.path });
				this.headingIndex.handleDelete(file);
			})
		);

		this.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
				this.logDebug("event.cache.changed", { path: file.path });
				this.headingIndex.scheduleReindex(file);
			})
		);

		this.registerEvent(
			this.app.metadataCache.on("resolved", () => {
				this.logDebug("event.cache.resolved");
				this.headingIndex.rebuildAll();
			})
		);
	}

	onunload(): void {
		this.logDebug("plugin.onunload");
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<HeadingAutolinkSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
	}

	logDebug(...args: unknown[]): void {
		if (!this.settings.debugLogging) {
			return;
		}
		globalThis.console.debug("[HeadingAutolink]", ...args);
	}

	hasForeignSuggestionPopupOpen(): boolean {
		const containers = Array.from(globalThis.document.querySelectorAll(".suggestion-container"));
		for (const container of containers) {
			if (!(container instanceof HTMLElement)) {
				continue;
			}
			if (container.querySelector(".heading-autolink-suggestion")) {
				continue;
			}
			if (container.querySelector(".suggestion-item")) {
				return true;
			}
		}
		return false;
	}
}
