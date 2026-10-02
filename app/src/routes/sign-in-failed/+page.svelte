<script lang="ts">
	import NoticePage from '#lib/components/notice/NoticePage.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
</script>

<NoticePage title="Sign-in failed" description="We could not sign you in to the admin view.">
	{#snippet actions()}<Button href="/login" data-sveltekit-reload>Sign in again</Button>{/snippet}
</NoticePage>
