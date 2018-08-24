/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, fork, ForkOptions } from 'child_process';
import { IDisposable, toDisposable, dispose } from 'vs/base/common/lifecycle';
import { TPromise } from 'vs/base/common/winjs.base';
import { Delayer } from 'vs/base/common/async';
import { deepClone, assign } from 'vs/base/common/objects';
import { Emitter, fromNodeEventEmitter, Event } from 'vs/base/common/event';
import { createQueuedSender } from 'vs/base/node/processes';
import { ChannelServer as IPCServer, ChannelClient as IPCClient, IChannelClient, IChannel } from 'vs/base/parts/ipc/node/ipc';
import { isRemoteConsoleLog, log } from 'vs/base/node/console';

/**
 * This implementation doesn't perform well since it uses base64 encoding for buffers.
 * We should move all implementations to use named ipc.net, so we stop depending on cp.fork.
 */

export class Server extends IPCServer {
	constructor() {
		super({
			send: r => { try { process.send(r.toString('base64')); } catch (e) { /* not much to do */ } },
			onMessage: fromNodeEventEmitter(process, 'message', msg => Buffer.from(msg, 'base64'))
		});

		process.once('disconnect', () => this.dispose());
	}
}

export interface IIPCOptions {

	/**
	 * A descriptive name for the server this connection is to. Used in logging.
	 */
	serverName: string;

	/**
	 * Time in millies before killing the ipc process. The next request after killing will start it again.
	 */
	timeout?: number;

	/**
	 * Arguments to the module to execute.
	 */
	args?: string[];

	/**
	 * Environment key-value pairs to be passed to the process that gets spawned for the ipc.
	 */
	env?: any;

	/**
	 * Allows to assign a debug port for debugging the application executed.
	 */
	debug?: number;

	/**
	 * Allows to assign a debug port for debugging the application and breaking it on the first line.
	 */
	debugBrk?: number;

	/**
	 * See https://github.com/Microsoft/vscode/issues/27665
	 * Allows to pass in fresh execArgv to the forked process such that it doesn't inherit them from `process.execArgv`.
	 * e.g. Launching the extension host process with `--inspect-brk=xxx` and then forking a process from the extension host
	 * results in the forked process inheriting `--inspect-brk=xxx`.
	 */
	freshExecArgv?: boolean;

	/**
	 * Enables our createQueuedSender helper for this Client. Uses a queue when the internal Node.js queue is
	 * full of messages - see notes on that method.
	 */
	useQueue?: boolean;
}

export class Client implements IChannelClient, IDisposable {

	private disposeDelayer: Delayer<void>;
	private activeRequests: IDisposable[];
	private child: ChildProcess;
	private _client: IPCClient;
	private channels: { [name: string]: IChannel };

	private _onDidProcessExit = new Emitter<{ code: number, signal: string }>();
	readonly onDidProcessExit = this._onDidProcessExit.event;

	constructor(private modulePath: string, private options: IIPCOptions) {
		const timeout = options && options.timeout ? options.timeout : 60000;
		this.disposeDelayer = new Delayer<void>(timeout);
		this.activeRequests = [];
		this.child = null;
		this._client = null;
		this.channels = Object.create(null);
	}

	getChannel<T extends IChannel>(channelName: string): T {
		const call = (command: string, arg: any) => this.requestPromise(channelName, command, arg);
		const listen = (event: string, arg: any) => this.requestEvent(channelName, event, arg);
		return { call, listen } as IChannel as T;
	}

	protected requestPromise(channelName: string, name: string, arg: any): TPromise<void> {
		if (!this.disposeDelayer) {
			return TPromise.wrapError(new Error('disposed'));
		}

		this.disposeDelayer.cancel();

		const channel = this.channels[channelName] || (this.channels[channelName] = this.client.getChannel(channelName));
		const request: TPromise<void> = channel.call(name, arg);

		const result = new TPromise<void>((c, e) => {
			request.then(c, e).done(() => {
				if (!this.activeRequests) {
					return;
				}

				this.activeRequests.splice(this.activeRequests.indexOf(disposable), 1);

				if (this.activeRequests.length === 0) {
					this.disposeDelayer.trigger(() => this.disposeClient());
				}
			});
		}, () => request.cancel());

		const disposable = toDisposable(() => result.cancel());
		this.activeRequests.push(disposable);
		return result;
	}

