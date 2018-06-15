/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import 'vs/css!./media/review';
import { $ } from 'vs/base/browser/builder';
import { KeyCode, KeyMod } from 'vs/base/common/keyCodes';
import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import { ICodeEditor, IEditorMouseEvent, IViewZone } from 'vs/editor/browser/editorBrowser';
import { registerEditorContribution } from 'vs/editor/browser/editorExtensions';
import { ICodeEditorService } from 'vs/editor/browser/services/codeEditorService';
import { EmbeddedCodeEditorWidget } from 'vs/editor/browser/widget/embeddedCodeEditorWidget';
import { IEditorContribution } from 'vs/editor/common/editorCommon';
import * as modes from 'vs/editor/common/modes';
import { peekViewEditorBackground, peekViewResultsBackground, peekViewResultsSelectionBackground } from 'vs/editor/contrib/referenceSearch/referencesWidget';
import { IContextKey, IContextKeyService, RawContextKey } from 'vs/platform/contextkey/common/contextkey';
import { ServicesAccessor, IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { KeybindingsRegistry } from 'vs/platform/keybinding/common/keybindingsRegistry';
import { INotificationService } from 'vs/platform/notification/common/notification';
import { editorForeground } from 'vs/platform/theme/common/colorRegistry';
import { IThemeService, registerThemingParticipant } from 'vs/platform/theme/common/themeService';
import { CommentThreadCollapsibleState } from 'vs/workbench/api/node/extHostTypes';
import { ReviewModel } from 'vs/workbench/parts/comments/common/reviewModel';
import { CommentGlyphWidget } from 'vs/workbench/parts/comments/electron-browser/commentGlyphWidget';
import { ReviewZoneWidget, COMMENTEDITOR_DECORATION_KEY } from 'vs/workbench/parts/comments/electron-browser/commentThreadWidget';
import { ICommentService } from 'vs/workbench/parts/comments/electron-browser/commentService';
import { IModelService } from 'vs/editor/common/services/modelService';
import { IModeService } from 'vs/editor/common/services/modeService';

export const ctxReviewPanelVisible = new RawContextKey<boolean>('reviewPanelVisible', false);

export const ID = 'editor.contrib.review';

export class ReviewViewZone implements IViewZone {
	public readonly afterLineNumber: number;
	public readonly domNode: HTMLElement;
	private callback: (top: number) => void;

	constructor(afterLineNumber: number, onDomNodeTop: (top: number) => void) {
		this.afterLineNumber = afterLineNumber;
		this.callback = onDomNodeTop;

		this.domNode = $('.review-viewzone').getHTMLElement();
	}

	onDomNodeTop(top: number): void {
		this.callback(top);
	}
}

export class ReviewController implements IEditorContribution {
	private globalToDispose: IDisposable[];
	private localToDispose: IDisposable[];
	private editor: ICodeEditor;
	private _newCommentWidget: ReviewZoneWidget;
	private _commentWidgets: ReviewZoneWidget[];
	private _reviewPanelVisible: IContextKey<boolean>;
	private _commentInfos: modes.CommentInfo[];
	private _reviewModel: ReviewModel;
	private _newCommentGlyph: CommentGlyphWidget;
	private _hasSetComments: boolean;

	constructor(
		editor: ICodeEditor,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IThemeService private themeService: IThemeService,
		@ICommentService private commentService: ICommentService,
		@INotificationService private notificationService: INotificationService,
		@IInstantiationService private instantiationService: IInstantiationService,
		@IModeService private modeService: IModeService,
		@IModelService private modelService: IModelService,
		@ICodeEditorService private codeEditorService: ICodeEditorService,

	) {
		this.editor = editor;
		this.globalToDispose = [];
		this.localToDispose = [];
		this._commentInfos = [];
		this._commentWidgets = [];
		this._newCommentWidget = null;
		this._newCommentGlyph = null;
		this._hasSetComments = false;

		this._reviewPanelVisible = ctxReviewPanelVisible.bindTo(contextKeyService);
		this._reviewModel = new ReviewModel();

		this._reviewModel.onDidChangeStyle(style => {
			if (this._newCommentWidget) {
				this._newCommentWidget.dispose();
				this._newCommentWidget = null;
			}

			this._commentWidgets.forEach(zone => {
				zone.dispose();
			});

			this._commentInfos.forEach(info => {
				info.threads.forEach(thread => {
					let zoneWidget = new ReviewZoneWidget(this.instantiationService, this.modeService, this.modelService, this.themeService, this.commentService, this.editor, info.owner, thread, {});
					zoneWidget.display(thread.range.startLineNumber);
					this._commentWidgets.push(zoneWidget);
				});
			});
		});

		this.globalToDispose.push(this.commentService.onDidDeleteDataProvider(e => {
			// Remove new comment widget and glyph, refresh comments
			if (this._newCommentWidget) {
				this._newCommentWidget.dispose();
				this._newCommentWidget = null;
			}

			if (this._newCommentGlyph) {
				this.editor.removeContentWidget(this._newCommentGlyph);
				this._newCommentGlyph = null;
			}

			this.getComments();
		}));

		this.globalToDispose.push(this.commentService.onDidSetResourceCommentInfos(e => {
			const editorURI = this.editor && this.editor.getModel() && this.editor.getModel().uri;
			if (editorURI && editorURI.toString() === e.resource.toString()) {
				this.setComments(e.commentInfos.filter(commentInfo => commentInfo !== null));
			}
		}));

		this.globalToDispose.push(this.commentService.onDidSetDataProvider(_ => this.getComments()));

		this.globalToDispose.push(this.editor.onDidChangeModel(() => this.onModelChanged()));
		this.codeEditorService.registerDecorationType(COMMENTEDITOR_DECORATION_KEY, {});
	}

	private getComments(): void {
		const editorURI = this.editor && this.editor.getModel() && this.editor.getModel().uri;

		if (editorURI) {
			this.commentService.getComments(editorURI).then(commentInfos => {
				this.setComments(commentInfos.filter(commentInfo => commentInfo !== null));
			}, error => console.log(error));
		}
	}

	public static get(editor: ICodeEditor): ReviewController {
		return editor.getContribution<ReviewController>(ID);
	}

	public revealCommentThread(threadId: string, commentId?: string): void {
		const commentThreadWidget = this._commentWidgets.filter(widget => widget.commentThread.threadId === threadId);
		if (commentThreadWidget.length === 1) {
			commentThreadWidget[0].reveal(commentId);
		}
	}

	getId(): string {
		return ID;
	}

	dispose(): void {
		this.globalToDispose = dispose(this.globalToDispose);
		this.localToDispose = dispose(this.localToDispose);

		this._commentWidgets.forEach(widget => widget.dispose());

		if (this._newCommentWidget) {
			this._newCommentWidget.dispose();
			this._newCommentWidget = null;
		}
		this.editor = null;
	}

	public onModelChanged(): void {
		this.localToDispose = dispose(this.localToDispose);
		if (this._newCommentWidget) {
			// todo store view state.
			this._newCommentWidget.dispose();
			this._newCommentWidget = null;
		}

		if (this._newCommentGlyph) {
			this.editor.removeContentWidget(this._newCommentGlyph);
			this._newCommentGlyph = null;
		}

		this._commentWidgets.forEach(zone => {
			zone.dispose();
		});
		this._commentWidgets = [];

		this.localToDispose.push(this.editor.onMouseMove(e => this.onEditorMouseMove(e)));
		this.localToDispose.push(this.editor.onDidChangeModelContent(() => {
			if (this._newCommentGlyph) {
				this.editor.removeContentWidget(this._newCommentGlyph);
				this._newCommentGlyph = null;
			}
		}));
		this.localToDispose.push(this.commentService.onDidUpdateCommentThreads(e => {
			const editorURI = this.editor && this.editor.getModel() && this.editor.getModel().uri;
			if (!editorURI) {
				return;
			}
			let added = e.added.filter(thread => thread.resource.toString() === editorURI.toString());
			let removed = e.removed.filter(thread => thread.resource.toString() === editorURI.toString());
			let changed = e.changed.filter(thread => thread.resource.toString() === editorURI.toString());

			removed.forEach(thread => {
				let matchedZones = this._commentWidgets.filter(zoneWidget => zoneWidget.owner === e.owner && zoneWidget.commentThread.threadId === thread.threadId);
				if (matchedZones.length) {
					let matchedZone = matchedZones[0];
					let index = this._commentWidgets.indexOf(matchedZone);
					this._commentWidgets.splice(index, 1);
				}
			});

			changed.forEach(thread => {
				let matchedZones = this._commentWidgets.filter(zoneWidget => zoneWidget.owner === e.owner && zoneWidget.commentThread.threadId === thread.threadId);
				if (matchedZones.length) {
					let matchedZone = matchedZones[0];
					matchedZone.update(thread);
				}
			});
			added.forEach(thread => {
				let zoneWidget = new ReviewZoneWidget(this.instantiationService, this.modeService, this.modelService, this.themeService, this.commentService, this.editor, e.owner, thread, {});
				zoneWidget.display(thread.range.startLineNumber);
				this._commentWidgets.push(zoneWidget);
				this._commentInfos.filter(info => info.owner === e.owner)[0].threads.push(thread);
			});
		}));
	}

	private addComment(lineNumber: number) {
		let newCommentInfo = this.getNewCommentAction(lineNumber);
		if (!newCommentInfo) {
			return;
		}

		// add new comment
		this._reviewPanelVisible.set(true);
		const { replyCommand, ownerId } = newCommentInfo;
		this._newCommentWidget = new ReviewZoneWidget(this.instantiationService, this.modeService, this.modelService, this.themeService, this.commentService, this.editor, ownerId, {
			threadId: null,
			resource: null,
			comments: [],
			range: {
				startLineNumber: lineNumber,
				startColumn: 0,
				endLineNumber: lineNumber,
				endColumn: 0
			},
			reply: replyCommand,
			collapsibleState: CommentThreadCollapsibleState.Expanded,
		}, {});

		this._newCommentWidget.onDidClose(e => {
			this._newCommentWidget = null;
		});
		this._newCommentWidget.display(lineNumber);
	}

	private onEditorMouseMove(e: IEditorMouseEvent): void {
		if (!this._hasSetComments) {
			return;
		}

		const hasCommentingRanges = this._commentInfos.length && this._commentInfos.some(info => !!info.commentingRanges.length);
		if (hasCommentingRanges && e.target.position && e.target.position.lineNumber !== undefined) {
			if (this._newCommentGlyph && e.target.element.className !== 'comment-hint') {
				this.editor.removeContentWidget(this._newCommentGlyph);
			}

			const lineNumber = e.target.position.lineNumber;
			if (!this.isExistingCommentThreadAtLine(lineNumber)) {
				this._newCommentGlyph = this.isLineInCommentingRange(lineNumber)
					? this._newCommentGlyph = new CommentGlyphWidget('comment-hint', this.editor, lineNumber, false, () => {
						this.addComment(lineNumber);
					})
					: this._newCommentGlyph = new CommentGlyphWidget('comment-hint', this.editor, lineNumber, true, () => {
						this.notificationService.warn('Commenting is not supported outside of diff hunk areas.');
					});

				this.editor.layoutContentWidget(this._newCommentGlyph);
			}
		}
	}

	private getNewCommentAction(line: number): { replyCommand: modes.Command, ownerId: number } {
		for (let i = 0; i < this._commentInfos.length; i++) {
			const commentInfo = this._commentInfos[i];
			const lineWithinRange = commentInfo.commentingRanges.some(range =>
				range.startLineNumber <= line && line <= range.endLineNumber
			);

			if (lineWithinRange) {
				return {
					replyCommand: commentInfo.reply,
					ownerId: commentInfo.owner
				};
			}
		}

		return null;
	}

	private isLineInCommentingRange(line: number): boolean {
		return this._commentInfos.some(commentInfo => {
			return commentInfo.commentingRanges.some(range =>
				range.startLineNumber <= line && line <= range.endLineNumber
			);
		});
	}

	private isExistingCommentThreadAtLine(line: number): boolean {
		const existingThread = this._commentInfos.some(commentInfo => {
			return commentInfo.threads.some(thread =>
				thread.range.startLineNumber === line
			);
		});

		const existingNewComment = this._newCommentWidget && this._newCommentWidget.position && this._newCommentWidget.position.lineNumber === line;

		return existingThread || existingNewComment;
	}

	setComments(commentInfos: modes.CommentInfo[]): void {
		this._commentInfos = commentInfos;
		this._hasSetComments = true;

		// create viewzones
		this._commentWidgets.forEach(zone => {
			zone.dispose();
		});

		this._commentInfos.forEach(info => {
			info.threads.forEach(thread => {
				let zoneWidget = new ReviewZoneWidget(this.instantiationService, this.modeService, this.modelService, this.themeService, this.commentService, this.editor, info.owner, thread, {});
				zoneWidget.display(thread.range.startLineNumber);
				this._commentWidgets.push(zoneWidget);
			});
		});
	}


	public closeWidget(): void {
		this._reviewPanelVisible.reset();

		if (this._newCommentWidget) {
			this._newCommentWidget.dispose();
			this._newCommentWidget = null;
		}

		if (this._commentWidgets) {
			this._commentWidgets.forEach(widget => widget.hide());
		}

		this.editor.focus();
		this.editor.revealRangeInCenter(this.editor.getSelection());
	}
}

registerEditorContribution(ReviewController);


KeybindingsRegistry.registerCommandAndKeybindingRule({
	id: 'closeReviewPanel',
	weight: KeybindingsRegistry.WEIGHT.editorContrib(),
	primary: KeyCode.Escape,
	secondary: [KeyMod.Shift | KeyCode.Escape],
	when: ctxReviewPanelVisible,
	handler: closeReviewPanel
});

export function getOuterEditor(accessor: ServicesAccessor): ICodeEditor {
	let editor = accessor.get(ICodeEditorService).getFocusedCodeEditor();
	if (editor instanceof EmbeddedCodeEditorWidget) {
		return editor.getParentEditor();
	}
	return editor;
}

function closeReviewPanel(accessor: ServicesAccessor, args: any) {
	var outerEditor = getOuterEditor(accessor);
	if (!outerEditor) {
		return;
	}

	let controller = ReviewController.get(outerEditor);

	if (!controller) {
		return;
	}

	controller.closeWidget();
}


registerThemingParticipant((theme, collector) => {
	let peekViewBackground = theme.getColor(peekViewResultsBackground);
	if (peekViewBackground) {
		collector.addRule(
			`.monaco-editor .review-widget,` +
			`.monaco-editor .review-widget {` +
			`	background-color: ${peekViewBackground};` +
			`}`);
	}

	let monacoEditorBackground = theme.getColor(peekViewEditorBackground);
	if (monacoEditorBackground) {
		collector.addRule(
			`.monaco-editor .review-widget .body .comment-form .review-thread-reply-button {` +
			`	background-color: ${monacoEditorBackground}` +
			`}`
		);
	}

	let monacoEditorForeground = theme.getColor(editorForeground);
	if (monacoEditorForeground) {
		collector.addRule(
			`.monaco-editor .review-widget .body .monaco-editor {` +
			`	color: ${monacoEditorForeground}` +
			`}` +
			`.monaco-editor .review-widget .body .comment-form .review-thread-reply-button {` +
			`	color: ${monacoEditorForeground}` +
			`}`
		);
	}

	let selectionBackground = theme.getColor(peekViewResultsSelectionBackground);

	if (selectionBackground) {
		collector.addRule(
			`@keyframes monaco-review-widget-focus {` +
			`	0% { background: ${selectionBackground}; }` +
			`	100% { background: transparent; }` +
			`}` +
			`.monaco-editor .review-widget .body .review-comment.focus {` +
			`	animation: monaco-review-widget-focus 3s ease 0s;` +
			`}`
		);
	}
});
