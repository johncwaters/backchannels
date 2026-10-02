// Where the signed-in app lives. Set PUBLIC_APP_URL for local development, for example http://localhost:4322.
export const appUrl: string = import.meta.env.PUBLIC_APP_URL ?? 'https://app.backchannels.dev';

// The admin view moved from /admin on this site to the root of the app host, so old links keep working.
export function appLocationFor(url: URL): string {
	const appPath = url.pathname.replace(/^\/admin(?=\/|$)/, '') || '/';
	return new URL(`${appPath}${url.search}`, appUrl).href;
}
