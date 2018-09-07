/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from 'vs/base/browser/dom';
import { Separator } from 'vs/base/browser/ui/actionbar/actionbar';
import { ToolBar } from 'vs/base/browser/ui/toolbar/toolbar';
import { Action } from 'vs/base/common/actions';
import * as arrays from 'vs/base/common/arrays';
import { Delayer, ThrottledDelayer } from 'vs/base/common/async';
import { CancellationToken, CancellationTokenSource } from 'vs/base/common/cancellation';
import * as collections from 'vs/base/common/collections';
import { getErrorMessage, isPromiseCanceledError } from 'vs/base/common/errors';
import { URI } from 'vs/base/common/uri';
import { TPromise } from 'vs/base/common/winjs.base';
import { Tree } from 'vs/base/parts/tree/browser/treeImpl';
import { collapseAll, expandAll } from 'vs/base/parts/tree/browser/treeUtils';
import 'vs/css!./media/settingsEditor2';
import { localize } from 'vs/nls';
import { ConfigurationTarget, IConfigurationOverrides, IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IContextKey, IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { WorkbenchTree } from 'vs/platform/list/browser/listService';
import { ILogService } from 'vs/platform/log/common/log';
import { INotificationService } from 'vs/platform/notification/common/notification';
import { IStorageService, StorageScope } from 'vs/platform/storage/common/storage';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { badgeBackground, badgeForeground, contrastBorder, editorForeground } from 'vs/platform/theme/common/colorRegistry';
import { attachStylerCallback } from 'vs/platform/theme/common/styler';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { BaseEditor } from 'vs/workbench/browser/parts/editor/baseEditor';
import { EditorOptions, IEditor } from 'vs/workbench/common/editor';
import { ResourceEditorModel } from 'vs/workbench/common/editor/resourceEditorModel';
import { attachSuggestEnabledInputBoxStyler, SuggestEnabledInput } from 'vs/workbench/parts/codeEditor/browser/suggestEnabledInput';
import { PreferencesEditor } from 'vs/workbench/parts/preferences/browser/preferencesEditor';
import { SettingsTarget, SettingsTargetsWidget } from 'vs/workbench/parts/preferences/browser/preferencesWidgets';
import { commonlyUsedData, tocData } from 'vs/workbench/parts/preferences/browser/settingsLayout';
import { resolveExtensionsSettings, resolveSettingsTree, SettingsDataSource, SettingsRenderer, SettingsTree, SimplePagedDataSource, ISettingLinkClickEvent } from 'vs/workbench/parts/preferences/browser/settingsTree';
import { countSettingGroupChildrenWithPredicate, ISettingsEditorViewState, MODIFIED_SETTING_TAG, ONLINE_SERVICES_SETTING_TAG, parseQuery, SearchResultIdx, SearchResultModel, SettingsTreeGroupElement, SettingsTreeModel, SettingsTreeSettingElement } from 'vs/workbench/parts/preferences/browser/settingsTreeModels';
import { settingsTextInputBorder } from 'vs/workbench/parts/preferences/browser/settingsWidgets';
import { TOCRenderer, TOCTree, TOCTreeModel } from 'vs/workbench/parts/preferences/browser/tocTree';
import { CONTEXT_SETTINGS_EDITOR, CONTEXT_SETTINGS_SEARCH_FOCUS, CONTEXT_TOC_ROW_FOCUS, IPreferencesSearchService, ISearchProvider } from 'vs/workbench/parts/preferences/common/preferences';
import { IPreferencesService, ISearchResult, ISettingsEditorModel } from 'vs/workbench/services/preferences/common/preferences';
import { SettingsEditor2Input } from 'vs/workbench/services/preferences/common/preferencesEditorInput';
import { DefaultSettingsEditorModel } from 'vs/workbench/services/preferences/common/preferencesModels';

const $ = DOM.$;

export class SettingsEditor2 extends BaseEditor {

	public static readonly ID: string = 'workbench.editor.settings2';
	private static NUM_INSTANCES: number = 0;

	private static readonly SUGGESTIONS: string[] = [
		'@modified', '@tag:usesOnlineServices'
	];

	private defaultSettingsEditorModel: DefaultSettingsEditorModel;

	private rootElement: HTMLElement;
	private headerContainer: HTMLElement;
	private searchWidget: SuggestEnabledInput;
	private countElement: HTMLElement;
	private settingsTargetsWidget: SettingsTargetsWidget;
	private toolbar: ToolBar;

	private settingsTreeContainer: HTMLElement;
	private settingsTree: Tree;
	private settingsTreeRenderer: SettingsRenderer;
	private settingsTreeDataSource: SimplePagedDataSource;
	private tocTreeModel: TOCTreeModel;
	private settingsTreeModel: SettingsTreeModel;
	private noResultsMessage: HTMLElement;

	private tocTreeContainer: HTMLElement;
	private tocTree: WorkbenchTree;

	private delayedFilterLogging: Delayer<void>;
	private localSearchDelayer: Delayer<void>;
	private remoteSearchThrottle: ThrottledDelayer<void>;
	private searchInProgress: CancellationTokenSource;

	private delayRefreshOnLayout: Delayer<void>;
	private lastLayedoutWidth: number;

	private settingUpdateDelayer: Delayer<void>;
	private pendingSettingUpdate: { key: string, value: any };

	private viewState: ISettingsEditorViewState;
	private searchResultModel: SearchResultModel;

	private tocRowFocused: IContextKey<boolean>;
	private inSettingsEditorContextKey: IContextKey<boolean>;
	private searchFocusContextKey: IContextKey<boolean>;

	private scheduledRefreshes: Map<string, DOM.IFocusTracker>;

	/** Don't spam warnings */
	private hasWarnedMissingSettings: boolean;

	constructor(
		@ITelemetryService telemetryService: ITelemetryService,
		@IConfigurationService private configurationService: IConfigurationService,
		@IThemeService themeService: IThemeService,
		@IPreferencesService private preferencesService: IPreferencesService,
		@IInstantiationService private instantiationService: IInstantiationService,
		@IPreferencesSearchService private preferencesSearchService: IPreferencesSearchService,
		@ILogService private logService: ILogService,
		@IEnvironmentService private environmentService: IEnvironmentService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IContextMenuService private contextMenuService: IContextMenuService,
		@IStorageService private storageService: IStorageService,
		@INotificationService private notificationService: INotificationService
	) {
		super(SettingsEditor2.ID, telemetryService, themeService);
		this.delayedFilterLogging = new Delayer<void>(1000);
		this.localSearchDelayer = new Delayer(300);
		this.remoteSearchThrottle = new ThrottledDelayer(200);
		this.viewState = { settingsTarget: ConfigurationTarget.USER };
		this.delayRefreshOnLayout = new Delayer(100);

		this.settingUpdateDelayer = new Delayer<void>(200);

		this.inSettingsEditorContextKey = CONTEXT_SETTINGS_EDITOR.bindTo(contextKeyService);
		this.searchFocusContextKey = CONTEXT_SETTINGS_SEARCH_FOCUS.bindTo(contextKeyService);
		this.tocRowFocused = CONTEXT_TOC_ROW_FOCUS.bindTo(contextKeyService);

		this.scheduledRefreshes = new Map<string, DOM.IFocusTracker>();

		this._register(configurationService.onDidChangeConfiguration(e => {
			this.onConfigUpdate(e.affectedKeys);
		}));
	}

	private get currentSettingsModel() {
		return this.searchResultModel || this.settingsTreeModel;
	}

	createEditor(parent: HTMLElement): void {
		parent.setAttribute('tabindex', '-1');
		this.rootElement = DOM.append(parent, $('.settings-editor'));

		this.createHeader(this.rootElement);
		this.createBody(this.rootElement);
		this.updateStyles();
	}

	setInput(input: SettingsEditor2Input, options: EditorOptions, token: CancellationToken): Thenable<void> {
		this.inSettingsEditorContextKey.set(true);
		return super.setInput(input, options, token)
			.then(() => new Promise(process.nextTick)) // Force setInput to be async
			.then(() => {
				const target = this.getSettingsTarget(input);
				this.settingsTargetsWidget.settingsTarget = target;
				this.viewState.settingsTarget = target;

				return this.render(token);
			})
			.then(() => {
				// Init TOC selection
				this.updateTreeScrollSync();

				this.onSearchInputChanged();
			});
	}

	private getSettingsTarget(input: SettingsEditor2Input): SettingsTarget {
		if (input.folderUri) {
			return input.folderUri;
		}

		if (input.configurationTarget === ConfigurationTarget.USER || input.configurationTarget === ConfigurationTarget.WORKSPACE) {
			return input.configurationTarget;
		}

		return ConfigurationTarget.USER;
	}

	clearInput(): void {
		this.inSettingsEditorContextKey.set(false);
		super.clearInput();
	}

	layout(dimension: DOM.Dimension): void {
		this.layoutTrees(dimension);

		let innerWidth = dimension.width - 24 * 2; // 24px padding on left and right
		let monacoWidth = (innerWidth > 1000 ? 1000 : innerWidth) - 10;
		this.searchWidget.layout({ height: 20, width: monacoWidth });

		DOM.toggleClass(this.rootElement, 'narrow', dimension.width < 600);

		// #56185
		if (dimension.width !== this.lastLayedoutWidth) {
			this.lastLayedoutWidth = dimension.width;
			this.delayRefreshOnLayout.trigger(() => this.renderTree(undefined, true));
		}
	}

	focus(): void {
		this.focusSearch();
	}

	focusSettings(): void {
		const firstFocusable = this.settingsTree.getHTMLElement().querySelector(SettingsRenderer.CONTROL_SELECTOR);
		if (firstFocusable) {
			(<HTMLElement>firstFocusable).focus();
		}
	}

	showContextMenu(): void {
		const settingDOMElement = this.settingsTreeRenderer.getSettingDOMElementForDOMElement(this.getActiveElementInSettingsTree());
		if (!settingDOMElement) {
			return;
		}

		const focusedKey = this.settingsTreeRenderer.getKeyForDOMElementInSetting(settingDOMElement);
		if (!focusedKey) {
			return;
		}

		const elements = this.currentSettingsModel.getElementsByName(focusedKey);
		if (elements && elements[0]) {
			this.settingsTreeRenderer.showContextMenu(elements[0], settingDOMElement);
		}
	}

	focusSearch(filter?: string): void {
		if (filter && this.searchWidget) {
			this.searchWidget.setValue(filter);
		}

		this.searchWidget.focus();
	}

	clearSearchResults(): void {
		this.searchWidget.setValue('');
	}

	private createHeader(parent: HTMLElement): void {
		this.headerContainer = DOM.append(parent, $('.settings-header'));

		const searchContainer = DOM.append(this.headerContainer, $('.search-container'));

		let searchBoxLabel = localize('SearchSettings.AriaLabel', "Search settings");
		this.searchWidget = this._register(this.instantiationService.createInstance(SuggestEnabledInput, `${SettingsEditor2.ID}.searchbox`, searchContainer, {
			triggerCharacters: ['@'],
			provideResults: (query: string) => {
				return SettingsEditor2.SUGGESTIONS.filter(tag => query.indexOf(tag) === -1).map(tag => tag + ' ');
			}
		}, searchBoxLabel, 'settingseditor:searchinput' + SettingsEditor2.NUM_INSTANCES++, {
				placeholderText: searchBoxLabel,
				focusContextKey: this.searchFocusContextKey,
				// TODO: Aria-live
			}));

		this._register(attachSuggestEnabledInputBoxStyler(this.searchWidget, this.themeService, {
			inputBorder: settingsTextInputBorder
		}));

		this.countElement = DOM.append(searchContainer, DOM.$('.settings-count-widget'));
		this._register(attachStylerCallback(this.themeService, { badgeBackground, contrastBorder, badgeForeground }, colors => {
			const background = colors.badgeBackground ? colors.badgeBackground.toString() : null;
			const border = colors.contrastBorder ? colors.contrastBorder.toString() : null;

			this.countElement.style.backgroundColor = background;
			this.countElement.style.color = colors.badgeForeground.toString();

			this.countElement.style.borderWidth = border ? '1px' : null;
			this.countElement.style.borderStyle = border ? 'solid' : null;
			this.countElement.style.borderColor = border;
		}));

		this._register(this.searchWidget.onInputDidChange(() => this.onSearchInputChanged()));

		const headerControlsContainer = DOM.append(this.headerContainer, $('.settings-header-controls'));
		const targetWidgetContainer = DOM.append(headerControlsContainer, $('.settings-target-container'));
		this.settingsTargetsWidget = this._register(this.instantiationService.createInstance(SettingsTargetsWidget, targetWidgetContainer));
		this.settingsTargetsWidget.settingsTarget = ConfigurationTarget.USER;
		this.settingsTargetsWidget.onDidTargetChange(target => {
			this.viewState.settingsTarget = target;
			if (target === ConfigurationTarget.USER) {
				this.preferencesService.openGlobalSettings();
			} else if (target === ConfigurationTarget.WORKSPACE) {
				this.preferencesService.switchSettings(ConfigurationTarget.WORKSPACE, this.preferencesService.workspaceSettingsResource);
			} else if (target instanceof URI) {
				this.preferencesService.switchSettings(ConfigurationTarget.WORKSPACE_FOLDER, target);
			}
		});

		this.createHeaderControls(headerControlsContainer);
	}

	private createHeaderControls(parent: HTMLElement): void {
		const headerControlsContainerRight = DOM.append(parent, $('.settings-header-controls-right'));

		this.toolbar = this._register(new ToolBar(headerControlsContainerRight, this.contextMenuService, {
			ariaLabel: localize('settingsToolbarLabel', "Settings Editor Actions"),
			actionRunner: this.actionRunner
		}));

		const actions: Action[] = [
			this.instantiationService.createInstance(FilterByTagAction,
				localize('filterModifiedLabel', "Show modified settings"),
				MODIFIED_SETTING_TAG,
				this)
		];
		if (this.environmentService.appQuality !== 'stable') {
			actions.push(
				this.instantiationService.createInstance(
					FilterByTagAction,
					localize('filterOnlineServicesLabel', "Show settings for online services"),
					ONLINE_SERVICES_SETTING_TAG,
					this));
			actions.push(new Separator());
		}
		actions.push(new Action('settings.openSettingsJson', localize('openSettingsJsonLabel', "Open settings.json"), undefined, undefined, () => {
			return this.openSettingsFile().then(editor => {
				const currentQuery = parseQuery(this.searchWidget.getValue());
				if (editor instanceof PreferencesEditor && currentQuery) {
					editor.focusSearch(currentQuery.query);
				}
			});
		}));

		this.toolbar.setActions([], actions)();
		this.toolbar.context = <ISettingsToolbarContext>{ target: this.settingsTargetsWidget.settingsTarget };
	}

	private onDidClickSetting(evt: ISettingLinkClickEvent, recursed?: boolean): void {
		const elements = this.currentSettingsModel.getElementsByName(evt.targetKey);
		if (elements && elements[0]) {
			let sourceTop = this.settingsTree.getRelativeTop(evt.source);
			if (sourceTop < 0) {
				// e.g. clicked a searched element, now the search has been cleared
				sourceTop = .5;
			}

			this.settingsTree.reveal(elements[0], sourceTop);

			const domElements = this.settingsTreeRenderer.getDOMElementsForSettingKey(this.settingsTree.getHTMLElement(), evt.targetKey);
			if (domElements && domElements[0]) {
				const control = domElements[0].querySelector(SettingsRenderer.CONTROL_SELECTOR);
				if (control) {
					(<HTMLElement>control).focus();
				}
			}
		} else if (!recursed) {
			const p = this.triggerSearch('');
			p.then(() => {
				this.searchWidget.setValue('');
				this.onDidClickSetting(evt, true);
			});
		}
	}

	private openSettingsFile(): TPromise<IEditor> {
		const currentSettingsTarget = this.settingsTargetsWidget.settingsTarget;

		if (currentSettingsTarget === ConfigurationTarget.USER) {
			return this.preferencesService.openGlobalSettings(true);
		} else if (currentSettingsTarget === ConfigurationTarget.WORKSPACE) {
			return this.preferencesService.openWorkspaceSettings(true);
		} else {
			return this.preferencesService.openFolderSettings(currentSettingsTarget, true);
		}
	}

	private createBody(parent: HTMLElement): void {
		const bodyContainer = DOM.append(parent, $('.settings-body'));

		this.noResultsMessage = DOM.append(bodyContainer, $('.no-results'));
		this.noResultsMessage.innerText = localize('noResults', "No Settings Found");
		this._register(attachStylerCallback(this.themeService, { editorForeground }, colors => {
			this.noResultsMessage.style.color = colors.editorForeground ? colors.editorForeground.toString() : null;
		}));

		this.createFocusSink(
			bodyContainer,
			e => {
				if (DOM.findParentWithClass(e.relatedTarget, 'settings-editor-tree')) {
					if (this.settingsTree.getScrollPosition() > 0) {
						const firstElement = this.settingsTree.getFirstVisibleElement();
						this.settingsTree.reveal(firstElement, 0.1);
						return true;
					}
				} else {
					const firstControl = this.settingsTree.getHTMLElement().querySelector(SettingsRenderer.CONTROL_SELECTOR);
					if (firstControl) {
						(<HTMLElement>firstControl).focus();
					}
				}

				return false;
			},
			'settings list focus helper');

		this.createSettingsTree(bodyContainer);

		this.createFocusSink(
			bodyContainer,
			e => {
				if (DOM.findParentWithClass(e.relatedTarget, 'settings-editor-tree')) {
					if (this.settingsTree.getScrollPosition() < 1) {
						const lastElement = this.settingsTree.getLastVisibleElement();
						this.settingsTree.reveal(lastElement, 0.9);
						return true;
					}
				}

				return false;
			},
			'settings list focus helper'
		);

		this.createTOC(bodyContainer);
	}

	private createFocusSink(container: HTMLElement, callback: (e: any) => boolean, label: string): HTMLElement {
		const listFocusSink = DOM.append(container, $('.settings-tree-focus-sink'));
		listFocusSink.setAttribute('aria-label', label);
		listFocusSink.tabIndex = 0;
		this._register(DOM.addDisposableListener(listFocusSink, 'focus', (e: any) => {
			if (e.relatedTarget && callback(e)) {
				e.relatedTarget.focus();
			}
		}));

		return listFocusSink;
	}

	private createTOC(parent: HTMLElement): void {
		this.tocTreeModel = new TOCTreeModel(this.viewState);
		this.tocTreeContainer = DOM.append(parent, $('.settings-toc-container'));

		const tocRenderer = this.instantiationService.createInstance(TOCRenderer);

		this.tocTree = this._register(this.instantiationService.createInstance(TOCTree, this.tocTreeContainer,
			this.viewState,
			{
				renderer: tocRenderer
			}));

		this._register(this.tocTree.onDidChangeFocus(e => {
			const element: SettingsTreeGroupElement = e.focus;
			if (this.searchResultModel) {
				this.viewState.filterToCategory = element;
				this.renderTree();
			}

			if (element && (!e.payload || !e.payload.fromScroll)) {
				let refreshP = TPromise.wrap(null);
				if (this.settingsTreeDataSource.pageTo(element.index, true)) {
					refreshP = this.renderTree();
				}

				refreshP.then(() => this.settingsTree.reveal(element, 0));
			}
		}));

		this._register(this.tocTree.onDidFocus(() => {
			this.tocRowFocused.set(true);
		}));

		this._register(this.tocTree.onDidBlur(() => {
			this.tocRowFocused.set(false);
		}));
	}

	private createSettingsTree(parent: HTMLElement): void {
		this.settingsTreeContainer = DOM.append(parent, $('.settings-tree-container'));

		this.settingsTreeRenderer = this.instantiationService.createInstance(SettingsRenderer, this.settingsTreeContainer);
		this._register(this.settingsTreeRenderer.onDidChangeSetting(e => this.onDidChangeSetting(e.key, e.value)));
		this._register(this.settingsTreeRenderer.onDidOpenSettings(settingKey => {
			this.openSettingsFile().then(editor => {
				if (editor instanceof PreferencesEditor && settingKey) {
					editor.focusSearch(settingKey);
				}
			});
		}));
		this._register(this.settingsTreeRenderer.onDidClickSettingLink(settingName => this.onDidClickSetting(settingName)));
		this._register(this.settingsTreeRenderer.onDidFocusSetting(element => {
			this.settingsTree.reveal(element);
		}));

		this.settingsTreeDataSource = this.instantiationService.createInstance(SimplePagedDataSource,
			this.instantiationService.createInstance(SettingsDataSource, this.viewState));

		this.settingsTree = this._register(this.instantiationService.createInstance(SettingsTree,
			this.settingsTreeContainer,
			this.viewState,
			{
				renderer: this.settingsTreeRenderer,
				dataSource: this.settingsTreeDataSource
			}));
		this.settingsTree.getHTMLElement().attributes.removeNamedItem('tabindex');

		// Have to redefine role of the tree widget to form for input elements
		// TODO:CDL make this an option for tree
		this.settingsTree.getHTMLElement().setAttribute('role', 'form');

		this._register(this.settingsTree.onDidScroll(() => {
			this.updateTreeScrollSync();
		}));
	}

	public notifyNoSaveNeeded(force: boolean = true) {
		if (force || !this.storageService.getBoolean('hasNotifiedOfSettingsAutosave', StorageScope.GLOBAL, false)) {
			this.storageService.store('hasNotifiedOfSettingsAutosave', true, StorageScope.GLOBAL);
			this.notificationService.info(localize('settingsNoSaveNeeded', "Your changes are automatically saved as you edit."));
		}
	}

	private onDidChangeSetting(key: string, value: any): void {
		this.notifyNoSaveNeeded(false);

		if (this.pendingSettingUpdate && this.pendingSettingUpdate.key !== key) {
			this.updateChangedSetting(key, value);
		}

		this.pendingSettingUpdate = { key, value };
		this.settingUpdateDelayer.trigger(() => this.updateChangedSetting(key, value));
	}

	private updateTreeScrollSync(): void {
		this.settingsTreeRenderer.cancelSuggesters();
		if (this.searchResultModel) {
			return;
		}

		if (!this.tocTree.getInput()) {
			return;
		}

		this.updateTreePagingByScroll();

		const elementToSync = this.settingsTree.getFirstVisibleElement();
		const element = elementToSync instanceof SettingsTreeSettingElement ? elementToSync.parent :
			elementToSync instanceof SettingsTreeGroupElement ? elementToSync :
				null;

		if (element && this.tocTree.getSelection()[0] !== element) {
			this.tocTree.reveal(element);
			const elementTop = this.tocTree.getRelativeTop(element);
			collapseAll(this.tocTree, element);
			if (elementTop < 0 || elementTop > 1) {
				this.tocTree.reveal(element);
			} else {
				this.tocTree.reveal(element, elementTop);
			}

			this.tocTree.expand(element);

			this.tocTree.setSelection([element]);
			this.tocTree.setFocus(element, { fromScroll: true });
		}
	}

	private updateTreePagingByScroll(): void {
		const lastVisibleElement = this.settingsTree.getLastVisibleElement();
		if (lastVisibleElement && this.settingsTreeDataSource.pageTo(lastVisibleElement.index)) {
			this.renderTree();
		}
	}

	private updateChangedSetting(key: string, value: any): TPromise<void> {
		// ConfigurationService displays the error if this fails.
		// Force a render afterwards because onDidConfigurationUpdate doesn't fire if the update doesn't result in an effective setting value change
		const settingsTarget = this.settingsTargetsWidget.settingsTarget;
		const resource = URI.isUri(settingsTarget) ? settingsTarget : undefined;
		const configurationTarget = <ConfigurationTarget>(resource ? ConfigurationTarget.WORKSPACE_FOLDER : settingsTarget);
		const overrides: IConfigurationOverrides = { resource };

		const isManualReset = value === undefined;

		// If the user is changing the value back to the default, do a 'reset' instead
		const inspected = this.configurationService.inspect(key, overrides);
		if (inspected.default === value) {
			value = undefined;
		}

		return this.configurationService.updateValue(key, value, overrides, configurationTarget)
			.then(() => this.renderTree(key, isManualReset))
			.then(() => {
				const reportModifiedProps = {
					key,
					query: this.searchWidget.getValue(),
					searchResults: this.searchResultModel && this.searchResultModel.getUniqueResults(),
					rawResults: this.searchResultModel && this.searchResultModel.getRawResults(),
					showConfiguredOnly: this.viewState.tagFilters && this.viewState.tagFilters.has(MODIFIED_SETTING_TAG),
					isReset: typeof value === 'undefined',
					settingsTarget: this.settingsTargetsWidget.settingsTarget as SettingsTarget
				};

				return this.reportModifiedSetting(reportModifiedProps);
			});
	}

	private reportModifiedSetting(props: { key: string, query: string, searchResults: ISearchResult[], rawResults: ISearchResult[], showConfiguredOnly: boolean, isReset: boolean, settingsTarget: SettingsTarget }): void {
		this.pendingSettingUpdate = null;

		const remoteResult = props.searchResults && props.searchResults[SearchResultIdx.Remote];
		const localResult = props.searchResults && props.searchResults[SearchResultIdx.Local];

		let groupId = undefined;
		let nlpIndex = undefined;
		let displayIndex = undefined;
		if (props.searchResults) {
			const localIndex = arrays.firstIndex(localResult.filterMatches, m => m.setting.key === props.key);
			groupId = localIndex >= 0 ?
				'local' :
				'remote';

			displayIndex = localIndex >= 0 ?
				localIndex :
				remoteResult && (arrays.firstIndex(remoteResult.filterMatches, m => m.setting.key === props.key) + localResult.filterMatches.length);

			if (this.searchResultModel) {
				const rawResults = this.searchResultModel.getRawResults();
				if (rawResults[SearchResultIdx.Remote]) {
					const _nlpIndex = arrays.firstIndex(rawResults[SearchResultIdx.Remote].filterMatches, m => m.setting.key === props.key);
					nlpIndex = _nlpIndex >= 0 ? _nlpIndex : undefined;
				}
			}
		}

		const reportedTarget = props.settingsTarget === ConfigurationTarget.USER ? 'user' :
			props.settingsTarget === ConfigurationTarget.WORKSPACE ? 'workspace' :
				'folder';

		const data = {
			key: props.key,
			query: props.query,
			groupId,
			nlpIndex,
			displayIndex,
			showConfiguredOnly: props.showConfiguredOnly,
			isReset: props.isReset,
			target: reportedTarget
		};

		/* __GDPR__
			"settingsEditor.settingModified" : {
				"key" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
				"query" : { "classification": "CustomerContent", "purpose": "FeatureInsight" },
				"groupId" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
				"nlpIndex" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
				"displayIndex" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
				"showConfiguredOnly" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
				"isReset" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
				"target" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
			}
		*/
		this.telemetryService.publicLog('settingsEditor.settingModified', data);

		const data2 = {
			key: props.key,
			groupId,
			nlpIndex,
			displayIndex,
			showConfiguredOnly: props.showConfiguredOnly,
			isReset: props.isReset,
			target: reportedTarget
		};

		/* __GDPR__
			"settingsEditor.settingModified2" : {
				"key" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
				"groupId" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
				"nlpIndex" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
				"displayIndex" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
				"showConfiguredOnly" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
				"isReset" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
				"target" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
			}
		*/
		this.telemetryService.publicLog('settingsEditor.settingModified2', data2);
	}

	private render(token: CancellationToken): TPromise<any> {
		if (this.input) {
			return this.input.resolve()
				.then(model => {
					if (token.isCancellationRequested) {
						return void 0;
					}

					return this.preferencesService.createPreferencesEditorModel((<ResourceEditorModel>model).textEditorModel.uri);
				}).then((defaultSettingsEditorModel: DefaultSettingsEditorModel) => {
					this._register(defaultSettingsEditorModel.onDidChangeGroups(() => this.onConfigUpdate()));
					this.defaultSettingsEditorModel = defaultSettingsEditorModel;
					return this.onConfigUpdate();
				});
		}
		return TPromise.as(null);
	}

	private onSearchModeToggled(): void {
		DOM.removeClass(this.rootElement, 'search-mode');
		if (this.configurationService.getValue('workbench.settings.settingsSearchTocBehavior') === 'hide') {
			DOM.toggleClass(this.rootElement, 'search-mode', !!this.searchResultModel);
		}

		if (this.searchResultModel) {
			this.settingsTreeDataSource.pageTo(Number.MAX_VALUE);
		} else {
			this.settingsTreeDataSource.reset();
		}
	}

	private scheduleRefresh(element: HTMLElement, key = ''): void {
		if (key && this.scheduledRefreshes.has(key)) {
			return;
		}

		if (!key) {
			this.scheduledRefreshes.forEach(r => r.dispose());
			this.scheduledRefreshes.clear();
		}

		const scheduledRefreshTracker = DOM.trackFocus(element);
		this.scheduledRefreshes.set(key, scheduledRefreshTracker);
		scheduledRefreshTracker.onDidBlur(() => {
			scheduledRefreshTracker.dispose();
			this.scheduledRefreshes.delete(key);
			this.onConfigUpdate([key]);
		});
	}

	private onConfigUpdate(keys?: string[]): TPromise<void> {
		if (keys) {
			return this.updateElementsByKey(keys);
		}

		const groups = this.defaultSettingsEditorModel.settingsGroups.slice(1); // Without commonlyUsed
		const dividedGroups = collections.groupBy(groups, g => g.contributedByExtension ? 'extension' : 'core');
		const settingsResult = resolveSettingsTree(tocData, dividedGroups.core);
		const resolvedSettingsRoot = settingsResult.tree;

		// Warn for settings not included in layout
		if (settingsResult.leftoverSettings.size && !this.hasWarnedMissingSettings) {
			let settingKeyList = [];
			settingsResult.leftoverSettings.forEach(s => {
				settingKeyList.push(s.key);
			});

			this.logService.warn(`SettingsEditor2: Settings not included in settingsLayout.ts: ${settingKeyList.join(', ')}`);
			this.hasWarnedMissingSettings = true;
		}

		const commonlyUsed = resolveSettingsTree(commonlyUsedData, dividedGroups.core);
		resolvedSettingsRoot.children.unshift(commonlyUsed.tree);

		resolvedSettingsRoot.children.push(resolveExtensionsSettings(dividedGroups.extension || []));

		if (this.searchResultModel) {
			this.searchResultModel.updateChildren();
		}

		if (this.settingsTreeModel) {
			this.settingsTreeModel.update(resolvedSettingsRoot);

			return this.renderTree();
		} else {
			this.settingsTreeModel = this.instantiationService.createInstance(SettingsTreeModel, this.viewState);
			this.settingsTreeModel.update(resolvedSettingsRoot);
			this.settingsTree.setInput(this.settingsTreeModel.root);

			this.tocTreeModel.settingsTreeRoot = this.settingsTreeModel.root as SettingsTreeGroupElement;
			if (this.tocTree.getInput()) {
				this.tocTree.refresh();
			} else {
				this.tocTree.setInput(this.tocTreeModel);
			}
		}

		return TPromise.wrap(null);
	}

	private updateElementsByKey(keys: string[]): TPromise<void> {
		if (keys.length) {
			if (this.searchResultModel) {
				keys.forEach(key => this.searchResultModel.updateElementsByName(key));
			}

			if (this.settingsTreeModel) {
				keys.forEach(key => this.settingsTreeModel.updateElementsByName(key));
			}

			return TPromise.join(
				keys.map(key => this.renderTree(key)))
				.then(() => { });
		} else {
			return this.renderTree();
		}
	}

	private getActiveElementInSettingsTree(): HTMLElement | null {
		return (document.activeElement && DOM.isAncestor(document.activeElement, this.settingsTree.getHTMLElement())) ?
			<HTMLElement>document.activeElement :
			null;
	}

	private renderTree(key?: string, force = false): TPromise<void> {
		if (!force && key && this.scheduledRefreshes.has(key)) {
			this.updateModifiedLabelForKey(key);
			return TPromise.wrap(null);
		}

		// If a setting control is currently focused, schedule a refresh for later
		const focusedSetting = this.settingsTreeRenderer.getSettingDOMElementForDOMElement(this.getActiveElementInSettingsTree());
		if (focusedSetting && !force) {
			// If a single setting is being refreshed, it's ok to refresh now if that is not the focused setting
			if (key) {
				const focusedKey = focusedSetting.getAttribute(SettingsRenderer.SETTING_KEY_ATTR);
				if (focusedKey === key &&
					!DOM.hasClass(focusedSetting, 'setting-item-exclude')) { // update `exclude`s live, as they have a separate "submit edit" step built in before this

					this.updateModifiedLabelForKey(key);
					this.scheduleRefresh(focusedSetting, key);
					return TPromise.wrap(null);
				}
			} else {
				this.scheduleRefresh(focusedSetting);
				return TPromise.wrap(null);
			}
		}

		this.renderResultCountMessages();

		let refreshP: TPromise<any>;
		if (key) {
			const elements = this.currentSettingsModel.getElementsByName(key);
			if (elements && elements.length) {
				// TODO https://github.com/Microsoft/vscode/issues/57360
				// refreshP = TPromise.join(elements.map(e => this.settingsTree.refresh(e)));
				refreshP = this.settingsTree.refresh();
			} else {
				// Refresh requested for a key that we don't know about
				return TPromise.wrap(null);
			}
		} else {
			refreshP = this.settingsTree.refresh();
		}

		return refreshP.then(() => {
			this.tocTreeModel.update();
			return this.tocTree.refresh();
		}).then(() => { });
	}

	private updateModifiedLabelForKey(key: string): void {
		const dataElements = this.currentSettingsModel.getElementsByName(key);
		const isModified = dataElements && dataElements[0] && dataElements[0].isConfigured; // all elements are either configured or not
		const elements = this.settingsTreeRenderer.getDOMElementsForSettingKey(this.settingsTree.getHTMLElement(), key);
		if (elements && elements[0]) {
			DOM.toggleClass(elements[0], 'is-configured', isModified);
		}
	}

	private onSearchInputChanged(): void {
		const query = this.searchWidget.getValue().trim();
		this.delayedFilterLogging.cancel();
		this.triggerSearch(query.replace(/›/g, ' ')).then(() => {
			if (query && this.searchResultModel) {
				this.delayedFilterLogging.trigger(() => this.reportFilteringUsed(query, this.searchResultModel.getUniqueResults()));
			}
		});
	}

	private parseSettingFromJSON(query: string): string {
		const match = query.match(/"([a-zA-Z.]+)": /);
		return match && match[1];
	}

	private triggerSearch(query: string): TPromise<void> {
		this.viewState.tagFilters = new Set<string>();
		if (query) {
			const parsedQuery = parseQuery(query);
			query = parsedQuery.query;
			parsedQuery.tags.forEach(tag => this.viewState.tagFilters.add(tag));
		}

		if (query && query !== '@') {
			query = this.parseSettingFromJSON(query) || query;
			return this.triggerFilterPreferences(query);
		} else {
			if (this.viewState.tagFilters && this.viewState.tagFilters.size) {
				this.searchResultModel = this.createFilterModel();
			} else {
				this.searchResultModel = null;
			}

			this.localSearchDelayer.cancel();
			this.remoteSearchThrottle.cancel();
			if (this.searchInProgress) {
				this.searchInProgress.cancel();
				this.searchInProgress.dispose();
				this.searchInProgress = null;
			}

			this.viewState.filterToCategory = null;
			this.tocTreeModel.currentSearchModel = this.searchResultModel;
			this.tocTree.refresh();
			this.onSearchModeToggled();

			if (this.searchResultModel) {
				// Added a filter model
				this.tocTree.setSelection([]);
				this.tocTree.setFocus(null);
				expandAll(this.tocTree);
				return this.settingsTree.setInput(this.searchResultModel.root).then(() => this.renderResultCountMessages());
			} else {
				// Leaving search mode
				collapseAll(this.tocTree);
				return this.settingsTree.setInput(this.settingsTreeModel.root).then(() => this.renderResultCountMessages());
			}
		}
	}

	/**
	 * Return a fake SearchResultModel which can hold a flat list of all settings, to be filtered (@modified etc)
	 */
	private createFilterModel(): SearchResultModel {
		const filterModel = this.instantiationService.createInstance(SearchResultModel, this.viewState);

		const fullResult: ISearchResult = {
			filterMatches: []
		};
		for (let g of this.defaultSettingsEditorModel.settingsGroups.slice(1)) {
			for (let sect of g.sections) {
				for (let setting of sect.settings) {
					fullResult.filterMatches.push({ setting, matches: [], score: 0 });
				}
			}
		}

		filterModel.setResult(0, fullResult);

		return filterModel;
	}

	private reportFilteringUsed(query: string, results: ISearchResult[]): void {
		const nlpResult = results[SearchResultIdx.Remote];
		const nlpMetadata = nlpResult && nlpResult.metadata;

		const durations = {};
		durations['nlpResult'] = nlpMetadata && nlpMetadata.duration;

		// Count unique results
		const counts = {};
		const filterResult = results[SearchResultIdx.Local];
		if (filterResult) {
			counts['filterResult'] = filterResult.filterMatches.length;
		}

		if (nlpResult) {
			counts['nlpResult'] = nlpResult.filterMatches.length;
		}

		const requestCount = nlpMetadata && nlpMetadata.requestCount;

		const data = {
			query,
			durations,
			counts,
			requestCount
		};

		/* __GDPR__
			"settingsEditor.filter" : {
				"query": { "classification": "CustomerContent", "purpose": "FeatureInsight" },
				"durations.nlpResult" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
				"counts.nlpResult" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
				"counts.filterResult" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
				"requestCount" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true }
			}
		*/
		this.telemetryService.publicLog('settingsEditor.filter', data);

		const data2 = {
			durations,
			counts,
			requestCount
		};

		/* __GDPR__
			"settingsEditor.filter2" : {
				"durations.nlpResult" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
				"counts.nlpResult" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
				"counts.filterResult" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true },
				"requestCount" : { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true }
			}
		*/
		this.telemetryService.publicLog('settingsEditor.filter2', data2);
	}

	private triggerFilterPreferences(query: string): TPromise<void> {
		if (this.searchInProgress) {
			this.searchInProgress.cancel();
			this.searchInProgress = null;
		}

		// Trigger the local search. If it didn't find an exact match, trigger the remote search.
		const searchInProgress = this.searchInProgress = new CancellationTokenSource();
		return this.localSearchDelayer.trigger(() => {
			if (searchInProgress && !searchInProgress.token.isCancellationRequested) {
				return this.localFilterPreferences(query).then(result => {
					if (!result.exactMatch) {
						this.remoteSearchThrottle.trigger(() => {
							return searchInProgress && !searchInProgress.token.isCancellationRequested ?
								this.remoteSearchPreferences(query, this.searchInProgress.token) :
								TPromise.wrap(null);
						});
					}
				}).then(() => this.renderResultCountMessages());
			} else {
				return TPromise.wrap(null);
			}
		});
	}

	private localFilterPreferences(query: string, token?: CancellationToken): TPromise<ISearchResult> {
		const localSearchProvider = this.preferencesSearchService.getLocalSearchProvider(query);
		return this.filterOrSearchPreferences(query, SearchResultIdx.Local, localSearchProvider, token);
	}

	private remoteSearchPreferences(query: string, token?: CancellationToken): TPromise<void> {
		const remoteSearchProvider = this.preferencesSearchService.getRemoteSearchProvider(query);
		const newExtSearchProvider = this.preferencesSearchService.getRemoteSearchProvider(query, true);

		return TPromise.join([
			this.filterOrSearchPreferences(query, SearchResultIdx.Remote, remoteSearchProvider, token),
			this.filterOrSearchPreferences(query, SearchResultIdx.NewExtensions, newExtSearchProvider, token)
		]).then(() => { });
	}

	private filterOrSearchPreferences(query: string, type: SearchResultIdx, searchProvider: ISearchProvider, token?: CancellationToken): TPromise<ISearchResult> {
		return this._filterOrSearchPreferencesModel(query, this.defaultSettingsEditorModel, searchProvider, token).then(result => {
			if (token && token.isCancellationRequested) {
				// Handle cancellation like this because cancellation is lost inside the search provider due to async/await
				return null;
			}

			if (!this.searchResultModel) {
				this.searchResultModel = this.instantiationService.createInstance(SearchResultModel, this.viewState);
				this.searchResultModel.setResult(type, result);
				this.tocTreeModel.currentSearchModel = this.searchResultModel;
				this.onSearchModeToggled();
				this.settingsTree.setInput(this.searchResultModel.root);
			} else {
				this.searchResultModel.setResult(type, result);
				this.tocTreeModel.update();
			}

			this.tocTree.setSelection([]);
			this.tocTree.setFocus(null);
			expandAll(this.tocTree);

			return this.renderTree().then(() => result);
		});
	}

	private renderResultCountMessages() {
		let count = countSettingGroupChildrenWithPredicate(this.settingsTree.getInput() as SettingsTreeGroupElement, element => element.matchesAllTags(this.viewState.tagFilters));
		switch (count) {
			case 0: this.countElement.innerText = localize('noResults', "No Settings Found"); break;
			case 1: this.countElement.innerText = localize('oneResult', "1 Setting Found"); break;
			default: this.countElement.innerText = localize('moreThanOneResult', "{0} Settings Found", count);
		}

		this.countElement.style.display = 'block';
		this.noResultsMessage.style.display = count === 0 ? 'block' : 'none';
	}

	private _filterOrSearchPreferencesModel(filter: string, model: ISettingsEditorModel, provider: ISearchProvider, token?: CancellationToken): TPromise<ISearchResult> {
		const searchP = provider ? provider.searchModel(model, token) : TPromise.wrap(null);
		return searchP
			.then<ISearchResult>(null, err => {
				if (isPromiseCanceledError(err)) {
					return TPromise.wrapError(err);
				} else {
					/* __GDPR__
						"settingsEditor.searchError" : {
							"message": { "classification": "CallstackOrException", "purpose": "FeatureInsight" },
							"filter": { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
						}
					*/
					const message = getErrorMessage(err).trim();
					if (message && message !== 'Error') {
						// "Error" = any generic network error
						this.telemetryService.publicLog('settingsEditor.searchError', { message, filter });
						this.logService.info('Setting search error: ' + message);
					}
					return null;
				}
			});
	}

	private layoutTrees(dimension: DOM.Dimension): void {
		const listHeight = dimension.height - (76 + 11 /* header height + padding*/);
		const settingsTreeHeight = listHeight - 14;
		this.settingsTreeContainer.style.height = `${settingsTreeHeight}px`;
		this.settingsTree.layout(settingsTreeHeight, 800);

		const tocTreeHeight = listHeight - 16;
		this.tocTreeContainer.style.height = `${tocTreeHeight}px`;
		this.tocTree.layout(tocTreeHeight, 175);

		this.settingsTreeRenderer.updateWidth(dimension.width);
	}
}

interface ISettingsToolbarContext {
	target: SettingsTarget;
}

class FilterByTagAction extends Action {
	static readonly ID = 'settings.filterByTag';

	constructor(
		label: string,
		private tag: string,
		private settingsEditor: SettingsEditor2
	) {
		super(FilterByTagAction.ID, label, 'toggle-filter-tag');
	}

	run(): TPromise<void> {
		this.settingsEditor.focusSearch(this.tag === MODIFIED_SETTING_TAG ? `@${this.tag} ` : `@tag:${this.tag} `);
		return TPromise.as(null);
	}
}
