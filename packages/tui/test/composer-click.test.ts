import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { Container, type Component } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";
import { routeViewportClick, type ViewportClickSpan } from "@oh-my-pi/pi-tui/prompt/composer";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { setTranscriptActionHandler, type TranscriptAction } from "@oh-my-pi/pi-tui/chat/transcript-actions";

function span(start: number, end: number, ids: string[]): ViewportClickSpan {
	return { start, end, candidates: () => ids };
}

describe("routeViewportClick", () => {
	it("returns the hit span's candidates with the span-local row", () => {
		let local = -1;
		const spans: ViewportClickSpan[] = [
			{
				start: 0,
				end: 2,
				candidates: row => {
					local = row;
					return ["CardAgent"];
				},
			},
			{ start: 3, end: 5, candidates: () => ["HudAgent"] },
		];
		expect(routeViewportClick(spans, 1)).toEqual(["CardAgent"]);
		expect(local).toBe(1);
		expect(routeViewportClick(spans, 4)).toEqual(["HudAgent"]);
	});

	it("misses separators, out-of-range rows, and non-integer indexes", () => {
		const spans = [span(0, 2, ["A"]), span(3, 4, ["B"])];
		expect(routeViewportClick(spans, 2)).toEqual([]);
		expect(routeViewportClick(spans, -1)).toEqual([]);
		expect(routeViewportClick(spans, Number.NaN)).toEqual([]);
		expect(routeViewportClick(spans, 99)).toEqual([]);
	});

	it("lets the first overlapping span win", () => {
		const spans = [span(0, 5, ["A"]), span(2, 4, ["B"])];
		expect(routeViewportClick(spans, 3)).toEqual(["A"]);
	});
});

class ClickableBlock implements Component {
	constructor(
		private readonly rows: readonly string[],
		private readonly ids: readonly string[],
	) {}
	isTranscriptBlockFinalized(): boolean {
		return false;
	}
	render(): readonly string[] {
		return this.rows;
	}
	getClickFocusAgentIds(): string[] {
		return [...this.ids];
	}
}

describe("composer hover band", () => {
	beforeAll(() => {
		initTheme();
	});

	it("bands only the hovered target's rows and clears byte-identically", () => {
		const term = new VirtualTerminal(80, 24);
		const composer = new Composer({ terminal: term, preferences: { ...COMPOSER_DEFAULTS, quiet: true } });
		composer.start();
		try {
			const transcript = new TranscriptContainer();
			transcript.addChild(new ClickableBlock(["card one", "card two"], ["AgentA"]));
			transcript.addChild(new ClickableBlock(["plain"], []));
			composer.setRuntimeChildren([transcript]);
			const plain = composer.renderFrame({ columns: 80, rows: 24 });
			expect(plain.viewport.join("\n")).not.toContain("\x1b[48");

			composer.setHoveredClickId("AgentA");
			const hovered = composer.renderFrame({ columns: 80, rows: 24 });
			const banded = hovered.viewport.filter(line => line.includes("\x1b[48"));
			expect(banded).toHaveLength(2);
			expect(Bun.stripANSI(banded.join("\n"))).toContain("card one");
			expect(Bun.stripANSI(banded.join("\n"))).toContain("card two");
			expect(hovered.viewport.filter(line => line.includes("plain") && line.includes("\x1b[48"))).toHaveLength(0);

			composer.setHoveredClickId("Nobody");
			expect(composer.renderFrame({ columns: 80, rows: 24 }).viewport).toEqual(plain.viewport);

			composer.setHoveredClickId(undefined);
			expect(composer.renderFrame({ columns: 80, rows: 24 }).viewport).toEqual(plain.viewport);
		} finally {
			composer.stop();
		}
	});

	it("drops nested background opens so the band wins tinted rows", () => {
		const term = new VirtualTerminal(80, 24);
		const composer = new Composer({ terminal: term, preferences: { ...COMPOSER_DEFAULTS, quiet: true } });
		composer.start();
		try {
			const esc = String.fromCharCode(27);
			const tinted = `${esc}[48;2;15;18;22mcard tinted${esc}[49m`;
			const transcript = new TranscriptContainer();
			transcript.addChild(new ClickableBlock([tinted], ["AgentT"]));
			composer.setRuntimeChildren([transcript]);
			composer.setHoveredClickId("AgentT");
			const hovered = composer.renderFrame({ columns: 80, rows: 24 });
			const banded = hovered.viewport.filter(line => line.includes("card tinted"));
			expect(banded).toHaveLength(1);
			expect(banded[0]).toContain(`${esc}[48`);
			expect(banded[0]).not.toContain("48;2;15;18;22");
		} finally {
			composer.stop();
		}
	});
});
class RowTarget implements Component {
	constructor(
		private readonly rows: readonly string[],
		private readonly ids: readonly string[],
	) {}
	render(): readonly string[] {
		return this.rows;
	}
	getClickAgentAtRow(row: number): string | undefined {
		return this.ids[row];
	}
}

