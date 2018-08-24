/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { Promise, TPromise } from 'vs/base/common/winjs.base';
import { IDisposable, toDisposable, dispose } from 'vs/base/common/lifecycle';
import { Event, Emitter, once, filterEvent, toPromise, Relay } from 'vs/base/common/event';

export enum RequestType {
	Promise = 100,
	PromiseCancel = 101,
	EventListen = 102,
	EventDispose = 103
}

type IRawPromiseRequest = { type: RequestType.Promise; id: number; channelName: string; name: string; arg: any; };
type IRawPromiseCancelRequest = { type: RequestType.PromiseCancel, id: number };
type IRawEventListenRequest = { type: RequestType.EventListen; id: number; channelName: string; name: string; arg: any; };
type IRawEventDisposeRequest = { type: RequestType.EventDispose, id: number };
type IRawRequest = IRawPromiseRequest | IRawPromiseCancelRequest | IRawEventListenRequest | IRawEventDisposeRequest;

interface IRequest {
	raw: IRawRequest;
	flush?: () => void;
}

export enum ResponseType {
	Initialize = 200,
	PromiseSuccess = 201,
	PromiseError = 202,
	PromiseErrorObj = 203,
	EventFire = 204
}

type IRawInitializeResponse = { type: ResponseType.Initialize };
type IRawPromiseSuccessResponse = { type: ResponseType.PromiseSuccess; id: number; data: any };
type IRawPromiseErrorResponse = { type: ResponseType.PromiseError; id: number; data: { message: string, name: string, stack: string[] | undefined } };
type IRawPromiseErrorObjResponse = { type: ResponseType.PromiseErrorObj; id: number; data: any };
type IRawEventFireResponse = { type: ResponseType.EventFire; id: number; data: any };
type IRawResponse = IRawInitializeResponse | IRawPromiseSuccessResponse | IRawPromiseErrorResponse | IRawPromiseErrorObjResponse | IRawEventFireResponse;

interface IHandler {
	(response: IRawResponse): void;
}

export interface IMessagePassingProtocol {
	send(buffer: Buffer): void;
	onMessage: Event<Buffer>;
}

enum State {
	Uninitialized,
	Idle
}

/**
 * An `IChannel` is an abstraction over a collection of commands.
 * You can `call` several commands on a channel, each taking at
 * most one single argument. A `call` always returns a promise
 * with at most one single return value.
 */
export interface IChannel {
	call<T>(command: string, arg?: any): TPromise<T>;
	listen<T>(event: string, arg?: any): Event<T>;
}

/**
 * An `IChannelServer` hosts a collection of channels. You are
 * able to register channels onto it, provided a channel name.
 */
export interface IChannelServer {
	registerChannel(channelName: string, channel: IChannel): void;
}

/**
 * An `IChannelClient` has access to a collection of channels. You
 * are able to get those channels, given their channel name.
 */
export interface IChannelClient {
	getChannel<T extends IChannel>(channelName: string): T;
}

/**
 * An `IClientRouter` is responsible for routing calls to specific
 * channels, in scenarios in which there are multiple possible
 * channels (each from a separate client) to pick from.
 */
export interface IClientRouter {
	routeCall(command: string, arg: any): TPromise<string>;
	routeEvent(event: string, arg: any): TPromise<string>;
}

/**
 * Similar to the `IChannelClient`, you can get channels from this
 * collection of channels. The difference being that in the
 * `IRoutingChannelClient`, there are multiple clients providing
 * the same channel. You'll need to pass in an `IClientRouter` in
 * order to pick the right one.
 */
export interface IRoutingChannelClient {
	getChannel<T extends IChannel>(channelName: string, router: IClientRouter): T;
}

enum BodyType {
	Undefined,
	String,
	Buffer,
	Object
}

const empty = Buffer.allocUnsafe(0);

