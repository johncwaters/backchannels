function base64UrlEncode(bytes: Uint8Array): string {
	const binary = String.fromCharCode(...bytes);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function randomBase64Url(byteLength: number): string {
	return base64UrlEncode(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function codeChallengeFor(codeVerifier: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
	return base64UrlEncode(new Uint8Array(digest));
}
