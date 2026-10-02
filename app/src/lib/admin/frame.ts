import type { buildSidebarGroups } from './helpers';
import type { Scope, Viewer } from './types';

export type SidebarGroup = ReturnType<typeof buildSidebarGroups>[number];

// What every signed-in page shows around its content: the viewer, the sidebar and the footer versions.
export interface AdminFrame {
	viewer: Viewer;
	changeToken: string;
	versions: { web: string; mcp: string };
	nowMs: number;
	scope: Scope;
	sidebarGroups: SidebarGroup[];
}
