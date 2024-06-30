import {
	App,
	FileSystemAdapter,
	MarkdownPostProcessorContext,
	Plugin,
	PluginSettingTab,
	SectionCache,
	Setting,
	TFile,
	TFolder,
} from "obsidian";
import { Md5 } from "ts-md5";
import * as fs from "fs";
import * as temp from "temp";
import * as path from "path";
import { exec } from "child_process";

interface MyPluginSettings {
	command: string;
	timeout: number;
	enableCache: boolean;
	cache: Array<[string, Set<string>]>;
	cacheFolder: string;
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	command: ``,
	timeout: 10000,
	enableCache: true,
	cache: [],
	cacheFolder: "svg-cache",
};

export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;
	cacheFolderPathW: string;

	cache: Map<string, Set<string>>; // Key: md5 hash of latex source. Value: Set of file path names.

	async onload() {
		await this.loadSettings();
		console.log("Loaded settings", this.settings);
		if (this.settings.enableCache) await this.loadCache();
		this.addSettingTab(new SampleSettingTab(this.app, this));
		this.registerMarkdownCodeBlockProcessor("latex", (source, el, ctx) =>
			this.renderLatexToElement(source, el, ctx)
		);
	}

	// onunload() {
	// 	if (this.settings.enableCache) this.unloadCache();
	// }

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async loadCache() {
		console.log("Loading cache", this.settings.cacheFolder);
		this.cacheFolderPathW = path.join(
			(this.app.vault.adapter as FileSystemAdapter).getBasePath(),
			this.settings.cacheFolder
			// this.app.vault.configDir,
			// "obsidian-latex-render-svg-cache"
		);
		if (!fs.existsSync(this.cacheFolderPathW)) {
			fs.mkdirSync(this.cacheFolderPathW);
			this.cache = new Map();
		} else {
			this.cache = new Map(this.settings.cache);
			// For some reason `this.cache` at this point is actually `Map<string, Array<string>>`
			for (const [k, v] of this.cache) {
				this.cache.set(k, new Set(v));
			}
		}
	}

	unloadCache() {
		fs.rmdirSync(this.cacheFolderPathW, { recursive: true });
	}

	formatLatexSource(source: string) {
		return "\\documentclass{standalone}\n" + source;
	}

	hashLatexSource(source: string) {
		return Md5.hashStr(source.trim());
	}

	addRandomPrefixToIds(svgStr: string) {
		function generateRandomPrefix() {
			let letters = "abcdefghijklmnopqrstuvwxyz";
			letters += letters.toUpperCase();
			let prefix = "";
			for (let i = 0; i < 4; i++) {
				prefix += letters[Math.floor(Math.random() * letters.length)];
			}
			return prefix;
		}

		// Generate a random 4-letter prefix
		const randomPrefix = generateRandomPrefix();

		// Replace the id substrings
		let updatedSvgStr = svgStr
			.toString()
			.replace(/xlink:href='#g/g, `xlink:href='#g${randomPrefix}`);

		updatedSvgStr = updatedSvgStr
			.toString()
			.replace(/<path id='g/g, `<path id='g${randomPrefix}`);

		const encoder = new TextEncoder();
		const updatedArrayBuffer = encoder.encode(updatedSvgStr);

		return updatedSvgStr;
	}

	async renderLatexToElement(
		source: string,
		el: HTMLElement,
		ctx: MarkdownPostProcessorContext
	) {
		return new Promise<void>((resolve, reject) => {
			let md5Hash = this.hashLatexSource(source);
			let svgPath = path.join(this.cacheFolderPathW, `${md5Hash}.svg`);

			// SVG file has already been cached
			// Could have a case where svgCache has the key but the cached file has been deleted
			if (
				this.settings.enableCache &&
				this.cache.has(md5Hash) &&
				fs.existsSync(svgPath)
			) {
				console.log("Using cached SVG: ", md5Hash);
				el.innerHTML = fs.readFileSync(svgPath).toString();
				this.addFileToCache(md5Hash, ctx.sourcePath);
				resolve();
			} else {
				console.log("Rendering SVG: ", md5Hash);

				this.renderLatexToSVG(source, md5Hash, svgPath)
					.then((v: string) => {
						// v = this.addRandomPrefixToIds(v);
						if (this.settings.enableCache)
							this.addFileToCache(md5Hash, ctx.sourcePath);
						el.innerHTML = v;
						resolve();
					})
					.catch((err) => {
						el.innerHTML = err;
						reject(err);
					});
			}
		}).then(() => {
			if (this.settings.enableCache)
				setTimeout(() => this.cleanUpCache(), 1000);
		});
	}

	renderLatexToSVG(source: string, md5Hash: string, svgPath: string) {
		return new Promise(async (resolve, reject) => {
			source = this.formatLatexSource(source);

			temp.mkdir("obsidian-latex-renderer", (err, dirPath) => {
				if (err) reject(err);
				fs.writeFileSync(path.join(dirPath, md5Hash + ".tex"), source);
				exec(
					this.settings.command.replace(/{file-path}/g, md5Hash),
					{ timeout: this.settings.timeout, cwd: dirPath },
					async (err, stdout, stderr) => {
						if (err) reject([err, stdout, stderr]);
						else {
							let svgData = fs.readFileSync(
								path.join(dirPath, md5Hash + ".svg")
							);
							let svgDataStr = this.addRandomPrefixToIds(
								svgData.toString()
							);
							if (this.settings.enableCache) {
								fs.writeFileSync(svgPath, svgDataStr);
								// fs.copyFileSync(
								// 	path.join(dirPath, md5Hash + ".svg"),
								// 	svgPath
								// );
							}
							// let svgData = fs.readFileSync(
							// 	path.join(dirPath, md5Hash + ".svg")
							// );
							resolve(svgDataStr);
						}
					}
				);
			});
		});
	}

	async saveCache() {
		let temp = new Map();
		for (const [k, v] of this.cache) {
			temp.set(k, [...v]);
		}
		this.settings.cache = [...temp];
		await this.saveSettings();
	}

	addFileToCache(hash: string, file_path: string) {
		if (!this.cache.has(hash)) {
			this.cache.set(hash, new Set());
		}
		this.cache.get(hash)?.add(file_path);
	}

	async cleanUpCache() {
		let file_paths = new Set<string>();
		for (const fps of this.cache.values()) {
			for (const fp of fps) {
				file_paths.add(fp);
			}
		}

		for (const file_path of file_paths) {
			let file = this.app.vault.getAbstractFileByPath(file_path);
			if (file == null) {
				this.removeFileFromCache(file_path);
			} else {
				await this.removeUnusedCachesForFile(file as TFile);
			}
		}
		await this.saveCache();
	}

	async removeUnusedCachesForFile(file: TFile) {
		let hashes_in_file = await this.getLatexHashesFromFile(file);
		let hashes_in_cache = this.getLatexHashesFromCacheForFile(file);
		for (const hash of hashes_in_cache) {
			if (!hashes_in_file.contains(hash)) {
				this.cache.get(hash)?.delete(file.path);
				if (this.cache.get(hash)?.size == 0) {
					this.removeSVGFromCache(hash);
				}
			}
		}
	}

	removeSVGFromCache(key: string) {
		this.cache.delete(key);
		fs.rmSync(path.join(this.cacheFolderPathW, `${key}.svg`));
	}

	removeFileFromCache(file_path: string) {
		for (const hash of this.cache.keys()) {
			this.cache.get(hash)?.delete(file_path);
			if (this.cache.get(hash)?.size == 0) {
				this.removeSVGFromCache(hash);
			}
		}
	}

	getLatexHashesFromCacheForFile(file: TFile) {
		let hashes: string[] = [];
		let path = file.path;
		for (const [k, v] of this.cache.entries()) {
			if (v.has(path)) {
				hashes.push(k);
			}
		}
		return hashes;
	}

	async getLatexHashesFromFile(file: TFile) {
		let hashes: string[] = [];
		let sections = this.app.metadataCache.getFileCache(file)?.sections;
		if (sections != undefined) {
			let lines = (await this.app.vault.read(file)).split("\n");
			for (const section of sections) {
				if (
					section.type != "code" &&
					lines[section.position.start.line].match("``` *latex") ==
						null
				)
					continue;
				let source = lines
					.slice(
						section.position.start.line + 1,
						section.position.end.line
					)
					.join("\n");
				let hash = this.hashLatexSource(source);
				hashes.push(hash);
			}
		}
		return hashes;
	}
}

class SampleSettingTab extends PluginSettingTab {
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		containerEl.createEl("h2", {
			text: "Settings for the Latex Renderer plugin.",
		});

		new Setting(containerEl)
			.setName("Command to generate SVG")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.command.toString())
					.onChange(async (value) => {
						this.plugin.settings.command = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Enable caching of SVGs")
			.setDesc(
				"SVGs rendered by this plugin will be kept in `.obsidian/obsidian-latex-render-svg-cache`. The plugin will automatically keep track of used svgs and remove any that aren't being used"
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableCache)
					.onChange(async (value) => {
						this.plugin.settings.enableCache = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Cache folder path")
			.setDesc(
				"SVGs rendered by this plugin will be kept in this folder, if set.  The default is `.obsidian/obsidian-latex-render-svg-cache`. The plugin will automatically keep track of used svgs and remove any that aren't being used"
			)
			.addText((text) =>
				text
					.setValue(this.plugin.settings.cacheFolder)
					.onChange(async (value) => {
						this.plugin.settings.cacheFolder = value;
						await this.plugin.saveSettings();
						this.plugin.unloadCache();
						this.plugin.loadCache();
					})
			);
	}
}