function serializeBody(body: any): { buffer: Buffer, type: BodyType } {
	if (typeof body === 'undefined') {
		return { buffer: empty, type: BodyType.Undefined };
	} else if (typeof body === 'string') {
		return { buffer: Buffer.from(body), type: BodyType.String };
	} else if (Buffer.isBuffer(body)) {
		return { buffer: body, type: BodyType.Buffer };
	} else {
		return { buffer: Buffer.from(JSON.stringify(body)), type: BodyType.Object };
	}
}

function serialize(header: any, body: any = undefined): Buffer {
	const headerSizeBuffer = Buffer.allocUnsafe(4);
	const { buffer: bodyBuffer, type: bodyType } = serializeBody(body);
	const headerBuffer = Buffer.from(JSON.stringify([header, bodyType]));
	headerSizeBuffer.writeUInt32BE(headerBuffer.byteLength, 0);

	return Buffer.concat([headerSizeBuffer, headerBuffer, bodyBuffer]);
}

function deserializeBody(bodyBuffer: Buffer, bodyType: BodyType): any {
	switch (bodyType) {
		case BodyType.Undefined: return undefined;
		case BodyType.String: return bodyBuffer.toString();
		case BodyType.Buffer: return bodyBuffer;
		case BodyType.Object: return JSON.parse(bodyBuffer.toString());
	}
}

function deserialize(buffer: Buffer): { header: any, body: any } {
	const headerSize = buffer.readUInt32BE(0);
	const headerBuffer = buffer.slice(4, 4 + headerSize);
	const bodyBuffer = buffer.slice(4 + headerSize);
	const [header, bodyType] = JSON.parse(headerBuffer.toString());
	const body = deserializeBody(bodyBuffer, bodyType);

	return { header, body };
}

export class ChannelServer implements IChannelServer, IDisposable {

	private channels: { [name: string]: IChannel } = Object.create(null);
	private activeRequests: { [id: number]: IDisposable; } = Object.create(null);
	private protocolListener: IDisposable;

	constructor(private protocol: IMessagePassingProtocol) {
		this.protocolListener = this.protocol.onMessage(msg => this.onRawMessage(msg));
		this.sendResponse({ type: ResponseType.Initialize });
	}

	registerChannel(channelName: string, channel: IChannel): void {
		this.channels[channelName] = channel;
	}

	private onPromise(request: IRawPromiseRequest): void {
		const channel = this.channels[request.channelName];
		let promise: Promise;

		try {
			promise = channel.call(request.name, request.arg);
		} catch (err) {
			promise = TPromise.wrapError(err);
		}

		const id = request.id;

		const requestPromise = promise.then(data => {
			this.sendResponse(<IRawResponse>{ id, data, type: ResponseType.PromiseSuccess });
			delete this.activeRequests[request.id];
		}, data => {
			if (data instanceof Error) {
				this.sendResponse(<IRawResponse>{
					id, data: {
						message: data.message,
						name: data.name,
						stack: data.stack ? (data.stack.split ? data.stack.split('\n') : data.stack) : void 0
					}, type: ResponseType.PromiseError
				});
			} else {
				this.sendResponse(<IRawResponse>{ id, data, type: ResponseType.PromiseErrorObj });
			}

			delete this.activeRequests[request.id];
		});

		this.activeRequests[request.id] = toDisposable(() => requestPromise.cancel());
	}

	private onEventListen(request: IRawEventListenRequest): void {
		const channel = this.channels[request.channelName];

		const id = request.id;
		const event = channel.listen(request.name, request.arg);
		const disposable = event(data => this.sendResponse(<IRawResponse>{ id, data, type: ResponseType.EventFire }));

		this.activeRequests[request.id] = disposable;
	}

	private disposeActiveRequest(request: IRawRequest): void {
		const disposable = this.activeRequests[request.id];

		if (disposable) {
			disposable.dispose();
			delete this.activeRequests[request.id];
		}
	}

