/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { DocumentSymbolProviderRegistry, DocumentSymbolProvider, DocumentSymbol } from 'vs/editor/common/modes';
import { ITextModel } from 'vs/editor/common/model';
import { asWinJsPromise } from 'vs/base/common/async';
import { TPromise } from 'vs/base/common/winjs.base';
import { fuzzyScore, FuzzyScore } from 'vs/base/common/filters';
import { IPosition } from 'vs/editor/common/core/position';
import { Range, IRange } from 'vs/editor/common/core/range';
import { first, size } from 'vs/base/common/collections';
import { isFalsyOrEmpty, binarySearch } from 'vs/base/common/arrays';
import { commonPrefixLength } from 'vs/base/common/strings';
import { IMarker, MarkerSeverity } from 'vs/platform/markers/common/markers';
import { onUnexpectedExternalError } from 'vs/base/common/errors';

export abstract class TreeElement {
	abstract id: string;
	abstract children: { [id: string]: TreeElement };
	abstract parent: TreeElement | any;

	static findId(candidate: DocumentSymbol | string, container: TreeElement): string {
		// complex id-computation which contains the origin/extension,
		// the parent path, and some dedupe logic when names collide
		let candidateId: string;
		if (typeof candidate === 'string') {
			candidateId = `${container.id}/${candidate}`;
		} else {
			candidateId = `${container.id}/${candidate.name}`;
			if (container.children[candidateId] !== void 0) {
				candidateId = `${container.id}/${candidate.name}_${candidate.fullRange.startLineNumber}_${candidate.fullRange.startColumn}`;
			}
		}

		let id = candidateId;
		for (let i = 0; container.children[id] !== void 0; i++) {
			id = `${candidateId}_${i}`;
		}

		return id;
	}

	static getElementById(id: string, element: TreeElement): TreeElement {
		if (!id) {
			return undefined;
		}
		let len = commonPrefixLength(id, element.id);
		if (len === id.length) {
			return element;
		}
		if (len < element.id.length) {
			return undefined;
		}
		for (const key in element.children) {
			let candidate = TreeElement.getElementById(id, element.children[key]);
			if (candidate) {
				return candidate;
			}
		}
		return undefined;
	}

	static size(element: TreeElement): number {
		let res = 1;
		for (const key in element.children) {
			res += TreeElement.size(element.children[key]);
		}
		return res;
	}
}

export class OutlineElement extends TreeElement {

	children: { [id: string]: OutlineElement; } = Object.create(null);
	score: FuzzyScore = [0, []];
	marker: { count: number, topSev: MarkerSeverity };

	constructor(
		readonly id: string,
		public parent: OutlineModel | OutlineGroup | OutlineElement,
		readonly symbol: DocumentSymbol
	) {
		super();
	}
}

export class OutlineGroup extends TreeElement {

	children: { [id: string]: OutlineElement; } = Object.create(null);

	constructor(
		readonly id: string,
		public parent: OutlineModel,
		readonly provider: DocumentSymbolProvider,
		readonly providerIndex: number,
	) {
		super();
	}

	updateMatches(pattern: string, topMatch: OutlineElement): OutlineElement {
		for (const key in this.children) {
			topMatch = this._updateMatches(pattern, this.children[key], topMatch);
		}
		return topMatch;
	}

	private _updateMatches(pattern: string, item: OutlineElement, topMatch: OutlineElement): OutlineElement {
		item.score = fuzzyScore(pattern, item.symbol.name, undefined, true);
		if (item.score && (!topMatch || item.score[0] > topMatch.score[0])) {
			topMatch = item;
		}
		for (const key in item.children) {
			let child = item.children[key];
			topMatch = this._updateMatches(pattern, child, topMatch);
			if (!item.score && child.score) {
				// don't filter parents with unfiltered children
				item.score = [0, []];
			}
		}
		return topMatch;
	}

	getItemEnclosingPosition(position: IPosition): OutlineElement {
		return this._getItemEnclosingPosition(position, this.children);
	}

	private _getItemEnclosingPosition(position: IPosition, children: { [id: string]: OutlineElement }): OutlineElement {
		for (let key in children) {
			let item = children[key];
			if (!Range.containsPosition(item.symbol.fullRange, position)) {
				continue;
			}
			return this._getItemEnclosingPosition(position, item.children) || item;
		}
		return undefined;
	}

	updateMarker(marker: IMarker[]): void {
		for (const key in this.children) {
			this._updateMarker(marker, this.children[key]);
		}
	}

