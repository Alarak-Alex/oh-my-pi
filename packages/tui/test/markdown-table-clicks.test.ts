import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { setTranscriptActionHandler, type TranscriptAction } from "../src/chat/transcript-actions";
import { Markdown } from "../src/components/markdown";
import { getMarkdownTheme, initTheme } from "../src/theme";
import { stripTerminalSequences, visibleWidth } from "../src/utils";

beforeAll(async () => {
	await initTheme(false);
});

afterEach(() => {
	setTranscriptActionHandler(undefined);
});

function controls(rows: readonly string[], label: string): { column: number; row: number }[] {
	const out: { column: number; row: number }[] = [];
	for (const [row, styled] of rows.entries()) {
		const text = stripTerminalSequences(styled);
		const at = text.indexOf(label);
		if (at >= 0) out.push({ column: visibleWidth(text.slice(0, at)), row });
	}
	return out;
}

describe("Markdown row table controls", () => {
	it("copies the selected table through its padded cell region and preserves cached output without leaking metadata", () => {
		const actions: TranscriptAction[] = [];
		setTranscriptActionHandler(action => actions.push(action));
		const first = "| Name | Value |\n| --- | --- |\n| A | a,b |";
		const second = "| Name | Value |\n| --- | --- |\n| β | a\\|b |";
		const source = `${first}\n\nBetween\n\n${second}`;
		const theme = getMarkdownTheme();
		const markdown = new Markdown(source, 2, 1, theme).setIgnoreTight(true);
		const rows = markdown.render(60);
		expect(rows.join("\n")).not.toContain("\x1b]omp-table-");
		expect(actions).toEqual([]);
		expect(markdown.render(60)).toBe(rows);
		const click = markdown.getInlineClickHandler(60)!;
		expect(markdown.getInlineClickHandler(60)).toBe(click);
		const tsv = controls(rows, "[Copy TSV]")[1]!;
		const csv = controls(rows, "[Copy CSV]")[0]!;
		const md = controls(rows, "[Copy Markdown]")[1]!;
		expect(click(tsv.column, tsv.row)).toBe(true);
		expect(click(csv.column + 2, csv.row)).toBe(true);
		expect(click(md.column, md.row)).toBe(true);
		expect(click(0, tsv.row)).toBe(false);
		expect(click(tsv.column, 0)).toBe(false);
		expect(click(Number.NaN, tsv.row)).toBe(false);
		expect(actions).toEqual([
			{ act: "copy", text: "Name\tValue\nβ\ta|b" },
			{ act: "copy", text: 'Name,Value\nA,"a,b"' },
			{ act: "copy", text: second },
		]);
		const restored = new Markdown(source, 2, 1, theme).setIgnoreTight(true);
		const restoredRows = restored.render(60);
		expect(restoredRows).toEqual(rows);
		expect(restoredRows.join("\n")).not.toContain("\x1b]omp-table-");
		const restoredTarget = controls(restoredRows, "[Copy TSV]")[1]!;
		expect(restored.getInlineClickHandler(60)!(restoredTarget.column, restoredTarget.row)).toBe(true);
		expect(actions.at(-1)).toEqual({ act: "copy", text: "Name\tValue\nβ\ta|b" });
	});

	it("keeps nested table click columns aligned with quote and list prefixes", () => {
		const actions: TranscriptAction[] = [];
		setTranscriptActionHandler(action => actions.push(action));
		const source =
			"> | H | V |\n> | --- | --- |\n> | quote | one |\n\n7. Keep numbering\n\n   | H | V |\n   | --- | --- |\n   | list | two |";
		const markdown = new Markdown(source, 2, 1, getMarkdownTheme()).setIgnoreTight(true);
		const rows = markdown.render(60);
		const targets = controls(rows, "[Copy TSV]");
		const click = markdown.getInlineClickHandler(60)!;
		expect(targets).toHaveLength(2);
		expect(click(targets[0]!.column, targets[0]!.row)).toBe(true);
		expect(click(targets[1]!.column, targets[1]!.row)).toBe(true);
		expect(actions).toEqual([
			{ act: "copy", text: "H\tV\nquote\tone" },
			{ act: "copy", text: "H\tV\nlist\ttwo" },
		]);
		expect(rows.join("\n")).not.toContain("\x1b]omp-table-");
	});

	it("does not let fenced examples, copied labels, or untrusted marker syntax create controls", () => {
		const actions: TranscriptAction[] = [];
		setTranscriptActionHandler(action => actions.push(action));
		const example =
			"```text\n[Copy TSV] [Copy CSV] [Copy Markdown]\n\x1b]omp-table-untrusted;abc;tsv\x07[Copy TSV]\x1b]omp-table-untrusted;;\x07\n| Fake | Table |\n| --- | --- |\n| code | only |\n```";
		const source = `${example}\n\n| H |\n| --- |\n| real |`;
		const markdown = new Markdown(source, 0, 0, getMarkdownTheme());
		const rows = markdown.render(60);
		const targets = controls(rows, "[Copy TSV]");
		const click = markdown.getInlineClickHandler(60)!;
		expect(targets).toHaveLength(3);
		expect(click(targets[0]!.column, targets[0]!.row)).toBe(false);
		expect(click(targets[1]!.column, targets[1]!.row)).toBe(false);
		expect(actions).toEqual([]);
		expect(click(targets[2]!.column, targets[2]!.row)).toBe(true);
		expect(actions).toEqual([{ act: "copy", text: "H\nreal" }]);
		const onlyCode = new Markdown(example, 0, 0, getMarkdownTheme());
		onlyCode.render(60);
		expect(onlyCode.getInlineClickHandler(60)).toBeUndefined();
	});

	it("declines stale callbacks after resize, invalidation, replacement, and host removal while narrow controls remain usable", () => {
		const actions: TranscriptAction[] = [];
		setTranscriptActionHandler(action => actions.push(action));
		const source = "| H | V |\n| --- | --- |\n| one | two |";
		const markdown = new Markdown(source, 1, 0, getMarkdownTheme()).setIgnoreTight(true);
		const wide = markdown.render(60);
		const old = markdown.getInlineClickHandler(60)!;
		const oldTarget = controls(wide, "[Copy TSV]")[0]!;
		const narrow = markdown.render(14);
		expect(narrow.every(line => visibleWidth(line) <= 14)).toBe(true);
		expect(narrow.join("\n")).not.toContain("\x1b]omp-table-");
		expect(old(oldTarget.column, oldTarget.row)).toBe(false);
		expect(markdown.getInlineClickHandler(60)).toBeUndefined();
		const target = controls(narrow, "[Markdown]")[0]!;
		const click = markdown.getInlineClickHandler(14)!;
		expect(click(target.column, target.row)).toBe(true);
		expect(actions).toEqual([{ act: "copy", text: source }]);
		markdown.invalidate();
		expect(click(target.column, target.row)).toBe(false);
		expect(markdown.getInlineClickHandler(14)).toBeUndefined();
		markdown.render(14);
		const refreshed = markdown.getInlineClickHandler(14)!;
		markdown.setText("No table anymore");
		expect(refreshed(target.column, target.row)).toBe(false);
		markdown.render(14);
		expect(markdown.getInlineClickHandler(14)).toBeUndefined();
		markdown.setText(source);
		const restoredRows = markdown.render(60);
		const restored = markdown.getInlineClickHandler(60)!;
		const restoredTarget = controls(restoredRows, "[Copy CSV]")[0]!;
		setTranscriptActionHandler(undefined);
		expect(restored(restoredTarget.column, restoredTarget.row)).toBe(false);
		expect(markdown.render(60).join("\n")).not.toContain("[Copy");
		expect(actions).toHaveLength(1);
	});

	it("preserves original incomplete-cell data while streaming, including cached tables before a growing paragraph", () => {
		const actions: TranscriptAction[] = [];
		setTranscriptActionHandler(action => actions.push(action));
		const prefix = "| H | V |\n| --- | --- |\n| A | one |\n| B | **par";
		const markdown = new Markdown(prefix, 0, 0, getMarkdownTheme());
		markdown.transientRenderCache = true;
		const rows = markdown.render(60);
		const target = controls(rows, "[Copy TSV]")[0]!;
		const click = markdown.getInlineClickHandler(60)!;
		expect(actions).toEqual([]);
		expect(click(target.column, target.row)).toBe(true);
		expect(actions).toEqual([{ act: "copy", text: "H\tV\nA\tone\nB\t**par" }]);
		markdown.setText(`${prefix}tial** |\n\nA growing paragraph`);
		const next = markdown.render(60);
		expect(click(target.column, target.row)).toBe(false);
		const nextTarget = controls(next, "[Copy TSV]")[0]!;
		expect(markdown.getInlineClickHandler(60)!(nextTarget.column, nextTarget.row)).toBe(true);
		expect(actions.at(-1)).toEqual({ act: "copy", text: "H\tV\nA\tone\nB\tpartial" });
		markdown.setText(`${prefix}tial** |\n\nA growing paragraph with more`);
		const appended = markdown.render(60);
		expect(appended.join("\n")).not.toContain("\x1b]omp-table-");
		const appendedTarget = controls(appended, "[Copy CSV]")[0]!;
		expect(markdown.getInlineClickHandler(60)!(appendedTarget.column, appendedTarget.row)).toBe(true);
		expect(actions.at(-1)).toEqual({ act: "copy", text: "H,V\nA,one\nB,partial" });
		markdown.transientRenderCache = false;
		const final = markdown.render(60);
		const finalTarget = controls(final, "[Copy TSV]")[0]!;
		expect(markdown.getInlineClickHandler(60)!(finalTarget.column, finalTarget.row)).toBe(true);
		expect(actions.at(-1)).toEqual({ act: "copy", text: "H\tV\nA\tone\nB\tpartial" });
	});
});