	private onRawMessage(message: Buffer): void {
		const { header, body } = deserialize(message);
		const type: RequestType = header[0];
		let request: IRawRequest;

		switch (type) {
			case RequestType.Promise:
			case RequestType.EventListen:
				request = { type: header[0], id: header[1], channelName: header[2], name: header[3], arg: body };
				break;
			case RequestType.PromiseCancel:
			case RequestType.EventDispose:
				request = { type: header[0], id: header[1] };
				break;
			default:
				return;
		}

		this.onRequest(request);
	}

	private onRequest(request: IRawRequest): void {
		switch (request.type) {
			case RequestType.Promise:
				this.onPromise(request);
				break;

			case RequestType.EventListen:
				this.onEventListen(request);
				break;

			case RequestType.PromiseCancel:
			case RequestType.EventDispose:
				this.disposeActiveRequest(request);
				break;
		}
	}

	private sendResponse(response: IRawResponse) {
		let buffer: Buffer;

		switch (response.type) {
			case ResponseType.Initialize:
				buffer = serialize([response.type]);
				break;
			case ResponseType.PromiseSuccess:
			case ResponseType.PromiseError:
			case ResponseType.EventFire:
			case ResponseType.PromiseErrorObj:
				buffer = serialize([response.type, response.id], response.data);
				break;
		}

		this.sendRawMessage(buffer);
	}

	private sendRawMessage(message: Buffer) {
		try {
			this.protocol.send(message);
		} catch (err) {
			// noop
		}
	}

	public dispose(): void {
		this.protocolListener.dispose();
		this.protocolListener = null;

		Object.keys(this.activeRequests).forEach(id => {
			this.activeRequests[<any>id].dispose();
		});

		this.activeRequests = null;
	}
}

export class ChannelClient implements IChannelClient, IDisposable {

	private state: State = State.Uninitialized;
	private activeRequests: IDisposable[] = [];
	private bufferedRequests: IRequest[] = [];
	private handlers: { [id: number]: IHandler; } = Object.create(null);
	private lastRequestId: number = 0;
	private protocolListener: IDisposable;

	private _onDidInitialize = new Emitter<void>();
	readonly onDidInitialize = this._onDidInitialize.event;

	constructor(private protocol: IMessagePassingProtocol) {
		this.protocolListener = this.protocol.onMessage(msg => this.onRawMessage(msg));
	}

	getChannel<T extends IChannel>(channelName: string): T {
		const call = (command: string, arg: any) => this.requestPromise(channelName, command, arg);
		const listen = (event: string, arg: any) => this.requestEvent(channelName, event, arg);

		return { call, listen } as T;
	}

	private requestPromise(channelName: string, name: string, arg: any): TPromise<any> {
		const id = this.lastRequestId++;
		const type = RequestType.Promise;
		const request: IRequest = { raw: { id, type, channelName, name, arg } };

		const activeRequest = this.state === State.Uninitialized
			? this.bufferRequest(request)
			: this.doRequest(request);

		const disposable = toDisposable(() => activeRequest.cancel());
		this.activeRequests.push(disposable);

		activeRequest
			.then(null, _ => null)
			.done(() => this.activeRequests = this.activeRequests.filter(el => el !== disposable));

		return activeRequest;
	}

	private requestEvent(channelName: string, name: string, arg: any): Event<any> {
		const id = this.lastRequestId++;
		const type = RequestType.EventListen;
		const raw: IRawRequest = { id, type, channelName, name, arg };
		const request: IRequest = { raw };

		let uninitializedPromise: TPromise<any> | null = null;
		const emitter = new Emitter<any>({
			onFirstListenerAdd: () => {
				uninitializedPromise = this.whenInitialized();
				uninitializedPromise.then(() => {
					uninitializedPromise = null;
					this.sendRequest(request.raw);
				});
			},
			onLastListenerRemove: () => {
				if (uninitializedPromise) {
					uninitializedPromise.cancel();
					uninitializedPromise = null;
				} else {
					this.sendRequest({ id, type: RequestType.EventDispose });
				}
			}
		});

		this.handlers[id] = (response: IRawEventFireResponse) => emitter.fire(response.data);
		return emitter.event;
	}

