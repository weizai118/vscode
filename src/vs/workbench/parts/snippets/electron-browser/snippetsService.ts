/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { localize } from 'vs/nls';
import { ITextModel } from 'vs/editor/common/model';
import { ISuggestSupport, ISuggestResult, ISuggestion, LanguageId, SuggestionType, SnippetType } from 'vs/editor/common/modes';
import { registerSingleton } from 'vs/platform/instantiation/common/extensions';
import { setSnippetSuggestSupport } from 'vs/editor/contrib/suggest/suggest';
import { IModeService } from 'vs/editor/common/services/modeService';
import { Position } from 'vs/editor/common/core/position';
import { overlap, compare, startsWith, isFalsyOrWhitespace, endsWith } from 'vs/base/common/strings';
import { SnippetParser } from 'vs/editor/contrib/snippet/snippetParser';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { IExtensionService } from 'vs/workbench/services/extensions/common/extensions';
import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import { join, basename, extname } from 'path';
import * as resources from 'vs/base/common/resources';
import { mkdirp, readdir, exists } from 'vs/base/node/pfs';
import { watch } from 'vs/base/node/extfs';
import { SnippetFile, Snippet } from 'vs/workbench/parts/snippets/electron-browser/snippetsFile';
import { ISnippetsService } from 'vs/workbench/parts/snippets/electron-browser/snippets.contribution';
import { IJSONSchema } from 'vs/base/common/jsonSchema';
import { ExtensionsRegistry, IExtensionPointUser } from 'vs/workbench/services/extensions/common/extensionsRegistry';
import { languagesExtPoint } from 'vs/workbench/services/mode/common/workbenchModeService';
import { MarkdownString } from 'vs/base/common/htmlContent';
import { ILifecycleService, LifecyclePhase } from 'vs/platform/lifecycle/common/lifecycle';
import { ILogService } from 'vs/platform/log/common/log';
import { values } from 'vs/base/common/map';
import URI from 'vs/base/common/uri';
import { IFileService } from 'vs/platform/files/common/files';

namespace schema {

	export interface ISnippetsExtensionPoint {
		language: string;
		path: string;
	}

	export interface IValidSnippetsExtensionPoint {
		language: string;
		location: URI;
	}

	export function toValidSnippet(extension: IExtensionPointUser<ISnippetsExtensionPoint[]>, snippet: ISnippetsExtensionPoint, modeService: IModeService): IValidSnippetsExtensionPoint {

		if (isFalsyOrWhitespace(snippet.path)) {
			extension.collector.error(localize(
				'invalid.path.0',
				"Expected string in `contributes.{0}.path`. Provided value: {1}",
				extension.description.name, String(snippet.path)
			));
			return null;
		}

		if (isFalsyOrWhitespace(snippet.language) && !endsWith(snippet.path, '.code-snippets')) {
			extension.collector.error(localize(
				'invalid.language.0',
				"When omitting the language, the value of `contributes.{0}.path` must be a `.code-snippets`-file. Provided value: {1}",
				extension.description.name, String(snippet.path)
			));
			return null;
		}

		if (!isFalsyOrWhitespace(snippet.language) && !modeService.isRegisteredMode(snippet.language)) {
			extension.collector.error(localize(
				'invalid.language',
				"Unknown language in `contributes.{0}.language`. Provided value: {1}",
				extension.description.name, String(snippet.language)
			));
			return null;

		}

		const extensionLocation = extension.description.extensionLocation;
		const snippetLocation = resources.joinPath(extensionLocation, snippet.path);
		if (snippetLocation.path.indexOf(extensionLocation.path) !== 0) {
			extension.collector.error(localize(
				'invalid.path.1',
				"Expected `contributes.{0}.path` ({1}) to be included inside extension's folder ({2}). This might make the extension non-portable.",
				extension.description.name, snippetLocation.path, extensionLocation.path
			));
			return null;
		}

		return {
			language: snippet.language,
			location: snippetLocation
		};
	}

	export const snippetsContribution: IJSONSchema = {
		description: localize('vscode.extension.contributes.snippets', 'Contributes snippets.'),
		type: 'array',
		defaultSnippets: [{ body: [{ language: '', path: '' }] }],
		items: {
			type: 'object',
			defaultSnippets: [{ body: { language: '${1:id}', path: './snippets/${2:id}.json.' } }],
			properties: {
				language: {
					description: localize('vscode.extension.contributes.snippets-language', 'Language identifier for which this snippet is contributed to.'),
					type: 'string'
				},
				path: {
					description: localize('vscode.extension.contributes.snippets-path', 'Path of the snippets file. The path is relative to the extension folder and typically starts with \'./snippets/\'.'),
					type: 'string'
				}
			}
		}
	};
}

class SnippetsService implements ISnippetsService {

	readonly _serviceBrand: any;

	private readonly _disposables: IDisposable[] = [];
	private readonly _initPromise: Promise<any>;
	private readonly _files = new Map<string, SnippetFile>();

