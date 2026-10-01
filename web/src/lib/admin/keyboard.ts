document.addEventListener('keydown', (event) => {
	if (event.key !== '/' || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
	if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable], [role="textbox"]')) return;
	const search = document.querySelector<HTMLInputElement>('.search-form input[type="search"]');
	if (!search) return;
	event.preventDefault();
	if (search.getClientRects().length === 0) {
		document.dispatchEvent(new CustomEvent('admin:open-navigation'));
		return;
	}
	search.focus();
	search.select();
});