	private _updateMarker(markers: IMarker[], item: OutlineElement): void {

		item.marker = undefined;

		// find the proper start index to check for item/marker overlap.
		let idx = binarySearch<IRange>(markers, item.symbol.fullRange, Range.compareRangesUsingStarts);
		let start: number;
		if (idx < 0) {
			start = ~idx;
			if (start > 0 && Range.areIntersecting(markers[start - 1], item.symbol.fullRange)) {
				start -= 1;
			}
		} else {
			start = idx;
		}

		let myMarkers: IMarker[] = [];
		let myTopSev: MarkerSeverity;

		while (start < markers.length && Range.areIntersecting(markers[start], item.symbol.fullRange)) {
			// remove markers intersecting with this outline element
			// and store them in a 'private' array.
			let marker = markers.splice(start, 1)[0];
			myMarkers.push(marker);
			if (!myTopSev || marker.severity > myTopSev) {
				myTopSev = marker.severity;
			}
		}

		// Recurse into children and let them match markers that have matched
		// this outline element. This might remove markers from this element and
		// therefore we remember that we have had markers. That allows us to render
		// the dot, saying 'this element has children with markers'
		for (const key in item.children) {
			this._updateMarker(myMarkers, item.children[key]);
		}

		if (myTopSev) {
			item.marker = {
				count: myMarkers.length,
				topSev: myTopSev
			};
		}
	}
}

export class OutlineModel extends TreeElement {

	static create(textModel: ITextModel): TPromise<OutlineModel> {
		let result = new OutlineModel(textModel);
		let promises = DocumentSymbolProviderRegistry.ordered(textModel).map((provider, index) => {

			let id = TreeElement.findId(`provider_${index}`, result);
			let group = new OutlineGroup(id, result, provider, index);

			return asWinJsPromise(token => provider.provideDocumentSymbols(result.textModel, token)).then(result => {
				if (!isFalsyOrEmpty(result)) {
					for (const info of result) {
						OutlineModel._makeOutlineElement(info, group);
					}
				}
				return group;
			}, err => {
				onUnexpectedExternalError(err);
				return group;
			}).then(group => {
				result._groups[id] = group;
			});
		});

		return TPromise.join(promises).then(() => {

			let count = 0;
			for (const key in result._groups) {
				let group = result._groups[key];
				if (first(group.children) === undefined) { // empty
					delete result._groups[key];
				} else {
					count += 1;
				}
			}

			if (count !== 1) {
				//
				result.children = result._groups;

			} else {
				// adopt all elements of the first group
				let group = first(result._groups);
				for (let key in group.children) {
					let child = group.children[key];
					child.parent = result;
					result.children[child.id] = child;
				}
			}

			return result;
		});
	}

	private static _makeOutlineElement(info: DocumentSymbol, container: OutlineGroup | OutlineElement): void {
		let id = TreeElement.findId(info, container);
		let res = new OutlineElement(id, container, info);
		if (info.children) {
			for (const childInfo of info.children) {
				OutlineModel._makeOutlineElement(childInfo, res);
			}
		}
		container.children[res.id] = res;
	}

	static get(element: TreeElement): OutlineModel {
		while (element) {
			if (element instanceof OutlineModel) {
				return element;
			}
			element = element.parent;
		}
		return undefined;
	}

	readonly id = 'root';
	readonly parent = undefined;

	private _groups: { [id: string]: OutlineGroup; } = Object.create(null);
	children: { [id: string]: OutlineGroup | OutlineElement; } = Object.create(null);

	private constructor(readonly textModel: ITextModel) {
		super();
	}

	dispose(): void {

	}

	adopt(other: OutlineModel): boolean {
		if (this.textModel.uri.toString() !== other.textModel.uri.toString()) {
			return false;
		}
		if (size(this._groups) !== size(other._groups)) {
			return false;
		}
		this._groups = other._groups;
		this.children = other.children;
		return true;
	}

	updateMatches(pattern: string): OutlineElement {
		let topMatch: OutlineElement;
		for (const key in this._groups) {
			topMatch = this._groups[key].updateMatches(pattern, topMatch);
		}
		return topMatch;
	}

	getItemEnclosingPosition(position: IPosition): OutlineElement {
		for (const key in this._groups) {
			let result = this._groups[key].getItemEnclosingPosition(position);
			if (result) {
				return result;
			}
		}
		return undefined;
	}

	getItemById(id: string): TreeElement {
		return TreeElement.getElementById(id, this);
	}

	updateMarker(marker: IMarker[]): void {
		// sort markers by start range so that we can use
		// outline element starts for quicker look up
		marker.sort(Range.compareRangesUsingStarts);

		for (const key in this._groups) {
			this._groups[key].updateMarker(marker);
		}
	}
}