describe("composer click-span clipping", () => {
	beforeAll(() => {
		initTheme();
	});

	it("offsets hit-testing past clipped viewport rows", () => {
		const term = new VirtualTerminal(80, 24);
		const composer = new Composer({ terminal: term, preferences: { ...COMPOSER_DEFAULTS, quiet: true } });
		composer.start();
		try {
			const transcript = new TranscriptContainer();
			const chrome = new Container();
			const ids = Array.from({ length: 10 }, (_, index) => `row${index}`);
			chrome.addChild(
				new RowTarget(
					ids.map(id => `line ${id}`),
					ids,
				),
			);
			composer.setRuntimeChildren([transcript, chrome]);

			// Ten chrome rows in a six-row viewport: the first four scroll off,
			// so viewport row 0 must hit-test as component row 4.
			const frame = composer.renderFrame({ columns: 80, rows: 6 });
			expect(frame.viewport).toHaveLength(6);
			expect(composer.viewportClickCandidates(0)).toEqual(["row4"]);
			expect(composer.viewportClickCandidates(5)).toEqual(["row9"]);
		} finally {
			composer.stop();
		}
	});
});

class CountingBlock implements Component {
	renders = 0;
	constructor(private readonly rows: readonly string[]) {}
	render(): readonly string[] {
		this.renders++;
		return this.rows;
	}
}

describe("composer chrome span recording", () => {
	beforeAll(() => {
		initTheme();
	});

	it("does not re-render chrome without click targets", () => {
		const term = new VirtualTerminal(80, 24);
		const composer = new Composer({ terminal: term, preferences: { ...COMPOSER_DEFAULTS, quiet: true } });
		composer.start();
		try {
			const transcript = new TranscriptContainer();
			const chrome = new Container();
			const first = new CountingBlock(["status one"]);
			const second = new CountingBlock(["status two"]);
			chrome.addChild(first);
			chrome.addChild(second);
			composer.setRuntimeChildren([transcript, chrome]);

			const frame = composer.renderFrame({ columns: 80, rows: 24 });
			expect(frame.viewport.join("\n")).toContain("status two");
			expect([first.renders, second.renders]).toEqual([1, 1]);
			expect(composer.viewportClickCandidates(0)).toEqual([]);
		} finally {
			composer.stop();
		}
	});

	it("renders target-bearing chrome children once per frame", () => {
		const term = new VirtualTerminal(80, 24);
		const composer = new Composer({ terminal: term, preferences: { ...COMPOSER_DEFAULTS, quiet: true } });
		composer.start();
		try {
			const transcript = new TranscriptContainer();
			const chrome = new Container();
			const first = new CountingBlock(["status one"]);
			const hud = new RowTarget(["hud row"], ["AgentH"]);
			chrome.addChild(first);
			chrome.addChild(hud);
			composer.setRuntimeChildren([transcript, chrome]);

			const frame = composer.renderFrame({ columns: 80, rows: 24 });
			const hudRow = frame.viewport.findIndex(line => line.includes("hud row"));
			expect(hudRow).toBeGreaterThanOrEqual(0);
			expect(composer.viewportClickCandidates(hudRow)).toEqual(["AgentH"]);
			expect(first.renders).toBe(1);
		} finally {
			composer.stop();
		}
	});
});

function tableMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function tableButton(rows: readonly string[], format: string, table = 0): { column: number; row: number } {
	const label = `[Copy ${format}]`;
	const matches: { column: number; row: number }[] = [];
	for (let row = 0; row < rows.length; row++) {
		const plain = Bun.stripANSI(rows[row]!);
		const index = plain.indexOf(label);
		if (index !== -1) matches.push({ column: Bun.stringWidth(plain.slice(0, index)) + 1, row });
	}
	expect(matches.length).toBeGreaterThan(table);
	return matches[table]!;
}

