import { defineParams } from '@sveltejs/kit/params';

// Paths that only the server answers. The client router must not match them to the not found page,
// so a link to them loads from the server: /login still starts sign-in from a stale tab.
const serverOnlyPath = /^(?:login|logout|callback|change-token)$|^c\/[^/]+\/(?:files|read|messages)(?:\/|$)/;

export const params = defineParams({
	unknownPath: (path: string) => (serverOnlyPath.test(path) ? undefined : path),
});
