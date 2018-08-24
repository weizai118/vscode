/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event, Emitter } from 'vs/base/common/event';
import { CONTEXT_EXPRESSION_SELECTED, IViewModel, IStackFrame, ISession, IThread, IExpression, IFunctionBreakpoint, CONTEXT_BREAKPOINT_SELECTED, CONTEXT_LOADED_SCRIPTS_SUPPORTED } from 'vs/workbench/parts/debug/common/debug';
import { IContextKeyService, IContextKey } from 'vs/platform/contextkey/common/contextkey';

export class ViewModel implements IViewModel {

	firstSessionStart = true;

	private _focusedStackFrame: IStackFrame;
	private _focusedSession: ISession;
	private _focusedThread: IThread;
	private selectedExpression: IExpression;
	private selectedFunctionBreakpoint: IFunctionBreakpoint;
	private readonly _onDidFocusSession: Emitter<ISession | undefined>;
	private readonly _onDidFocusStackFrame: Emitter<{ stackFrame: IStackFrame, explicit: boolean }>;
	private readonly _onDidSelectExpression: Emitter<IExpression>;
	private multiSessionView: boolean;
	private expressionSelectedContextKey: IContextKey<boolean>;
	private breakpointSelectedContextKey: IContextKey<boolean>;
	private loadedScriptsSupportedContextKey: IContextKey<boolean>;

	constructor(contextKeyService: IContextKeyService) {
		this._onDidFocusSession = new Emitter<ISession | undefined>();
		this._onDidFocusStackFrame = new Emitter<{ stackFrame: IStackFrame, explicit: boolean }>();
		this._onDidSelectExpression = new Emitter<IExpression>();
		this.multiSessionView = false;
		this.expressionSelectedContextKey = CONTEXT_EXPRESSION_SELECTED.bindTo(contextKeyService);
		this.breakpointSelectedContextKey = CONTEXT_BREAKPOINT_SELECTED.bindTo(contextKeyService);
		this.loadedScriptsSupportedContextKey = CONTEXT_LOADED_SCRIPTS_SUPPORTED.bindTo(contextKeyService);
	}

	getId(): string {
		return 'root';
	}

	get focusedSession(): ISession {
		return this._focusedSession;
	}

	get focusedThread(): IThread {
		if (this._focusedStackFrame) {
			return this._focusedStackFrame.thread;
		}
		if (this._focusedSession) {
			const threads = this._focusedSession.getAllThreads();
			if (threads && threads.length) {
				return threads[threads.length - 1];
			}
		}

		return undefined;
	}

	get focusedStackFrame(): IStackFrame {
		return this._focusedStackFrame;
	}

	setFocus(stackFrame: IStackFrame, thread: IThread, session: ISession, explicit: boolean): void {
		let shouldEmit = this._focusedSession !== session || this._focusedThread !== thread || this._focusedStackFrame !== stackFrame;

		if (this._focusedSession !== session) {
			this._focusedSession = session;
			this._onDidFocusSession.fire(session);
		}
		this._focusedThread = thread;
		this._focusedStackFrame = stackFrame;

		this.loadedScriptsSupportedContextKey.set(session && session.raw.capabilities.supportsLoadedSourcesRequest);

		if (shouldEmit) {
			this._onDidFocusStackFrame.fire({ stackFrame, explicit });
		}
	}

	get onDidFocusSession(): Event<ISession> {
		return this._onDidFocusSession.event;
	}

	get onDidFocusStackFrame(): Event<{ stackFrame: IStackFrame, explicit: boolean }> {
		return this._onDidFocusStackFrame.event;
	}

	getSelectedExpression(): IExpression {
		return this.selectedExpression;
	}

	setSelectedExpression(expression: IExpression) {
		this.selectedExpression = expression;
		this.expressionSelectedContextKey.set(!!expression);
		this._onDidSelectExpression.fire(expression);
	}

	get onDidSelectExpression(): Event<IExpression> {
		return this._onDidSelectExpression.event;
	}

	getSelectedFunctionBreakpoint(): IFunctionBreakpoint {
		return this.selectedFunctionBreakpoint;
	}

	setSelectedFunctionBreakpoint(functionBreakpoint: IFunctionBreakpoint): void {
		this.selectedFunctionBreakpoint = functionBreakpoint;
		this.breakpointSelectedContextKey.set(!!functionBreakpoint);
	}

	isMultiSessionView(): boolean {
		return this.multiSessionView;
	}

	setMultiSessionView(isMultiSessionView: boolean): void {
		this.multiSessionView = isMultiSessionView;
	}
}