	protected requestEvent<T>(channelName: string, name: string, arg: any): Event<T> {
		if (!this.disposeDelayer) {
			return Event.None;
		}

		this.disposeDelayer.cancel();

		let listener: IDisposable;
		const emitter = new Emitter<any>({
			onFirstListenerAdd: () => {
				const channel = this.channels[channelName] || (this.channels[channelName] = this.client.getChannel(channelName));
				const event: Event<T> = channel.listen(name, arg);

				listener = event(emitter.fire, emitter);
				this.activeRequests.push(listener);

			},
			onLastListenerRemove: () => {
				if (!this.activeRequests) {
					return;
				}

				this.activeRequests.splice(this.activeRequests.indexOf(listener), 1);
				listener.dispose();

				if (this.activeRequests.length === 0) {
					this.disposeDelayer.trigger(() => this.disposeClient());
				}
			}
		});

		return emitter.event;
	}

	private get client(): IPCClient {
		if (!this._client) {
			const args = this.options && this.options.args ? this.options.args : [];
			const forkOpts: ForkOptions = Object.create(null);

			forkOpts.env = assign(deepClone(process.env), { 'VSCODE_PARENT_PID': String(process.pid) });

			if (this.options && this.options.env) {
				forkOpts.env = assign(forkOpts.env, this.options.env);
			}

			if (this.options && this.options.freshExecArgv) {
				forkOpts.execArgv = [];
			}

			if (this.options && typeof this.options.debug === 'number') {
				forkOpts.execArgv = ['--nolazy', '--inspect=' + this.options.debug];
			}

			if (this.options && typeof this.options.debugBrk === 'number') {
				forkOpts.execArgv = ['--nolazy', '--inspect-brk=' + this.options.debugBrk];
			}

			this.child = fork(this.modulePath, args, forkOpts);

			const onMessageEmitter = new Emitter<Buffer>();
			const onRawMessage = fromNodeEventEmitter(this.child, 'message', msg => msg);

			onRawMessage(msg => {

				// Handle remote console logs specially
				if (isRemoteConsoleLog(msg)) {
					log(msg, `IPC Library: ${this.options.serverName}`);
					return null;
				}

				// Anything else goes to the outside
				onMessageEmitter.fire(Buffer.from(msg, 'base64'));
			});

			const sender = this.options.useQueue ? createQueuedSender(this.child) : this.child;
			const send = (r: Buffer) => this.child && this.child.connected && sender.send(r.toString('base64'));
			const onMessage = onMessageEmitter.event;
			const protocol = { send, onMessage };

			this._client = new IPCClient(protocol);

			const onExit = () => this.disposeClient();
			process.once('exit', onExit);

			this.child.on('error', err => console.warn('IPC "' + this.options.serverName + '" errored with ' + err));

			this.child.on('exit', (code: any, signal: any) => {
				process.removeListener('exit', onExit);

				if (this.activeRequests) {
					this.activeRequests = dispose(this.activeRequests);
				}

				if (code !== 0 && signal !== 'SIGTERM') {
					console.warn('IPC "' + this.options.serverName + '" crashed with exit code ' + code + ' and signal ' + signal);
					this.disposeDelayer.cancel();
					this.disposeClient();
				}

				this._onDidProcessExit.fire({ code, signal });
			});
		}

		return this._client;
	}

	private disposeClient() {
		if (this._client) {
			this.child.kill();
			this.child = null;
			this._client = null;
			this.channels = Object.create(null);
		}
	}

	dispose() {
		this._onDidProcessExit.dispose();
		this.disposeDelayer.cancel();
		this.disposeDelayer = null;
		this.disposeClient();
		this.activeRequests = null;
	}
}