	constructor(
		@IEnvironmentService private readonly _environmentService: IEnvironmentService,
		@IModeService private readonly _modeService: IModeService,
		@ILogService private readonly _logService: ILogService,
		@IExtensionService extensionService: IExtensionService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@IFileService private readonly _fileService: IFileService,
	) {
		this._initExtensionSnippets();
		this._initPromise = Promise.resolve(lifecycleService.when(LifecyclePhase.Running).then(() => this._initUserSnippets()));

		setSnippetSuggestSupport(new SnippetSuggestProvider(this._modeService, this));
	}

	dispose(): void {
		dispose(this._disposables);
	}

	getSnippetFiles(): Promise<SnippetFile[]> {
		return this._initPromise.then(() => values(this._files));
	}

	getSnippets(languageId: LanguageId): Promise<Snippet[]> {
		return this._initPromise.then(() => {
			const langName = this._modeService.getLanguageIdentifier(languageId).language;
			const result: Snippet[] = [];
			const promises: Promise<any>[] = [];
			this._files.forEach(file => {
				promises.push(file.load()
					.then(file => file.select(langName, result))
					.catch(err => this._logService.error(err, file.location.toString()))
				);
			});
			return Promise.all(promises).then(() => result);
		});
	}

	getSnippetsSync(languageId: LanguageId): Snippet[] {
		const langName = this._modeService.getLanguageIdentifier(languageId).language;
		const result: Snippet[] = [];
		this._files.forEach(file => {
			// kick off loading (which is a noop in case it's already loaded)
			// and optimistically collect snippets
			file.load().catch(err => { /*ignore*/ });
			file.select(langName, result);
		});
		return result;
	}

	// --- loading, watching

	private _initExtensionSnippets(): void {
		ExtensionsRegistry.registerExtensionPoint<schema.ISnippetsExtensionPoint[]>('snippets', [languagesExtPoint], schema.snippetsContribution).setHandler(extensions => {
			for (const extension of extensions) {
				for (const contribution of extension.value) {
					const validContribution = schema.toValidSnippet(extension, contribution, this._modeService);
					if (!validContribution) {
						continue;
					}

					if (this._files.has(validContribution.location.toString())) {
						this._files.get(validContribution.location.toString()).defaultScopes.push(validContribution.language);

					} else {
						const file = new SnippetFile(validContribution.location, validContribution.language ? [validContribution.language] : undefined, extension.description, this._fileService);
						this._files.set(file.location.toString(), file);

						if (this._environmentService.isExtensionDevelopment) {
							file.load().then(file => {
								// warn about bad tabstop/variable usage
								if (file.data.some(snippet => snippet.isBogous)) {
									extension.collector.warn(localize(
										'badVariableUse',
										"One or more snippets from the extension '{0}' very likely confuse snippet-variables and snippet-placeholders (see https://code.visualstudio.com/docs/editor/userdefinedsnippets#_snippet-syntax for more details)",
										extension.description.name
									));
								}
							}, err => {
								// generic error
								extension.collector.warn(localize(
									'badFile',
									"The snippet file \"{0}\" could not be read.",
									file.location
								));
							});
						}

					}
				}
			}
		});
	}

	private _initUserSnippets(): Thenable<any> {
		const addUserSnippet = (filepath: string) => {
			const ext = extname(filepath);
			if (ext === '.json') {
				const langName = basename(filepath, '.json');
				this._files.set(filepath, new SnippetFile(URI.file(filepath), [langName], undefined, this._fileService));

			} else if (ext === '.code-snippets') {
				this._files.set(filepath, new SnippetFile(URI.file(filepath), undefined, undefined, this._fileService));
			}
		};

		const userSnippetsFolder = join(this._environmentService.appSettingsHome, 'snippets');
		return mkdirp(userSnippetsFolder).then(() => {
			return readdir(userSnippetsFolder);
		}).then(entries => {
			for (const entry of entries) {
				addUserSnippet(join(userSnippetsFolder, entry));
			}
		}).then(() => {
			// watch
			const watcher = watch(userSnippetsFolder, (type, filename) => {
				if (typeof filename !== 'string') {
					return;
				}
				const filepath = join(userSnippetsFolder, filename);
				exists(filepath).then(value => {
					if (value) {
						// file created or changed
						if (this._files.has(filepath)) {
							this._files.get(filepath).reset();
						} else {
							addUserSnippet(filepath);
						}
					} else {
						// file not found
						this._files.delete(filepath);
					}
				});
			}, (error: string) => this._logService.error(error));
			this._disposables.push({
				dispose: () => {
					if (watcher) {
						watcher.removeAllListeners();
						watcher.close();
					}
				}
			});

		}).then(undefined, err => {
			this._logService.error('Failed to load user snippets', err);
		});
	}
}

registerSingleton(ISnippetsService, SnippetsService);

export interface ISimpleModel {
	getLineContent(lineNumber: number): string;
}

