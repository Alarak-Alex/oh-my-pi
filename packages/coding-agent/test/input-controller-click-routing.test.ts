import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { PINNED_HUD_TOGGLE_ID } from "@oh-my-pi/pi-tui/prompt/composer";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { SpaceHoldGesture } from "@oh-my-pi/pi-tui/space-hold";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

import { cfgTuiMouse } from "@oh-my-pi/pi-coding-agent/modes/settings";

const ESC = String.fromCharCode(27);
// SGR click on viewport row 2 (1-based y=3): the pinned expander row when the
// candidates below resolve it to the toggle sentinel.
const EXPANDER_CLICK = `${ESC}[<0;5;3M`;

function makeHarness(
	options: { handled?: boolean; viewportTop?: number; viewportLength?: number; overlay?: boolean } = {},
) {
	const listeners: Array<(data: string) => { consume?: boolean; data?: string } | undefined> = [];
	const focused: string[] = [];
	const controls: { column: number; row: number }[] = [];
	let toggled = 0;
	const ctx = {
		ui: {
			addInputListener: (fn: (data: string) => { consume?: boolean; data?: string } | undefined) => {
				listeners.push(fn);
			},
			getMutableViewport: () => ({ top: options.viewportTop ?? 0, length: options.viewportLength ?? 5 }),
			hasOverlay: () => options.overlay ?? false,
			requestRender: () => {},
			addStartListener: () => {},
			getFocused: () => undefined,
		},
		handlesBtwBranchKey: () => false,
		editor: {
			getText: () => "",
			setActionKeys: () => {},
			setCustomKeyHandler: () => {},
			clearCustomKeyHandlers: () => {},
			spaceHold: new SpaceHoldGesture(() => {}),
		},
		keybindings: KeybindingsManager.inMemory(),
		settings,
		dictationSpaceHold: () => undefined,
		session: {
			extensionRunner: undefined,
		},
		resolveViewportClickCandidates: (index: number) => (index === 2 ? [PINNED_HUD_TOGGLE_ID] : []),
		activateViewportLink: () => false,
		handleViewportClick: (column: number, row: number) => {
			controls.push({ column, row });
			return options.handled ?? false;
		},
		focusedAgentId: undefined,
		focusAgentSession: async (id: string) => {
			focused.push(id);
		},
		togglePinnedHudExpanded: () => {
			toggled++;
		},
		showStatus: () => {},
		setClickHoverId: () => {},
	} as unknown as InteractiveModeContext;
	const controller = new InputController(ctx);
	controller.setupKeyHandlers();
	return {
		click: (data = EXPANDER_CLICK) => listeners.map(listener => listener(data)),
		focused,
		controls,
		toggled: () => toggled,
	};
}

describe("InputController click routing", () => {
	beforeEach(async () => {
		AgentRegistry.resetGlobalForTests();
		await Settings.init({ inMemory: true });
		cfgTuiMouse.set(settings, true);
	});

	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		resetSettingsForTest();
	});

	it("focuses a live agent whose id equals the toggle sentinel", () => {
		AgentRegistry.global().register({
			id: PINNED_HUD_TOGGLE_ID,
			displayName: "evil",
			kind: "sub",
			session: {} as unknown as AgentSession,
			sessionFile: null,
		});
		const h = makeHarness();
		h.click();
		expect(h.focused).toEqual([PINNED_HUD_TOGGLE_ID]);
		expect(h.toggled()).toBe(0);
	});

	it("toggles when no live agent matches the sentinel", () => {
		const h = makeHarness();
		h.click();
		expect(h.toggled()).toBe(1);
		expect(h.focused).toEqual([]);
	});

	it("routes local cell coordinates to controls before whole-row agent focus", () => {
		const h = makeHarness({ handled: true, viewportTop: 1 });
		h.click();
		expect(h.controls).toEqual([{ column: 4, row: 1 }]);
		expect(h.toggled()).toBe(0);
		expect(h.focused).toEqual([]);
	});

	it("preserves row focus when a control declines the click", () => {
		const h = makeHarness();
		h.click();
		expect(h.controls).toEqual([{ column: 4, row: 2 }]);
		expect(h.toggled()).toBe(1);
	});

	it("does not dispatch outside the published viewport or during a resize transaction", () => {
		for (const options of [{ viewportLength: 0 }, { viewportTop: 4 }, { viewportLength: 2 }]) {
			const h = makeHarness({ ...options, handled: true });
			h.click();
			expect(h.controls).toEqual([]);
			expect(h.toggled()).toBe(0);
		}
	});

	it("leaves mouse-off input and overlay-owned clicks alone", () => {
		const overlay = makeHarness({ handled: true, overlay: true });
		overlay.click();
		expect(overlay.controls).toEqual([]);
		cfgTuiMouse.set(settings, false);
		const off = makeHarness({ handled: true });
		expect(off.click().every(result => result?.consume !== true)).toBe(true);
		expect(off.controls).toEqual([]);
	});

	it("does not activate controls on pointer motion, release, or wheel reports", () => {
		const h = makeHarness({ handled: true });
		for (const data of [`${ESC}[<35;5;3M`, `${ESC}[<0;5;3m`, `${ESC}[<64;5;3M`]) h.click(data);
		expect(h.controls).toEqual([]);
	});
});
