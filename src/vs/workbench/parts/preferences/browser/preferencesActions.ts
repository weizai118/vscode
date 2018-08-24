/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { TPromise } from 'vs/base/common/winjs.base';
import * as nls from 'vs/nls';
import URI from 'vs/base/common/uri';
import { Action } from 'vs/base/common/actions';
import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import { IModeService } from 'vs/editor/common/services/modeService';
import { IPreferencesService } from 'vs/workbench/services/preferences/common/preferences';
import { IWorkspaceContextService, WorkbenchState, IWorkspaceFolder } from 'vs/platform/workspace/common/workspace';
import { ICommandService } from 'vs/platform/commands/common/commands';
import { PICK_WORKSPACE_FOLDER_COMMAND_ID } from 'vs/workbench/browser/actions/workspaceCommands';
import { IQuickInputService, IQuickPickItem } from 'vs/platform/quickinput/common/quickInput';
import { getIconClasses } from 'vs/workbench/browser/labels';
import { IModelService } from 'vs/editor/common/services/modelService';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';

export class OpenRawDefaultSettingsAction extends Action {

	public static readonly ID = 'workbench.action.openRawDefaultSettings';
	public static readonly LABEL = nls.localize('openRawDefaultSettings', "Open Raw Default Settings");

	constructor(
		id: string,
		label: string,
		@IPreferencesService private preferencesService: IPreferencesService
	) {
		super(id, label);
	}

	public run(event?: any): TPromise<any> {
		return this.preferencesService.openRawDefaultSettings();
	}
}

export class OpenSettings2Action extends Action {

	public static readonly ID = 'workbench.action.openSettings2';
	public static readonly LABEL = nls.localize('openSettings2', "Open Settings (UI)");

	constructor(
		id: string,
		label: string,
		@IPreferencesService private preferencesService: IPreferencesService
	) {
		super(id, label);
	}

	public run(event?: any): TPromise<any> {
		return this.preferencesService.openSettings(false);
	}
}


export class OpenSettingsAction extends Action {

	public static readonly ID = 'workbench.action.openSettings';
	public static readonly LABEL = nls.localize('openSettings', "Open Settings");

	constructor(
		id: string,
		label: string,
		@IPreferencesService private preferencesService: IPreferencesService,
		@IConfigurationService private configurationService: IConfigurationService,
	) {
		super(id, label);
	}

	public run(event?: any): TPromise<any> {
		const jsonEditorPreferred = this.configurationService.getValue('workbench.settings.editor') === 'json';
		return this.preferencesService.openSettings(jsonEditorPreferred);
	}
}

export class OpenSettingsJsonAction extends Action {

	public static readonly ID = 'workbench.action.openSettingsJson';
	public static readonly LABEL = nls.localize('openSettingsJson', "Open Settings (JSON)");

	constructor(
		id: string,
		label: string,
		@IPreferencesService private preferencesService: IPreferencesService
	) {
		super(id, label);
	}

	public run(event?: any): TPromise<any> {
		return this.preferencesService.openSettings(true);
	}
}

export class OpenGlobalSettingsAction extends Action {

	public static readonly ID = 'workbench.action.openGlobalSettings';
	public static readonly LABEL = nls.localize('openGlobalSettings', "Open User Settings");

	constructor(
		id: string,
		label: string,
		@IPreferencesService private preferencesService: IPreferencesService,
		@IConfigurationService private configurationService: IConfigurationService
	) {
		super(id, label);
	}

	public run(event?: any): TPromise<any> {
		const jsonEditorPreferred = this.configurationService.getValue('workbench.settings.editor') === 'json';
		return this.preferencesService.openGlobalSettings(jsonEditorPreferred);
	}
}

export class OpenGlobalKeybindingsAction extends Action {

	public static readonly ID = 'workbench.action.openGlobalKeybindings';
	public static readonly LABEL = nls.localize('openGlobalKeybindings', "Open Keyboard Shortcuts");

	constructor(
		id: string,
		label: string,
		@IPreferencesService private preferencesService: IPreferencesService
	) {
		super(id, label);
	}

	public run(event?: any): TPromise<any> {
		return this.preferencesService.openGlobalKeybindingSettings(false);
	}
}

export class OpenGlobalKeybindingsFileAction extends Action {

	public static readonly ID = 'workbench.action.openGlobalKeybindingsFile';
	public static readonly LABEL = nls.localize('openGlobalKeybindingsFile', "Open Keyboard Shortcuts File");

	constructor(
		id: string,
		label: string,
		@IPreferencesService private preferencesService: IPreferencesService
	) {
		super(id, label);
	}

	public run(event?: any): TPromise<any> {
		return this.preferencesService.openGlobalKeybindingSettings(true);
	}
}

export class OpenDefaultKeybindingsFileAction extends Action {

	public static readonly ID = 'workbench.action.openDefaultKeybindingsFile';
	public static readonly LABEL = nls.localize('openDefaultKeybindingsFile', "Open Default Keyboard Shortcuts File");

