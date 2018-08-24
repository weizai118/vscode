/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import 'vs/css!./media/suggestEnabledInput';
import { $, addClass, append, removeClass, Dimension } from 'vs/base/browser/dom';
import { chain, Emitter, Event } from 'vs/base/common/event';
import { KeyCode } from 'vs/base/common/keyCodes';
import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import { isMacintosh } from 'vs/base/common/platform';
import uri from 'vs/base/common/uri';
import { CodeEditorWidget } from 'vs/editor/browser/widget/codeEditorWidget';
import { IEditorOptions } from 'vs/editor/common/config/editorOptions';
import * as modes from 'vs/editor/common/modes';
import { IModelService } from 'vs/editor/common/services/modelService';
import { ContextMenuController } from 'vs/editor/contrib/contextmenu/contextmenu';
import { SnippetController2 } from 'vs/editor/contrib/snippet/snippetController2';
import { SuggestController } from 'vs/editor/contrib/suggest/suggestController';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { inputBackground, inputBorder, inputForeground, inputPlaceholderForeground } from 'vs/platform/theme/common/colorRegistry';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { Component } from 'vs/workbench/common/component';
import { MenuPreventer } from 'vs/workbench/parts/codeEditor/browser/menuPreventer';
import { getSimpleEditorOptions } from 'vs/workbench/parts/codeEditor/browser/simpleEditorOptions';
import { Position } from 'vs/editor/common/core/position';
import { Range } from 'vs/editor/common/core/range';
import { ITextModel } from 'vs/editor/common/model';
import { IContextKey } from 'vs/platform/contextkey/common/contextkey';

interface SuggestResultsProvider {
	/**
	 * Provider function for suggestion results.
	 *
	 * @param query the full text of the input.
	 */
	provideResults: (query: string) => string[];

	/**
	 * Trigger characters for this input. Suggestions will appear when one of these is typed,
	 * or upon `ctrl+space` triggering at a word boundary.
	 *
	 * Defaults to the empty array.
	 */
	triggerCharacters?: string[];

	/**
	 * Defines the sorting function used when showing results.
	 *
	 * Defaults to the identity function.
	 */
	sortKey?: (result: string) => string;
}

interface SuggestEnabledInputOptions {
	/**
	 * The text to show when no input is present.
	 *
	 * Defaults to the empty string.
	 */
	placeholderText?: string;

	/**
	 * Context key tracking the focus state of this element
	 */
	focusContextKey?: IContextKey<boolean>;
}

export class SuggestEnabledInput extends Component {

	private _onShouldFocusResults = new Emitter<void>();
	readonly onShouldFocusResults: Event<void> = this._onShouldFocusResults.event;

	private _onEnter = new Emitter<void>();
	readonly onEnter: Event<void> = this._onEnter.event;

	private _onInputDidChange = new Emitter<string>();
	readonly onInputDidChange: Event<string> = this._onInputDidChange.event;

	private disposables: IDisposable[] = [];
	private inputWidget: CodeEditorWidget;
	private stylingContainer: HTMLDivElement;
	private placeholderText: HTMLDivElement;

