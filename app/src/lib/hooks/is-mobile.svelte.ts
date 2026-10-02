import { MediaQuery } from "svelte/reactivity";

// Matches --breakpoint-md in styles/admin.css.
const DEFAULT_MOBILE_BREAKPOINT = 900;

export class IsMobile extends MediaQuery {
	constructor(breakpoint: number = DEFAULT_MOBILE_BREAKPOINT) {
		super(`max-width: ${breakpoint - 1}px`);
	}
}
