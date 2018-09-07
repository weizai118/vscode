/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as assert from 'assert';
import { Position } from 'vs/editor/common/core/position';
import { Selection } from 'vs/editor/common/core/selection';
import { withTestCodeEditor } from 'vs/editor/test/browser/testCodeEditor';
import {
	CursorWordLeft, CursorWordLeftSelect, CursorWordStartLeft,
	CursorWordEndLeft, CursorWordStartLeftSelect, CursorWordEndLeftSelect,
	CursorWordStartRight, CursorWordEndRight, CursorWordRight,
	CursorWordStartRightSelect, CursorWordEndRightSelect, CursorWordRightSelect,
	DeleteWordLeft, DeleteWordStartLeft, DeleteWordEndLeft,
	DeleteWordRight, DeleteWordStartRight, DeleteWordEndRight
} from 'vs/editor/contrib/wordOperations/wordOperations';
import { EditorCommand } from 'vs/editor/browser/editorExtensions';
import { ICodeEditor } from 'vs/editor/browser/editorBrowser';
import { deserializePipePositions, testRepeatedActionAndExtractPositions, serializePipePositions } from 'vs/editor/contrib/wordOperations/test/wordTestUtils';

suite('WordOperations', () => {

	const _cursorWordStartLeft = new CursorWordStartLeft();
	const _cursorWordEndLeft = new CursorWordEndLeft();
	const _cursorWordLeft = new CursorWordLeft();
	const _cursorWordStartLeftSelect = new CursorWordStartLeftSelect();
	const _cursorWordEndLeftSelect = new CursorWordEndLeftSelect();
	const _cursorWordLeftSelect = new CursorWordLeftSelect();
	const _cursorWordStartRight = new CursorWordStartRight();
	const _cursorWordEndRight = new CursorWordEndRight();
	const _cursorWordRight = new CursorWordRight();
	const _cursorWordStartRightSelect = new CursorWordStartRightSelect();
	const _cursorWordEndRightSelect = new CursorWordEndRightSelect();
	const _cursorWordRightSelect = new CursorWordRightSelect();
	const _deleteWordLeft = new DeleteWordLeft();
	const _deleteWordStartLeft = new DeleteWordStartLeft();
	const _deleteWordEndLeft = new DeleteWordEndLeft();
	const _deleteWordRight = new DeleteWordRight();
	const _deleteWordStartRight = new DeleteWordStartRight();
	const _deleteWordEndRight = new DeleteWordEndRight();

	function runEditorCommand(editor: ICodeEditor, command: EditorCommand): void {
		command.runEditorCommand(null, editor, null);
	}
	function moveWordLeft(editor: ICodeEditor, inSelectionMode: boolean = false): void {
		runEditorCommand(editor, inSelectionMode ? _cursorWordLeftSelect : _cursorWordLeft);
	}
	function moveWordStartLeft(editor: ICodeEditor, inSelectionMode: boolean = false): void {
		runEditorCommand(editor, inSelectionMode ? _cursorWordStartLeftSelect : _cursorWordStartLeft);
	}
	function moveWordEndLeft(editor: ICodeEditor, inSelectionMode: boolean = false): void {
		runEditorCommand(editor, inSelectionMode ? _cursorWordEndLeftSelect : _cursorWordEndLeft);
	}
	function moveWordRight(editor: ICodeEditor, inSelectionMode: boolean = false): void {
		runEditorCommand(editor, inSelectionMode ? _cursorWordRightSelect : _cursorWordRight);
	}
	function moveWordEndRight(editor: ICodeEditor, inSelectionMode: boolean = false): void {
		runEditorCommand(editor, inSelectionMode ? _cursorWordEndRightSelect : _cursorWordEndRight);
	}
	function moveWordStartRight(editor: ICodeEditor, inSelectionMode: boolean = false): void {
		runEditorCommand(editor, inSelectionMode ? _cursorWordStartRightSelect : _cursorWordStartRight);
	}
	function deleteWordLeft(editor: ICodeEditor): void {
		runEditorCommand(editor, _deleteWordLeft);
	}
	function deleteWordStartLeft(editor: ICodeEditor): void {
		runEditorCommand(editor, _deleteWordStartLeft);
	}
	function deleteWordEndLeft(editor: ICodeEditor): void {
		runEditorCommand(editor, _deleteWordEndLeft);
	}
	function deleteWordRight(editor: ICodeEditor): void {
		runEditorCommand(editor, _deleteWordRight);
	}
	function deleteWordStartRight(editor: ICodeEditor): void {
		runEditorCommand(editor, _deleteWordStartRight);
	}
	function deleteWordEndRight(editor: ICodeEditor): void {
		runEditorCommand(editor, _deleteWordEndRight);
	}

	test('move word left', () => {
		const EXPECTED = [
			'|    \t|My |First |Line\t ',
			'|\t|My |Second |Line',
			'|    |Third |Line🐶',
			'|',
			'|1',
		].join('\n');
		const [text,] = deserializePipePositions(EXPECTED);
		const actualStops = testRepeatedActionAndExtractPositions(
			text,
			new Position(1000, 1000),
			ed => moveWordLeft(ed),
			ed => ed.getPosition(),
			ed => ed.getPosition().equals(new Position(1, 1))
		);
		const actual = serializePipePositions(text, actualStops);
		assert.deepEqual(actual, EXPECTED);
	});

	test('move word left selection', () => {
		withTestCodeEditor([
			'    \tMy First Line\t ',
			'\tMy Second Line',
			'    Third Line🐶',
			'',
			'1',
		], {}, (editor, _) => {
			editor.setPosition(new Position(5, 2));
			moveWordLeft(editor, true);
			assert.deepEqual(editor.getSelection(), new Selection(5, 2, 5, 1));
		});
	});

	test('issue #832: moveWordLeft', () => {
		const EXPECTED = ['|   |/* |Just |some   |more   |text |a|+= |3 |+|5-|3 |+ |7 |*/  '].join('\n');
		const [text,] = deserializePipePositions(EXPECTED);
		const actualStops = testRepeatedActionAndExtractPositions(
			text,
			new Position(1000, 1000),
			ed => moveWordLeft(ed),
			ed => ed.getPosition(),
			ed => ed.getPosition().equals(new Position(1, 1))
		);
		const actual = serializePipePositions(text, actualStops);
		assert.deepEqual(actual, EXPECTED);
	});

	test('moveWordStartLeft', () => {
		const EXPECTED = ['|   |/* |Just |some   |more   |text |a|+= |3 |+|5-|3 |+ |7 |*/  '].join('\n');
		const [text,] = deserializePipePositions(EXPECTED);
		const actualStops = testRepeatedActionAndExtractPositions(
			text,
			new Position(1000, 1000),
			ed => moveWordStartLeft(ed),
			ed => ed.getPosition(),
			ed => ed.getPosition().equals(new Position(1, 1))
		);
		const actual = serializePipePositions(text, actualStops);
		assert.deepEqual(actual, EXPECTED);
	});

	test('moveWordEndLeft', () => {
		const EXPECTED = ['|   /*| Just| some|   more|   text| a|+=| 3| +|5|-|3| +| 7| */|  '].join('\n');
		const [text,] = deserializePipePositions(EXPECTED);
		const actualStops = testRepeatedActionAndExtractPositions(
			text,
			new Position(1000, 1000),
			ed => moveWordEndLeft(ed),
			ed => ed.getPosition(),
			ed => ed.getPosition().equals(new Position(1, 1))
		);
		const actual = serializePipePositions(text, actualStops);
		assert.deepEqual(actual, EXPECTED);
	});

	test('move word right', () => {
		const EXPECTED = [
			'    \tMy| First| Line|\t |',
			'\tMy| Second| Line|',
			'    Third| Line🐶|',
			'|',
			'1|',
		].join('\n');
		const [text,] = deserializePipePositions(EXPECTED);
		const actualStops = testRepeatedActionAndExtractPositions(
			text,
			new Position(1, 1),
			ed => moveWordRight(ed),
			ed => ed.getPosition(),
			ed => ed.getPosition().equals(new Position(5, 2))
		);
		const actual = serializePipePositions(text, actualStops);
		assert.deepEqual(actual, EXPECTED);
	});

	test('move word right selection', () => {
		withTestCodeEditor([
			'    \tMy First Line\t ',
			'\tMy Second Line',
			'    Third Line🐶',
			'',
			'1',
		], {}, (editor, _) => {
			editor.setPosition(new Position(1, 1));
			moveWordRight(editor, true);
			assert.deepEqual(editor.getSelection(), new Selection(1, 1, 1, 8));
		});
	});

	test('issue #832: moveWordRight', () => {
		const EXPECTED = [
			'   /*| Just| some|   more|   text| a|+=| 3| +5|-3| +| 7| */|  |',
		].join('\n');
		const [text,] = deserializePipePositions(EXPECTED);
		const actualStops = testRepeatedActionAndExtractPositions(
			text,
			new Position(1, 1),
			ed => moveWordRight(ed),
			ed => ed.getPosition(),
			ed => ed.getPosition().equals(new Position(1, 50))
		);
		const actual = serializePipePositions(text, actualStops);
		assert.deepEqual(actual, EXPECTED);
	});

	test('issue #41199: moveWordRight', () => {
		const EXPECTED = [
			'console|.log|(err|)|',
		].join('\n');
		const [text,] = deserializePipePositions(EXPECTED);
		const actualStops = testRepeatedActionAndExtractPositions(
			text,
			new Position(1, 1),
			ed => moveWordRight(ed),
			ed => ed.getPosition(),
			ed => ed.getPosition().equals(new Position(1, 17))
		);
		const actual = serializePipePositions(text, actualStops);
		assert.deepEqual(actual, EXPECTED);
	});

	test('issue #48046: Word selection doesn\'t work as usual', () => {
		const EXPECTED = [
			'|deep.|object.|property',
		].join('\n');
		const [text,] = deserializePipePositions(EXPECTED);
		const actualStops = testRepeatedActionAndExtractPositions(
			text,
			new Position(1, 21),
			ed => moveWordLeft(ed),
			ed => ed.getPosition(),
			ed => ed.getPosition().equals(new Position(1, 1))
		);
		const actual = serializePipePositions(text, actualStops);
		assert.deepEqual(actual, EXPECTED);
	});

	test('moveWordEndRight', () => {
		const EXPECTED = [
			'   /*| Just| some|   more|   text| a|+=| 3| +5|-3| +| 7| */|  |',
		].join('\n');
		const [text,] = deserializePipePositions(EXPECTED);
		const actualStops = testRepeatedActionAndExtractPositions(
			text,
			new Position(1, 1),
			ed => moveWordEndRight(ed),
			ed => ed.getPosition(),
			ed => ed.getPosition().equals(new Position(1, 50))
		);
		const actual = serializePipePositions(text, actualStops);
		assert.deepEqual(actual, EXPECTED);
	});

	test('moveWordStartRight', () => {
		const EXPECTED = [
			'   |/* |Just |some   |more   |text |a|+= |3 |+|5|-|3 |+ |7 |*/  |',
		].join('\n');
		const [text,] = deserializePipePositions(EXPECTED);
		const actualStops = testRepeatedActionAndExtractPositions(
			text,
			new Position(1, 1),
			ed => moveWordStartRight(ed),
			ed => ed.getPosition(),
			ed => ed.getPosition().equals(new Position(1, 50))
		);
		const actual = serializePipePositions(text, actualStops);
		assert.deepEqual(actual, EXPECTED);
	});

	test('delete word left for non-empty selection', () => {
		withTestCodeEditor([
			'    \tMy First Line\t ',
			'\tMy Second Line',
			'    Third Line🐶',
			'',
			'1',
		], {}, (editor, _) => {
			const model = editor.getModel();
			editor.setSelection(new Selection(3, 7, 3, 9));
			deleteWordLeft(editor);
			assert.equal(model.getLineContent(3), '    Thd Line🐶');
			assert.deepEqual(editor.getPosition(), new Position(3, 7));
		});
	});

	test('delete word left for cursor at beginning of document', () => {
		withTestCodeEditor([
			'    \tMy First Line\t ',
			'\tMy Second Line',
			'    Third Line🐶',
			'',
			'1',
		], {}, (editor, _) => {
			const model = editor.getModel();
			editor.setPosition(new Position(1, 1));
			deleteWordLeft(editor);
			assert.equal(model.getLineContent(1), '    \tMy First Line\t ');
			assert.deepEqual(editor.getPosition(), new Position(1, 1));
		});
	});

	test('delete word left for cursor at end of whitespace', () => {
		withTestCodeEditor([
			'    \tMy First Line\t ',
			'\tMy Second Line',
			'    Third Line🐶',
			'',
			'1',
		], {}, (editor, _) => {
			const model = editor.getModel();
			editor.setPosition(new Position(3, 11));
			deleteWordLeft(editor);
			assert.equal(model.getLineContent(3), '    Line🐶');
			assert.deepEqual(editor.getPosition(), new Position(3, 5));
		});
	});

	test('delete word left for cursor just behind a word', () => {
		withTestCodeEditor([
			'    \tMy First Line\t ',
			'\tMy Second Line',
			'    Third Line🐶',
			'',
			'1',
		], {}, (editor, _) => {
			const model = editor.getModel();
			editor.setPosition(new Position(2, 11));
			deleteWordLeft(editor);
			assert.equal(model.getLineContent(2), '\tMy  Line');
			assert.deepEqual(editor.getPosition(), new Position(2, 5));
		});
	});

	test('delete word left for cursor inside of a word', () => {
		withTestCodeEditor([
			'    \tMy First Line\t ',
			'\tMy Second Line',
			'    Third Line🐶',
			'',
			'1',
		], {}, (editor, _) => {
			const model = editor.getModel();
			editor.setPosition(new Position(1, 12));
			deleteWordLeft(editor);
			assert.equal(model.getLineContent(1), '    \tMy st Line\t ');
			assert.deepEqual(editor.getPosition(), new Position(1, 9));
		});
	});

	test('delete word right for non-empty selection', () => {
		withTestCodeEditor([
			'    \tMy First Line\t ',
			'\tMy Second Line',
			'    Third Line🐶',
			'',
			'1',
		], {}, (editor, _) => {
			const model = editor.getModel();
			editor.setSelection(new Selection(3, 7, 3, 9));
			deleteWordRight(editor);
			assert.equal(model.getLineContent(3), '    Thd Line🐶');
			assert.deepEqual(editor.getPosition(), new Position(3, 7));
		});
	});

	test('delete word right for cursor at end of document', () => {
		withTestCodeEditor([
			'    \tMy First Line\t ',
			'\tMy Second Line',
			'    Third Line🐶',
			'',
			'1',
		], {}, (editor, _) => {
			const model = editor.getModel();
			editor.setPosition(new Position(5, 3));
			deleteWordRight(editor);
			assert.equal(model.getLineContent(5), '1');
			assert.deepEqual(editor.getPosition(), new Position(5, 2));
		});
	});

	test('delete word right for cursor at beggining of whitespace', () => {
		withTestCodeEditor([
			'    \tMy First Line\t ',
			'\tMy Second Line',
			'    Third Line🐶',
			'',
			'1',
		], {}, (editor, _) => {
			const model = editor.getModel();
			editor.setPosition(new Position(3, 1));
			deleteWordRight(editor);
			assert.equal(model.getLineContent(3), 'Third Line🐶');
			assert.deepEqual(editor.getPosition(), new Position(3, 1));
		});
	});

	test('delete word right for cursor just before a word', () => {
		withTestCodeEditor([
			'    \tMy First Line\t ',
			'\tMy Second Line',
			'    Third Line🐶',
			'',
			'1',
		], {}, (editor, _) => {
			const model = editor.getModel();
			editor.setPosition(new Position(2, 5));
			deleteWordRight(editor);
			assert.equal(model.getLineContent(2), '\tMy  Line');
			assert.deepEqual(editor.getPosition(), new Position(2, 5));
		});
	});

	test('delete word right for cursor inside of a word', () => {
		withTestCodeEditor([
			'    \tMy First Line\t ',
			'\tMy Second Line',
			'    Third Line🐶',
			'',
			'1',
		], {}, (editor, _) => {
			const model = editor.getModel();
			editor.setPosition(new Position(1, 11));
			deleteWordRight(editor);
			assert.equal(model.getLineContent(1), '    \tMy Fi Line\t ');
			assert.deepEqual(editor.getPosition(), new Position(1, 11));
		});
	});

	test('issue #832: deleteWordLeft', () => {
		const EXPECTED = [
			'|   |/* |Just |some |text |a|+= |3 |+|5 |*/|  ',
		].join('\n');
		const [text,] = deserializePipePositions(EXPECTED);
		const actualStops = testRepeatedActionAndExtractPositions(
			text,
			new Position(1000, 10000),
			ed => deleteWordLeft(ed),
			ed => ed.getPosition(),
			ed => ed.getValue().length === 0
		);
		const actual = serializePipePositions(text, actualStops);
		assert.deepEqual(actual, EXPECTED);
	});

	test('deleteWordStartLeft', () => {
		const EXPECTED = [
			'|   |/* |Just |some |text |a|+= |3 |+|5 |*/  ',
		].join('\n');
		const [text,] = deserializePipePositions(EXPECTED);
		const actualStops = testRepeatedActionAndExtractPositions(
			text,
			new Position(1000, 10000),
			ed => deleteWordStartLeft(ed),
			ed => ed.getPosition(),
			ed => ed.getValue().length === 0
		);
		const actual = serializePipePositions(text, actualStops);
		assert.deepEqual(actual, EXPECTED);
	});

	test('deleteWordEndLeft', () => {
		const EXPECTED = [
			'|   /*| Just| some| text| a|+=| 3| +|5| */|  ',
		].join('\n');
		const [text,] = deserializePipePositions(EXPECTED);
		const actualStops = testRepeatedActionAndExtractPositions(
			text,
			new Position(1000, 10000),
			ed => deleteWordEndLeft(ed),
			ed => ed.getPosition(),
			ed => ed.getValue().length === 0
		);
		const actual = serializePipePositions(text, actualStops);
		assert.deepEqual(actual, EXPECTED);
	});

	test('issue #24947', () => {
		withTestCodeEditor([
			'{',
			'}'
		], {}, (editor, _) => {
			const model = editor.getModel();
			editor.setPosition(new Position(2, 1));
			deleteWordLeft(editor); assert.equal(model.getLineContent(1), '{}');
		});

		withTestCodeEditor([
			'{',
			'}'
		], {}, (editor, _) => {
			const model = editor.getModel();
			editor.setPosition(new Position(2, 1));
			deleteWordStartLeft(editor); assert.equal(model.getLineContent(1), '{}');
		});

		withTestCodeEditor([
			'{',
			'}'
		], {}, (editor, _) => {
			const model = editor.getModel();
			editor.setPosition(new Position(2, 1));
			deleteWordEndLeft(editor); assert.equal(model.getLineContent(1), '{}');
		});
	});

	test('issue #832: deleteWordRight', () => {
		const EXPECTED = '   |/*| Just| some| text| a|+=| 3| +|5|-|3| */|  |';
		const [text,] = deserializePipePositions(EXPECTED);
		const actualStops = testRepeatedActionAndExtractPositions(
			text,
			new Position(1, 1),
			ed => deleteWordRight(ed),
			ed => new Position(1, text.length - ed.getValue().length + 1),
			ed => ed.getValue().length === 0
		);
		const actual = serializePipePositions(text, actualStops);
		assert.deepEqual(actual, EXPECTED);
	});

	test('issue #3882: deleteWordRight', () => {
		withTestCodeEditor([
			'public void Add( int x,',
			'                 int y )'
		], {}, (editor, _) => {
			const model = editor.getModel();
			editor.setPosition(new Position(1, 24));
			deleteWordRight(editor); assert.equal(model.getLineContent(1), 'public void Add( int x,int y )', '001');
		});
	});

	test('issue #3882: deleteWordStartRight', () => {
		withTestCodeEditor([
			'public void Add( int x,',
			'                 int y )'
		], {}, (editor, _) => {
			const model = editor.getModel();
			editor.setPosition(new Position(1, 24));
			deleteWordStartRight(editor); assert.equal(model.getLineContent(1), 'public void Add( int x,int y )', '001');
		});
	});

	test('issue #3882: deleteWordEndRight', () => {
		withTestCodeEditor([
			'public void Add( int x,',
			'                 int y )'
		], {}, (editor, _) => {
			const model = editor.getModel();
			editor.setPosition(new Position(1, 24));
			deleteWordEndRight(editor); assert.equal(model.getLineContent(1), 'public void Add( int x,int y )', '001');
		});
	});

	test('deleteWordStartRight', () => {
		const EXPECTED = '   |/* |Just |some |text |a|+= |3 |+|5|-|3 |*/  |';
		const [text,] = deserializePipePositions(EXPECTED);
		const actualStops = testRepeatedActionAndExtractPositions(
			text,
			new Position(1, 1),
			ed => deleteWordStartRight(ed),
			ed => new Position(1, text.length - ed.getValue().length + 1),
			ed => ed.getValue().length === 0
		);
		const actual = serializePipePositions(text, actualStops);
		assert.deepEqual(actual, EXPECTED);
	});

	test('deleteWordEndRight', () => {
		const EXPECTED = '   /*| Just| some| text| a|+=| 3| +|5|-|3| */|  |';
		const [text,] = deserializePipePositions(EXPECTED);
		const actualStops = testRepeatedActionAndExtractPositions(
			text,
			new Position(1, 1),
			ed => deleteWordEndRight(ed),
			ed => new Position(1, text.length - ed.getValue().length + 1),
			ed => ed.getValue().length === 0
		);
		const actual = serializePipePositions(text, actualStops);
		assert.deepEqual(actual, EXPECTED);
	});

	test('issue #3882 (1): Ctrl+Delete removing entire line when used at the end of line', () => {
		withTestCodeEditor([
			'A line with text.',
			'   And another one'
		], {}, (editor, _) => {
			const model = editor.getModel();
			editor.setPosition(new Position(1, 18));
			deleteWordRight(editor); assert.equal(model.getLineContent(1), 'A line with text.And another one', '001');
		});
	});

	test('issue #3882 (2): Ctrl+Delete removing entire line when used at the end of line', () => {
		withTestCodeEditor([
			'A line with text.',
			'   And another one'
		], {}, (editor, _) => {
			const model = editor.getModel();
			editor.setPosition(new Position(2, 1));
			deleteWordLeft(editor); assert.equal(model.getLineContent(1), 'A line with text.   And another one', '001');
		});
	});
});