	constructor(
		id: string,
		parent: HTMLElement,
		suggestionProvider: SuggestResultsProvider,
		ariaLabel: string,
		resourceHandle: string,
		options: SuggestEnabledInputOptions,
		@IThemeService themeService: IThemeService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IModelService modelService: IModelService,
	) {
		super(id, themeService);

		this.stylingContainer = append(parent, $('.suggest-input-container'));
		this.placeholderText = append(this.stylingContainer, $('.suggest-input-placeholder', null, options.placeholderText || ''));

		this.inputWidget = instantiationService.createInstance(CodeEditorWidget, this.stylingContainer,
			mixinHTMLInputStyleOptions(getSimpleEditorOptions(), ariaLabel),
			{
				contributions: [SuggestController, SnippetController2, ContextMenuController, MenuPreventer],
				isSimpleWidget: true,
			});

		let scopeHandle = uri.parse(resourceHandle);
		this.inputWidget.setModel(modelService.createModel('', null, scopeHandle, true));

		this.disposables.push(this.inputWidget.onDidPaste(() => this.setValue(this.getValue()))); // setter cleanses

		this.disposables.push((this.inputWidget.onDidFocusEditorText(() => {
			if (options.focusContextKey) { options.focusContextKey.set(true); }
			addClass(this.stylingContainer, 'synthetic-focus');
		})));
		this.disposables.push((this.inputWidget.onDidBlurEditorText(() => {
			if (options.focusContextKey) { options.focusContextKey.set(false); }
			removeClass(this.stylingContainer, 'synthetic-focus');
		})));

		const onKeyDownMonaco = chain(this.inputWidget.onKeyDown);
		onKeyDownMonaco.filter(e => e.keyCode === KeyCode.Enter).on(e => { e.preventDefault(); this._onEnter.fire(); }, this, this.disposables);
		onKeyDownMonaco.filter(e => e.keyCode === KeyCode.DownArrow && (isMacintosh ? e.metaKey : e.ctrlKey)).on(() => this._onShouldFocusResults.fire(), this, this.disposables);

		let preexistingContent = this.getValue();
		this.disposables.push(this.inputWidget.getModel().onDidChangeContent(() => {
			let content = this.getValue();
			this.placeholderText.style.visibility = content ? 'hidden' : 'visible';
			if (preexistingContent.trim() === content.trim()) { return; }
			this._onInputDidChange.fire();
			preexistingContent = content;
		}));

		let validatedSuggestProvider = {
			provideResults: suggestionProvider.provideResults,
			sortKey: suggestionProvider.sortKey || (a => a),
			triggerCharacters: suggestionProvider.triggerCharacters || []
		};

		this.disposables.push(modes.SuggestRegistry.register({ scheme: scopeHandle.scheme, pattern: '**/' + scopeHandle.path, hasAccessToAllModels: true }, {
			triggerCharacters: validatedSuggestProvider.triggerCharacters,
			provideCompletionItems: (model: ITextModel, position: Position, _context: modes.SuggestContext) => {
				let query = model.getValue();

				let wordStart = query.lastIndexOf(' ', position.column - 1) + 1;
				let alreadyTypedCount = position.column - wordStart - 1;

				// dont show suggestions if the user has typed something, but hasn't used the trigger character
				if (alreadyTypedCount > 0 && (validatedSuggestProvider.triggerCharacters).indexOf(query[wordStart]) === -1) { return { suggestions: [] }; }

				return {
					suggestions: suggestionProvider.provideResults(query).map(result => {
						return {
							label: result,
							insertText: result,
							overwriteBefore: alreadyTypedCount,
							sortText: validatedSuggestProvider.sortKey(result),
							type: <modes.SuggestionType>'keyword'
						};
					})
				};
			}
		}));
	}

	public setValue(val: string) {
		val = val.replace(/\s/g, ' ');
		this.inputWidget.setValue(val);
		this.inputWidget.setScrollTop(0);
		this.inputWidget.setPosition(new Position(1, val.length + 1));
	}

	public getValue(): string {
		return this.inputWidget.getValue();
	}


	public updateStyles(): void {
		super.updateStyles();

		this.stylingContainer.style.backgroundColor = this.getColor(inputBackground);
		this.stylingContainer.style.color = this.getColor(inputForeground);
		this.placeholderText.style.color = this.getColor(inputPlaceholderForeground);

		const inputBorderColor = this.getColor(inputBorder);
		this.stylingContainer.style.borderWidth = '1px';
		this.stylingContainer.style.borderStyle = 'solid';
		this.stylingContainer.style.borderColor = inputBorderColor || 'transparent';

		let cursor = this.stylingContainer.getElementsByClassName('cursor')[0] as HTMLDivElement;
		if (cursor) {
			cursor.style.backgroundColor = this.getColor(inputForeground);
		}
	}

	public focus(): void {
		this.inputWidget.focus();
	}

	public layout(dimension: Dimension): void {
		this.inputWidget.layout(dimension);
		this.placeholderText.style.width = `${dimension.width}px`;
	}

	public selectAll(): void {
		this.inputWidget.setSelection(new Range(1, 1, 1, this.getValue().length + 1));
	}

	dispose(): void {
		this.disposables = dispose(this.disposables);
		super.dispose();
	}
}


function mixinHTMLInputStyleOptions(config: IEditorOptions, ariaLabel?: string): IEditorOptions {
	config.fontSize = 13;
	config.lineHeight = 22;
	config.wordWrap = 'off';
	config.scrollbar.vertical = 'hidden';
	config.roundedSelection = false;
	config.ariaLabel = ariaLabel || '';
	config.renderIndentGuides = false;
	config.cursorWidth = 1;
	config.snippetSuggestions = 'none';
	config.suggest = { filterGraceful: false };
	config.fontFamily = ' -apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", "HelveticaNeue-Light", "Ubuntu", "Droid Sans", sans-serif';
	return config;
}