export class SnippetSuggestion implements ISuggestion {

	label: string;
	detail: string;
	insertText: string;
	documentation: MarkdownString;
	overwriteBefore: number;
	sortText: string;
	noAutoAccept: boolean;
	type: SuggestionType;
	snippetType: SnippetType;

	constructor(
		readonly snippet: Snippet,
		overwriteBefore: number
	) {
		this.label = snippet.prefix;
		this.detail = localize('detail.snippet', "{0} ({1})", snippet.description || snippet.name, snippet.source);
		this.insertText = snippet.body;
		this.overwriteBefore = overwriteBefore;
		this.sortText = `${snippet.isFromExtension ? 'z' : 'a'}-${snippet.prefix}`;
		this.noAutoAccept = true;
		this.type = 'snippet';
		this.snippetType = 'textmate';
	}

	resolve(): this {
		this.documentation = new MarkdownString().appendCodeblock('', new SnippetParser().text(this.snippet.codeSnippet));
		this.insertText = this.snippet.codeSnippet;
		return this;
	}

	static compareByLabel(a: SnippetSuggestion, b: SnippetSuggestion): number {
		return compare(a.label, b.label);
	}
}


export class SnippetSuggestProvider implements ISuggestSupport {

	constructor(
		@IModeService private readonly _modeService: IModeService,
		@ISnippetsService private readonly _snippets: ISnippetsService
	) {
		//
	}

	provideCompletionItems(model: ITextModel, position: Position): Promise<ISuggestResult> {

		const languageId = this._getLanguageIdAtPosition(model, position);
		return this._snippets.getSnippets(languageId).then(snippets => {

			const suggestions: SnippetSuggestion[] = [];

			const lowWordUntil = model.getWordUntilPosition(position).word.toLowerCase();
			const lowLineUntil = model.getLineContent(position.lineNumber).substr(Math.max(0, position.column - 100), position.column - 1).toLowerCase();

			for (const snippet of snippets) {

				const lowPrefix = snippet.prefix.toLowerCase();
				let overwriteBefore = 0;
				let accetSnippet = true;

				if (lowWordUntil.length > 0 && startsWith(lowPrefix, lowWordUntil)) {
					// cheap match on the (none-empty) current word
					overwriteBefore = lowWordUntil.length;
					accetSnippet = true;

				} else if (lowLineUntil.length > 0 && lowLineUntil.match(/[^\s]$/)) {
					// compute overlap between snippet and (none-empty) line on text
					overwriteBefore = overlap(lowLineUntil, snippet.prefix.toLowerCase());
					accetSnippet = overwriteBefore > 0 && !model.getWordAtPosition(new Position(position.lineNumber, position.column - overwriteBefore));
				}

				if (accetSnippet) {
					suggestions.push(new SnippetSuggestion(snippet, overwriteBefore));
				}
			}

			// dismbiguate suggestions with same labels
			suggestions.sort(SnippetSuggestion.compareByLabel);

			for (let i = 0; i < suggestions.length; i++) {
				let item = suggestions[i];
				let to = i + 1;
				for (; to < suggestions.length && item.label === suggestions[to].label; to++) {
					suggestions[to].label = localize('snippetSuggest.longLabel', "{0}, {1}", suggestions[to].label, suggestions[to].snippet.name);
				}
				if (to > i + 1) {
					suggestions[i].label = localize('snippetSuggest.longLabel', "{0}, {1}", suggestions[i].label, suggestions[i].snippet.name);
					i = to;
				}
			}
			return { suggestions };
		});
	}

	resolveCompletionItem?(model: ITextModel, position: Position, item: ISuggestion): ISuggestion {
		return (item instanceof SnippetSuggestion) ? item.resolve() : item;
	}

	private _getLanguageIdAtPosition(model: ITextModel, position: Position): LanguageId {
		// validate the `languageId` to ensure this is a user
		// facing language with a name and the chance to have
		// snippets, else fall back to the outer language
		model.tokenizeIfCheap(position.lineNumber);
		let languageId = model.getLanguageIdAtPosition(position.lineNumber, position.column);
		let { language } = this._modeService.getLanguageIdentifier(languageId);
		if (!this._modeService.getLanguageName(language)) {
			languageId = model.getLanguageIdentifier().id;
		}
		return languageId;
	}
}

export function getNonWhitespacePrefix(model: ISimpleModel, position: Position): string {
	/**
	 * Do not analyze more characters
	 */
	const MAX_PREFIX_LENGTH = 100;

	let line = model.getLineContent(position.lineNumber).substr(0, position.column - 1);

	let minChIndex = Math.max(0, line.length - MAX_PREFIX_LENGTH);
	for (let chIndex = line.length - 1; chIndex >= minChIndex; chIndex--) {
		let ch = line.charAt(chIndex);

		if (/\s/.test(ch)) {
			return line.substr(chIndex + 1);
		}
	}

	if (minChIndex === 0) {
		return line;
	}

	return '';
}