	private doRequest(request: IRequest): Promise {
		const id = request.raw.id;

		return new TPromise((c, e) => {
			this.handlers[id] = response => {
				switch (response.type) {
					case ResponseType.PromiseSuccess:
						delete this.handlers[id];
						c(response.data);
						break;

					case ResponseType.PromiseError:
						delete this.handlers[id];
						const error = new Error(response.data.message);
						(<any>error).stack = response.data.stack;
						error.name = response.data.name;
						e(error);
						break;

					case ResponseType.PromiseErrorObj:
						delete this.handlers[id];
						e(response.data);
						break;
				}
			};

			this.sendRequest(request.raw);
		},
			() => this.sendRequest({ id, type: RequestType.PromiseCancel }));
	}

	private bufferRequest(request: IRequest): Promise {
		let flushedRequest: Promise = null;

		return new TPromise((c, e) => {
			this.bufferedRequests.push(request);

			request.flush = () => {
				request.flush = null;
				flushedRequest = this.doRequest(request).then(c, e);
			};
		}, () => {
			request.flush = null;

			if (this.state !== State.Uninitialized) {
				if (flushedRequest) {
					flushedRequest.cancel();
					flushedRequest = null;
				}

				return;
			}

			const idx = this.bufferedRequests.indexOf(request);

			if (idx === -1) {
				return;
			}

			this.bufferedRequests.splice(idx, 1);
		});
	}

	private onRawMessage(message: Buffer): void {
		const { header, body } = deserialize(message);
		const type: ResponseType = header[0];
		let response: IRawResponse;

		switch (type) {
			case ResponseType.Initialize:
				response = { type: header[0] };
				break;
			case ResponseType.PromiseSuccess:
			case ResponseType.PromiseError:
			case ResponseType.EventFire:
			case ResponseType.PromiseErrorObj:
				response = { type: header[0], id: header[1], data: body };
				break;
			default:
				return;
		}

		this.onResponse(response);
	}

	private onResponse(response: IRawResponse): void {
		if (response.type === ResponseType.Initialize) {
			this.state = State.Idle;
			this._onDidInitialize.fire();
			this.bufferedRequests.forEach(r => r.flush && r.flush());
			this.bufferedRequests = null;
			return;
		}

		const handler = this.handlers[response.id];
		if (handler) {
			handler(response);
		}
	}

	private sendRequest(request: IRawRequest) {
		let buffer: Buffer;

		switch (request.type) {
			case RequestType.Promise:
			case RequestType.EventListen:
				buffer = serialize([request.type, request.id, request.channelName, request.name], request.arg);
				break;
			case RequestType.PromiseCancel:
			case RequestType.EventDispose:
				buffer = serialize([request.type, request.id]);
				break;
		}

		this.sendRawMessage(buffer);
	}

	private sendRawMessage(message: Buffer) {
		try {
			this.protocol.send(message);
		} catch (err) {
			// noop
		}
	}

	private whenInitialized(): TPromise<void> {
		if (this.state === State.Idle) {
			return TPromise.as(null);
		} else {
			return TPromise.wrap(toPromise(this.onDidInitialize));
		}
	}

	dispose(): void {
		this.protocolListener.dispose();
		this.protocolListener = null;

		this.activeRequests = dispose(this.activeRequests);
	}
}

export interface ClientConnectionEvent {
	protocol: IMessagePassingProtocol;
	onDidClientDisconnect: Event<void>;
}

/**
 * An `IPCServer` is both a channel server and a routing channel
 * client.
 *
 * As the owner of a protocol, you should extend both this
 * and the `IPCClient` classes to get IPC implementations
 * for your protocol.
 */
export class IPCServer implements IChannelServer, IRoutingChannelClient, IDisposable {

	private channels: { [name: string]: IChannel } = Object.create(null);
	private channelClients: { [id: string]: ChannelClient; } = Object.create(null);
	private onClientAdded = new Emitter<string>();