describe("composer classic table controls", () => {
	beforeAll(() => {
		initTheme();
	});
	afterEach(() => {
		setTranscriptActionHandler(undefined);
	});

	const firstTable = "| Name | Value |\n| --- | --- |\n| first | alpha |";
	const secondTable = "| Name | Value |\n| --- | --- |\n| second | beta |";

	it("copies each format from its own rendered assistant table, without acting during render", () => {
		const term = new VirtualTerminal(80, 40);
		const composer = new Composer({ terminal: term, preferences: { quiet: true } });
		const actions: TranscriptAction[] = [];
		setTranscriptActionHandler(action => actions.push(action));
		composer.start();
		try {
			const transcript = new TranscriptContainer();
			const assistant = new AssistantMessageComponent();
			assistant.updateContent(tableMessage(`Before\n\n${firstTable}\n\nBetween\n\n${secondTable}`));
			transcript.addChild(assistant);
			composer.setRuntimeChildren([transcript]);
			const frame = composer.renderFrame({ columns: 80, rows: 40 });
			expect(actions).toEqual([]);
			for (const [table, value] of ["first\talpha", "second\tbeta"].entries()) {
				for (const format of ["TSV", "CSV", "Markdown"]) {
					const point = tableButton(frame.viewport, format, table);
					expect(composer.handleViewportClick(point.column, point.row)).toBe(true);
					expect(actions.at(-1)).toEqual({
						act: "copy",
						text:
							format === "TSV"
								? `Name\tValue\n${value}`
								: format === "CSV"
									? `Name,Value\n${value.replace("\t", ",")}`
									: table === 0
										? firstTable
										: secondTable,
					});
				}
			}
			expect(actions).toHaveLength(6);
			expect(
				composer.handleViewportClick(
					0,
					frame.viewport.findIndex(row => row.includes("Before")),
				),
			).toBe(false);
			expect(actions).toHaveLength(6);
		} finally {
			composer.stop();
		}
	});

	it("maps a clipped table tail to its actual controls, not the block's old first rows", () => {
		const term = new VirtualTerminal(80, 5);
		const composer = new Composer({ terminal: term, preferences: { quiet: true } });
		const actions: TranscriptAction[] = [];
		setTranscriptActionHandler(action => actions.push(action));
		composer.start();
		try {
			const transcript = new TranscriptContainer();
			const assistant = new AssistantMessageComponent();
			assistant.updateContent(tableMessage(`Long introduction\n\n${firstTable}\n\n${secondTable}`));
			transcript.addChild(assistant);
			composer.setRuntimeChildren([transcript]);
			const frame = composer.renderFrame({ columns: 80, rows: 5 });
			const point = tableButton(frame.viewport, "TSV");
			expect(composer.handleViewportClick(point.column, point.row)).toBe(true);
			expect(actions).toEqual([{ act: "copy", text: "Name\tValue\nsecond\tbeta" }]);
		} finally {
			composer.stop();
		}
	});

	it("declines stale controls after a source update, resize, or transcript removal", () => {
		const term = new VirtualTerminal(80, 24);
		const composer = new Composer({ terminal: term, preferences: { quiet: true } });
		const actions: TranscriptAction[] = [];
		setTranscriptActionHandler(action => actions.push(action));
		composer.start();
		try {
			const transcript = new TranscriptContainer();
			const assistant = new AssistantMessageComponent();
			assistant.updateContent(tableMessage(firstTable));
			transcript.addChild(assistant);
			composer.setRuntimeChildren([transcript]);
			let frame = composer.renderFrame({ columns: 80, rows: 24 });
			let point = tableButton(frame.viewport, "TSV");
			assistant.updateContent(tableMessage(secondTable));
			expect(composer.handleViewportClick(point.column, point.row)).toBe(false);
			frame = composer.renderFrame({ columns: 80, rows: 24 });
			point = tableButton(frame.viewport, "TSV");
			term.resize(60, 24);
			expect(composer.handleViewportClick(point.column, point.row)).toBe(false);
			frame = composer.renderFrame({ columns: 60, rows: 24 });
			point = tableButton(frame.viewport, "TSV");
			transcript.clear();
			expect(composer.handleViewportClick(point.column, point.row)).toBe(false);
			expect(actions).toEqual([]);
		} finally {
			composer.stop();
		}
	});
});