	constructor(
		id: string,
		label: string,
		@IPreferencesService private preferencesService: IPreferencesService
	) {
		super(id, label);
	}

	public run(event?: any): TPromise<any> {
		return this.preferencesService.openDefaultKeybindingsFile();
	}
}

export class OpenWorkspaceSettingsAction extends Action {

	public static readonly ID = 'workbench.action.openWorkspaceSettings';
	public static readonly LABEL = nls.localize('openWorkspaceSettings', "Open Workspace Settings");

	private disposables: IDisposable[] = [];

	constructor(
		id: string,
		label: string,
		@IPreferencesService private preferencesService: IPreferencesService,
		@IConfigurationService private configurationService: IConfigurationService,
		@IWorkspaceContextService private workspaceContextService: IWorkspaceContextService
	) {
		super(id, label);
		this.update();
		this.workspaceContextService.onDidChangeWorkbenchState(() => this.update(), this, this.disposables);
	}

	private update(): void {
		this.enabled = this.workspaceContextService.getWorkbenchState() !== WorkbenchState.EMPTY;
	}

	public run(event?: any): TPromise<any> {
		const jsonEditorPreferred = this.configurationService.getValue('workbench.settings.editor') === 'json';
		return this.preferencesService.openWorkspaceSettings(jsonEditorPreferred);
	}

	public dispose(): void {
		this.disposables = dispose(this.disposables);
		super.dispose();
	}
}

export const OPEN_FOLDER_SETTINGS_COMMAND = '_workbench.action.openFolderSettings';
export const OPEN_FOLDER_SETTINGS_LABEL = nls.localize('openFolderSettings', "Open Folder Settings");
export class OpenFolderSettingsAction extends Action {

	public static readonly ID = 'workbench.action.openFolderSettings';
	public static readonly LABEL = OPEN_FOLDER_SETTINGS_LABEL;

	private disposables: IDisposable[] = [];


	constructor(
		id: string,
		label: string,
		@IWorkspaceContextService private workspaceContextService: IWorkspaceContextService,
		@IConfigurationService private configurationService: IConfigurationService,
		@IPreferencesService private preferencesService: IPreferencesService,
		@ICommandService private commandService: ICommandService
	) {
		super(id, label);
		this.update();
		this.workspaceContextService.onDidChangeWorkbenchState(() => this.update(), this, this.disposables);
		this.workspaceContextService.onDidChangeWorkspaceFolders(() => this.update(), this, this.disposables);
	}

	private update(): void {
		this.enabled = this.workspaceContextService.getWorkbenchState() === WorkbenchState.WORKSPACE && this.workspaceContextService.getWorkspace().folders.length > 0;
	}

	public run(): TPromise<any> {
		return this.commandService.executeCommand<IWorkspaceFolder>(PICK_WORKSPACE_FOLDER_COMMAND_ID)
			.then(workspaceFolder => {
				if (workspaceFolder) {
					const jsonEditorPreferred = this.configurationService.getValue('workbench.settings.editor') === 'json';
					return this.preferencesService.openFolderSettings(workspaceFolder.uri, jsonEditorPreferred);
				}

				return null;
			});
	}

	public dispose(): void {
		this.disposables = dispose(this.disposables);
		super.dispose();
	}
}

export class ConfigureLanguageBasedSettingsAction extends Action {

	public static readonly ID = 'workbench.action.configureLanguageBasedSettings';
	public static readonly LABEL = nls.localize('configureLanguageBasedSettings', "Configure Language Specific Settings...");

	constructor(
		id: string,
		label: string,
		@IModelService private modelService: IModelService,
		@IModeService private modeService: IModeService,
		@IQuickInputService private quickInputService: IQuickInputService,
		@IPreferencesService private preferencesService: IPreferencesService
	) {
		super(id, label);
	}

	public run(): TPromise<any> {
		const languages = this.modeService.getRegisteredLanguageNames();
		const picks: IQuickPickItem[] = languages.sort().map((lang, index) => {
			let description: string = nls.localize('languageDescriptionConfigured', "({0})", this.modeService.getModeIdForLanguageName(lang.toLowerCase()));
			// construct a fake resource to be able to show nice icons if any
			let fakeResource: URI;
			const extensions = this.modeService.getExtensions(lang);
			if (extensions && extensions.length) {
				fakeResource = URI.file(extensions[0]);
			} else {
				const filenames = this.modeService.getFilenames(lang);
				if (filenames && filenames.length) {
					fakeResource = URI.file(filenames[0]);
				}
			}
			return {
				label: lang,
				iconClasses: getIconClasses(this.modelService, this.modeService, fakeResource),
				description
			} as IQuickPickItem;
		});

		return this.quickInputService.pick(picks, { placeHolder: nls.localize('pickLanguage', "Select Language") })
			.then(pick => {
				if (pick) {
					return this.modeService.getOrCreateModeByLanguageName(pick.label)
						.then(mode => this.preferencesService.configureSettingsForLanguage(mode.getLanguageIdentifier().language));
				}
				return undefined;
			});

	}
}