	constructor(onDidClientConnect: Event<ClientConnectionEvent>) {
		onDidClientConnect(({ protocol, onDidClientDisconnect }) => {
			const onFirstMessage = once(protocol.onMessage);

			onFirstMessage(rawId => {
				const channelServer = new ChannelServer(protocol);
				const channelClient = new ChannelClient(protocol);

				Object.keys(this.channels)
					.forEach(name => channelServer.registerChannel(name, this.channels[name]));

				const id = rawId.toString();
				this.channelClients[id] = channelClient;
				this.onClientAdded.fire(id);

				onDidClientDisconnect(() => {
					channelServer.dispose();
					channelClient.dispose();
					delete this.channelClients[id];
				});
			});
		});
	}

	getChannel<T extends IChannel>(channelName: string, router: IClientRouter): T {
		const call = (command: string, arg: any) => {
			const channelPromise = router.routeCall(command, arg)
				.then(id => this.getClient(id))
				.then(client => client.getChannel(channelName));

			return getDelayedChannel(channelPromise)
				.call(command, arg);
		};

		const listen = (event: string, arg: any) => {
			const channelPromise = router.routeEvent(event, arg)
				.then(id => this.getClient(id))
				.then(client => client.getChannel(channelName));

			return getDelayedChannel(channelPromise)
				.listen(event, arg);
		};

		return { call, listen } as T;
	}

	registerChannel(channelName: string, channel: IChannel): void {
		this.channels[channelName] = channel;
	}

	private getClient(clientId: string): TPromise<IChannelClient> {
		if (!clientId) {
			return TPromise.wrapError(new Error('Client id should be provided'));
		}

		const client = this.channelClients[clientId];

		if (client) {
			return TPromise.as(client);
		}

		return new TPromise<IChannelClient>(c => {
			const onClient = once(filterEvent(this.onClientAdded.event, id => id === clientId));
			onClient(() => c(this.channelClients[clientId]));
		});
	}

	dispose(): void {
		this.channels = Object.create(null);
		this.channelClients = Object.create(null);
		this.onClientAdded.dispose();
	}
}

/**
 * An `IPCClient` is both a channel client and a channel server.
 *
 * As the owner of a protocol, you should extend both this
 * and the `IPCClient` classes to get IPC implementations
 * for your protocol.
 */
export class IPCClient implements IChannelClient, IChannelServer, IDisposable {

	private channelClient: ChannelClient;
	private channelServer: ChannelServer;

	constructor(protocol: IMessagePassingProtocol, id: string) {
		protocol.send(Buffer.from(id));
		this.channelClient = new ChannelClient(protocol);
		this.channelServer = new ChannelServer(protocol);
	}

	getChannel<T extends IChannel>(channelName: string): T {
		return this.channelClient.getChannel(channelName) as T;
	}

	registerChannel(channelName: string, channel: IChannel): void {
		this.channelServer.registerChannel(channelName, channel);
	}

	dispose(): void {
		this.channelClient.dispose();
		this.channelClient = null;
		this.channelServer.dispose();
		this.channelServer = null;
	}
}

export function getDelayedChannel<T extends IChannel>(promise: TPromise<T>): T {
	const call = (command: string, arg: any) => promise.then(c => c.call(command, arg));
	const listen = (event: string, arg: any) => {
		const relay = new Relay<any>();
		promise.then(c => relay.input = c.listen(event, arg));
		return relay.event;
	};

	return { call, listen } as T;
}

export function getNextTickChannel<T extends IChannel>(channel: T): T {
	let didTick = false;

	const call = (command: string, arg: any) => {
		if (didTick) {
			return channel.call(command, arg);
		}

		return TPromise.timeout(0)
			.then(() => didTick = true)
			.then(() => channel.call(command, arg));
	};

	const listen = (event: string, arg: any): Event<any> => {
		if (didTick) {
			return channel.listen(event, arg);
		}

		const relay = new Relay();

		TPromise.timeout(0)
			.then(() => didTick = true)
			.then(() => relay.input = channel.listen(event, arg));

		return relay.event;
	};

	return { call, listen } as T;
}
