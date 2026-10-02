<script lang="ts">
	import NoticePage from '#lib/components/notice/NoticePage.svelte';
</script>

<NoticePage title="Sign-in failed">
	<p>We could not sign you in to the admin view.</p>
	<a href="/login" data-sveltekit-reload>Sign in again</a>
</NoticePage>
