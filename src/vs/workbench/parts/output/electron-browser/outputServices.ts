/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vs/nls';
import * as paths from 'vs/base/common/paths';
import * as extfs from 'vs/base/node/extfs';
import { TPromise } from 'vs/base/common/winjs.base';
import { Event, Emitter } from 'vs/base/common/event';
import { URI } from 'vs/base/common/uri';
import { IDisposable, dispose, Disposable, toDisposable } from 'vs/base/common/lifecycle';
import { ICodeEditor } from 'vs/editor/browser/editorBrowser';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IStorageService, StorageScope } from 'vs/platform/storage/common/storage';
import { Registry } from 'vs/platform/registry/common/platform';
import { EditorOptions } from 'vs/workbench/common/editor';
import { IOutputChannelDescriptor, IOutputChannel, IOutputService, Extensions, OUTPUT_PANEL_ID, IOutputChannelRegistry, OUTPUT_SCHEME, OUTPUT_MIME, LOG_SCHEME, LOG_MIME, CONTEXT_ACTIVE_LOG_OUTPUT } from 'vs/workbench/parts/output/common/output';
import { OutputPanel } from 'vs/workbench/parts/output/browser/outputPanel';
import { IPanelService } from 'vs/workbench/services/panel/common/panelService';
import { IModelService } from 'vs/editor/common/services/modelService';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import { OutputLinkProvider } from 'vs/workbench/parts/output/common/outputLinkProvider';
import { ITextModelService, ITextModelContentProvider } from 'vs/editor/common/services/resolverService';
import { ITextModel } from 'vs/editor/common/model';
import { IModeService } from 'vs/editor/common/services/modeService';
import { RunOnceScheduler, ThrottledDelayer } from 'vs/base/common/async';
import { EditOperation } from 'vs/editor/common/core/editOperation';
import { Position } from 'vs/editor/common/core/position';
import { IFileService } from 'vs/platform/files/common/files';
import { IPanel } from 'vs/workbench/common/panel';
import { ResourceEditorInput } from 'vs/workbench/common/editor/resourceEditorInput';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { toLocalISOString } from 'vs/base/common/date';
import { IWindowService } from 'vs/platform/windows/common/windows';
import { ILogService } from 'vs/platform/log/common/log';
import { ILifecycleService } from 'vs/platform/lifecycle/common/lifecycle';
import { IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { CancellationToken } from 'vs/base/common/cancellation';
import { OutputAppender } from 'vs/platform/output/node/outputAppender';

const OUTPUT_ACTIVE_CHANNEL_KEY = 'output.activechannel';

let watchingOutputDir = false;
let callbacks: ((eventType: string, fileName: string) => void)[] = [];
function watchOutputDirectory(outputDir: string, logService: ILogService, onChange: (eventType: string, fileName: string) => void): IDisposable {
	callbacks.push(onChange);
	if (!watchingOutputDir) {
		const watcher = extfs.watch(outputDir, (eventType, fileName) => {
			for (const callback of callbacks) {
				callback(eventType, fileName);
			}
		}, (error: string) => {
			logService.error(error);
		});
		watchingOutputDir = true;
		return toDisposable(() => {
			callbacks = [];
			if (watcher) {
				watcher.removeAllListeners();
				watcher.close();
			}
		});
	}
	return toDisposable(() => { });
}

interface OutputChannel extends IOutputChannel {
	readonly file: URI;
	readonly onDidAppendedContent: Event<void>;
	readonly onDispose: Event<void>;
	loadModel(): TPromise<ITextModel>;
}

abstract class AbstractFileOutputChannel extends Disposable {

	scrollLock: boolean = false;

	protected _onDidAppendedContent: Emitter<void> = new Emitter<void>();
	readonly onDidAppendedContent: Event<void> = this._onDidAppendedContent.event;

	protected _onDispose: Emitter<void> = new Emitter<void>();
	readonly onDispose: Event<void> = this._onDispose.event;

	private readonly mimeType: string;
	protected modelUpdater: RunOnceScheduler;
	protected model: ITextModel;
	readonly file: URI;

	protected startOffset: number = 0;
	protected endOffset: number = 0;

	constructor(
		protected readonly outputChannelDescriptor: IOutputChannelDescriptor,
		private readonly modelUri: URI,
		protected fileService: IFileService,
		protected modelService: IModelService,
		protected modeService: IModeService,
	) {
		super();
		this.mimeType = outputChannelDescriptor.log ? LOG_MIME : OUTPUT_MIME;
		this.file = this.outputChannelDescriptor.file;
		this.modelUpdater = new RunOnceScheduler(() => this.updateModel(), 300);
		this._register(toDisposable(() => this.modelUpdater.cancel()));
	}

	get id(): string {
		return this.outputChannelDescriptor.id;
	}

	get label(): string {
		return this.outputChannelDescriptor.label;
	}

	clear(): void {
		if (this.modelUpdater.isScheduled()) {
			this.modelUpdater.cancel();
			this.onUpdateModelCancelled();
		}
		if (this.model) {
			this.model.setValue('');
		}
		this.startOffset = this.endOffset;
	}

	protected createModel(content: string): ITextModel {
		if (this.model) {
			this.model.setValue(content);
		} else {
			this.model = this.modelService.createModel(content, this.modeService.getOrCreateMode(this.mimeType), this.modelUri);
			this.onModelCreated(this.model);
			const disposables: IDisposable[] = [];
			disposables.push(this.model.onWillDispose(() => {
				this.onModelWillDispose(this.model);
				this.model = null;
				dispose(disposables);
			}));
		}
		return this.model;
	}

	appendToModel(content: string): void {
		if (this.model && content) {
			const lastLine = this.model.getLineCount();
			const lastLineMaxColumn = this.model.getLineMaxColumn(lastLine);
			this.model.applyEdits([EditOperation.insert(new Position(lastLine, lastLineMaxColumn), content)]);
			this._onDidAppendedContent.fire();
		}
	}

	protected onModelCreated(model: ITextModel) { }
	protected onModelWillDispose(model: ITextModel) { }
	protected onUpdateModelCancelled() { }
	protected updateModel() { }

	dispose(): void {
		this._onDispose.fire();
		super.dispose();
	}
}

/**
 * An output channel that stores appended messages in a backup file.
 */
class OutputChannelBackedByFile extends AbstractFileOutputChannel implements OutputChannel {

	private appender: OutputAppender;
	private appendedMessage = '';
	private loadingFromFileInProgress: boolean = false;
	private resettingDelayer: ThrottledDelayer<void>;
	private readonly rotatingFilePath: string;

	constructor(
		outputChannelDescriptor: IOutputChannelDescriptor,
		outputDir: string,
		modelUri: URI,
		@IFileService fileService: IFileService,
		@IModelService modelService: IModelService,
		@IModeService modeService: IModeService,
		@ILogService logService: ILogService
	) {
		super({ ...outputChannelDescriptor, file: URI.file(paths.join(outputDir, `${outputChannelDescriptor.id}.log`)) }, modelUri, fileService, modelService, modeService);

		// Use one rotating file to check for main file reset
		this.appender = new OutputAppender(this.id, this.file.fsPath);
		this.rotatingFilePath = `${outputChannelDescriptor.id}.1.log`;
		this._register(watchOutputDirectory(paths.dirname(this.file.fsPath), logService, (eventType, file) => this.onFileChangedInOutputDirector(eventType, file)));

		this.resettingDelayer = new ThrottledDelayer<void>(50);
	}

	append(message: string): void {
		// update end offset always as message is read
		this.endOffset = this.endOffset + Buffer.from(message).byteLength;
		if (this.loadingFromFileInProgress) {
			this.appendedMessage += message;
		} else {
			this.write(message);
			if (this.model) {
				this.appendedMessage += message;
				if (!this.modelUpdater.isScheduled()) {
					this.modelUpdater.schedule();
				}
			}
		}
	}

	clear(): void {
		super.clear();
		this.appendedMessage = '';
	}

	loadModel(): TPromise<ITextModel> {
		this.loadingFromFileInProgress = true;
		if (this.modelUpdater.isScheduled()) {
			this.modelUpdater.cancel();
		}
		this.appendedMessage = '';
		return this.loadFile()
			.then(content => {
				if (this.endOffset !== this.startOffset + Buffer.from(content).byteLength) {
					// Queue content is not written into the file
					// Flush it and load file again
					this.flush();
					return this.loadFile();
				}
				return content;
			})
			.then(content => {
				if (this.appendedMessage) {
					this.write(this.appendedMessage);
					this.appendedMessage = '';
				}
				this.loadingFromFileInProgress = false;
				return this.createModel(content);
			});
	}

	private resetModel(): TPromise<void> {
		this.startOffset = 0;
		this.endOffset = 0;
		if (this.model) {
			return this.loadModel() as TPromise;
		}
		return TPromise.as(null);
	}

	private loadFile(): TPromise<string> {
		return this.fileService.resolveContent(this.file, { position: this.startOffset, encoding: 'utf8' })
			.then(content => this.appendedMessage ? content.value + this.appendedMessage : content.value);
	}

	protected updateModel(): void {
		if (this.model && this.appendedMessage) {
			this.appendToModel(this.appendedMessage);
			this.appendedMessage = '';
		}
	}

	private onFileChangedInOutputDirector(eventType: string, fileName: string): void {
		// Check if rotating file has changed. It changes only when the main file exceeds its limit.
		if (this.rotatingFilePath === fileName) {
			this.resettingDelayer.trigger(() => this.resetModel());
		}
	}

	private write(content: string): void {
		this.appender.append(content);
	}

	private flush(): void {
		this.appender.flush();
	}
}

class OutputFileListener extends Disposable {

	private readonly _onDidChange: Emitter<void> = new Emitter<void>();
	readonly onDidContentChange: Event<void> = this._onDidChange.event;

	private watching: boolean = false;
	private disposables: IDisposable[] = [];

	constructor(
		private readonly file: URI,
		private readonly fileService: IFileService
	) {
		super();
	}

	watch(): void {
		if (!this.watching) {
			this.fileService.watchFileChanges(this.file);
			this.disposables.push(this.fileService.onFileChanges(e => {
				if (e.contains(this.file)) {
					this._onDidChange.fire();
				}
			}));
			this.watching = true;
		}
	}

	unwatch(): void {
		if (this.watching) {
			this.fileService.unwatchFileChanges(this.file);
			this.disposables = dispose(this.disposables);
			this.watching = false;
		}
	}

	dispose(): void {
		this.unwatch();
		super.dispose();
	}
}

/**
 * An output channel driven by a file and does not support appending messages.
 */
class FileOutputChannel extends AbstractFileOutputChannel implements OutputChannel {

	private readonly fileHandler: OutputFileListener;

	private updateInProgress: boolean = false;

	constructor(
		outputChannelDescriptor: IOutputChannelDescriptor,
		modelUri: URI,
		@IFileService fileService: IFileService,
		@IModelService modelService: IModelService,
		@IModeService modeService: IModeService,
		@ILogService logService: ILogService,
	) {
		super(outputChannelDescriptor, modelUri, fileService, modelService, modeService);

		this.fileHandler = this._register(new OutputFileListener(this.file, this.fileService));
		this._register(this.fileHandler.onDidContentChange(() => this.onDidContentChange()));
		this._register(toDisposable(() => this.fileHandler.unwatch()));
	}

	loadModel(): TPromise<ITextModel> {
		return this.fileService.resolveContent(this.file, { position: this.startOffset, encoding: 'utf8' })
			.then(content => {
				this.endOffset = this.startOffset + Buffer.from(content.value).byteLength;
				return this.createModel(content.value);
			});
	}

	append(message: string): void {
		throw new Error('Not supported');
	}

	protected updateModel(): void {
		if (this.model) {
			this.fileService.resolveContent(this.file, { position: this.endOffset, encoding: 'utf8' })
				.then(content => {
					if (content.value) {
						this.endOffset = this.endOffset + Buffer.from(content.value).byteLength;
						this.appendToModel(content.value);
					}
					this.updateInProgress = false;
				}, () => this.updateInProgress = false);
		} else {
			this.updateInProgress = false;
		}
	}

	protected onModelCreated(model: ITextModel): void {
		this.fileHandler.watch();
	}

	protected onModelWillDispose(model: ITextModel): void {
		this.fileHandler.unwatch();
	}

	protected onUpdateModelCancelled(): void {
		this.updateInProgress = false;
	}

	private onDidContentChange(): void {
		if (!this.updateInProgress) {
			this.updateInProgress = true;
			this.modelUpdater.schedule();
		}
	}
}

export class OutputService extends Disposable implements IOutputService, ITextModelContentProvider {

	public _serviceBrand: any;

	private channels: Map<string, OutputChannel> = new Map<string, OutputChannel>();
	private activeChannelIdInStorage: string;
	private activeChannel: IOutputChannel;
	private readonly outputDir: string;

	private readonly _onActiveOutputChannel: Emitter<string> = new Emitter<string>();
	readonly onActiveOutputChannel: Event<string> = this._onActiveOutputChannel.event;

	private _outputPanel: OutputPanel;

	constructor(
		@IStorageService private storageService: IStorageService,
		@IInstantiationService private instantiationService: IInstantiationService,
		@IPanelService private panelService: IPanelService,
		@IWorkspaceContextService contextService: IWorkspaceContextService,
		@ITextModelService textModelResolverService: ITextModelService,
		@IEnvironmentService environmentService: IEnvironmentService,
		@IWindowService windowService: IWindowService,
		@ILogService private logService: ILogService,
		@ILifecycleService private lifecycleService: ILifecycleService,
		@IContextKeyService private contextKeyService: IContextKeyService,
	) {
		super();
		this.activeChannelIdInStorage = this.storageService.get(OUTPUT_ACTIVE_CHANNEL_KEY, StorageScope.WORKSPACE, null);
		this.outputDir = paths.join(environmentService.logsPath, `output_${windowService.getCurrentWindowId()}_${toLocalISOString(new Date()).replace(/-|:|\.\d+Z$/g, '')}`);

		// Register as text model content provider for output
		textModelResolverService.registerTextModelContentProvider(OUTPUT_SCHEME, this);
		instantiationService.createInstance(OutputLinkProvider);

		// Create output channels for already registered channels
		const registry = Registry.as<IOutputChannelRegistry>(Extensions.OutputChannels);
		for (const channelIdentifier of registry.getChannels()) {
			this.onDidRegisterChannel(channelIdentifier.id);
		}
		this._register(registry.onDidRegisterChannel(this.onDidRegisterChannel, this));

		panelService.onDidPanelOpen(this.onDidPanelOpen, this);
		panelService.onDidPanelClose(this.onDidPanelClose, this);

		// Set active channel to first channel if not set
		if (!this.activeChannel) {
			const channels = this.getChannelDescriptors();
			this.activeChannel = channels && channels.length > 0 ? this.getChannel(channels[0].id) : null;
		}

		this.lifecycleService.onShutdown(() => this.onShutdown());
	}

	provideTextContent(resource: URI): TPromise<ITextModel> {
		const channel = <OutputChannel>this.getChannel(resource.path);
		if (channel) {
			return channel.loadModel();
		}
		return TPromise.as(null);
	}

	showChannel(id: string, preserveFocus?: boolean): TPromise<void> {
		const channel = this.getChannel(id);
		if (!channel || this.isChannelShown(channel)) {
			return TPromise.as(null);
		}

		this.activeChannel = channel;
		let promise = TPromise.as(null);
		if (this.isPanelShown()) {
			this.doShowChannel(channel, preserveFocus);
		} else {
			promise = this.panelService.openPanel(OUTPUT_PANEL_ID) as TPromise;
		}
		return promise.then(() => this._onActiveOutputChannel.fire(id));
	}

	getChannel(id: string): IOutputChannel {
		return this.channels.get(id);
	}

	getChannelDescriptors(): IOutputChannelDescriptor[] {
		return Registry.as<IOutputChannelRegistry>(Extensions.OutputChannels).getChannels();
	}

	getActiveChannel(): IOutputChannel {
		return this.activeChannel;
	}

	private onDidRegisterChannel(channelId: string): void {
		const channel = this.createChannel(channelId);
		this.channels.set(channelId, channel);
		if (this.activeChannelIdInStorage === channelId) {
			this.activeChannel = channel;
			this.onDidPanelOpen(this.panelService.getActivePanel())
				.then(() => this._onActiveOutputChannel.fire(channelId));
		}
	}

	private onDidPanelOpen(panel: IPanel): Thenable<void> {
		if (panel && panel.getId() === OUTPUT_PANEL_ID) {
			this._outputPanel = <OutputPanel>this.panelService.getActivePanel();
			if (this.activeChannel) {
				return this.doShowChannel(this.activeChannel, true);
			}
		}
		return TPromise.as(null);
	}

	private onDidPanelClose(panel: IPanel): void {
		if (this._outputPanel && panel.getId() === OUTPUT_PANEL_ID) {
			CONTEXT_ACTIVE_LOG_OUTPUT.bindTo(this.contextKeyService).set(false);
			this._outputPanel.clearInput();
		}
	}

	private setPrimaryCursorToLastLine(): void {
		const codeEditor = <ICodeEditor>this._outputPanel.getControl();
		const model = codeEditor.getModel();

		if (model) {
			const lastLine = model.getLineCount();
			codeEditor.setPosition({ lineNumber: lastLine, column: model.getLineMaxColumn(lastLine) });
		}
	}

	private createChannel(id: string): OutputChannel {
		const channelDisposables: IDisposable[] = [];
		const channel = this.instantiateChannel(id);
		channel.onDidAppendedContent(() => {
			if (!channel.scrollLock) {
				const panel = this.panelService.getActivePanel();
				if (panel && panel.getId() === OUTPUT_PANEL_ID && this.isChannelShown(channel)) {
					let outputPanel = <OutputPanel>panel;
					outputPanel.revealLastLine(true);
				}
			}
		}, channelDisposables);
		channel.onDispose(() => {
			Registry.as<IOutputChannelRegistry>(Extensions.OutputChannels).removeChannel(id);
			if (this.activeChannel === channel) {
				const channels = this.getChannelDescriptors();
				if (this.isPanelShown() && channels.length) {
					this.doShowChannel(this.getChannel(channels[0].id), true);
					this._onActiveOutputChannel.fire(channels[0].id);
				} else {
					this._onActiveOutputChannel.fire(void 0);
				}
			}
			dispose(channelDisposables);
		}, channelDisposables);

		return channel;
	}

	private instantiateChannel(id: string): OutputChannel {
		const channelData = Registry.as<IOutputChannelRegistry>(Extensions.OutputChannels).getChannel(id);
		if (!channelData) {
			this.logService.error(`Channel '${id}' is not registered yet`);
			throw new Error(`Channel '${id}' is not registered yet`);
		}

		const uri = URI.from({ scheme: OUTPUT_SCHEME, path: id });
		if (channelData && channelData.file) {
			return this.instantiationService.createInstance(FileOutputChannel, channelData, uri);
		}
		return this.instantiationService.createInstance(OutputChannelBackedByFile, { id, label: channelData ? channelData.label : '' }, this.outputDir, uri);
	}

	private doShowChannel(channel: IOutputChannel, preserveFocus: boolean): Thenable<void> {
		if (this._outputPanel) {
			CONTEXT_ACTIVE_LOG_OUTPUT.bindTo(this.contextKeyService).set(channel instanceof FileOutputChannel);
			return this._outputPanel.setInput(this.createInput(channel), EditorOptions.create({ preserveFocus: preserveFocus }), CancellationToken.None)
				.then(() => {
					if (!preserveFocus) {
						this._outputPanel.focus();
					}
				})
				// Activate smart scroll when switching back to the output panel
				.then(() => this.setPrimaryCursorToLastLine());
		}
		return TPromise.as(null);
	}

	private isChannelShown(channel: IOutputChannel): boolean {
		return this.isPanelShown() && this.activeChannel === channel;
	}

	private isPanelShown(): boolean {
		const panel = this.panelService.getActivePanel();
		return panel && panel.getId() === OUTPUT_PANEL_ID;
	}

	private createInput(channel: IOutputChannel): ResourceEditorInput {
		const resource = URI.from({ scheme: OUTPUT_SCHEME, path: channel.id });
		return this.instantiationService.createInstance(ResourceEditorInput, nls.localize('output', "{0} - Output", channel.label), nls.localize('channel', "Output channel for '{0}'", channel.label), resource);
	}

	onShutdown(): void {
		if (this.activeChannel) {
			this.storageService.store(OUTPUT_ACTIVE_CHANNEL_KEY, this.activeChannel.id, StorageScope.WORKSPACE);
		}
		this.dispose();
	}
}

export class LogContentProvider {

	private channels: Map<string, OutputChannel> = new Map<string, OutputChannel>();

	constructor(
		@IOutputService private outputService: IOutputService,
		@IInstantiationService private instantiationService: IInstantiationService
	) {
	}

	provideTextContent(resource: URI): TPromise<ITextModel> {
		if (resource.scheme === LOG_SCHEME) {
			let channel = this.getChannel(resource);
			if (channel) {
				return channel.loadModel();
			}
		}
		return TPromise.as(null);
	}

	private getChannel(resource: URI): OutputChannel {
		const channelId = resource.path;
		let channel = this.channels.get(channelId);
		if (!channel) {
			const channelDisposables: IDisposable[] = [];
			const outputChannelDescriptor = this.outputService.getChannelDescriptors().filter(({ id }) => id === channelId)[0];
			if (outputChannelDescriptor && outputChannelDescriptor.file) {
				channel = this.instantiationService.createInstance(FileOutputChannel, outputChannelDescriptor, resource);
				channel.onDispose(() => dispose(channelDisposables), channelDisposables);
				this.channels.set(channelId, channel);
			}
		}
		return channel;
	}
}