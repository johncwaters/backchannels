<script lang="ts">
  let { command, copyLabel = 'Copy install command', hasPrompt = true }: { command: string; copyLabel?: string; hasPrompt?: boolean } = $props();

  type CopyOutcome = 'idle' | 'copied' | 'failed';
  let copyOutcome: CopyOutcome = $state('idle');
  let showsCopiedMark = $state(false);
  let statusLine: HTMLSpanElement | undefined = $state();
  let copiedMarkTimer: ReturnType<typeof setTimeout> | undefined;

  const copiedMarkMs = 1600;
  const statusEntrance: Keyframe[] = [
    { opacity: 0, transform: 'translateX(-6px)' },
    { opacity: 1, transform: 'none' },
  ];
  const statusEntranceTiming: KeyframeAnimationOptions = { duration: 180, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' };

  const statusByOutcome: Record<CopyOutcome, string> = {
    idle: '',
    copied: 'on your clipboard',
    failed: 'clipboard blocked: select the line instead',
  };

  function announceOutcome(outcome: CopyOutcome) {
    copyOutcome = outcome;
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) statusLine?.animate(statusEntrance, statusEntranceTiming);
  }

  function showCopiedMark() {
    showsCopiedMark = true;
    clearTimeout(copiedMarkTimer);
    copiedMarkTimer = setTimeout(() => (showsCopiedMark = false), copiedMarkMs);
  }

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(command);
      announceOutcome('copied');
      showCopiedMark();
    } catch {
      announceOutcome('failed');
    }
  }
</script>

<div class="copy-command">
  <code>{#if hasPrompt}<span class="prompt">$</span>{/if}{command}</code>
  <button type="button" onclick={copyCommand} aria-label={copyLabel} title={copyLabel} data-copied={showsCopiedMark ? '' : undefined}>
    <svg class="copy-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="12" height="12" rx="1"></rect>
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"></path>
    </svg>
    <svg class="copied-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="square" aria-hidden="true">
      <path d="M4 12.5 9.5 18 20 6"></path>
    </svg>
  </button>
  <span role="status" class="status" data-outcome={copyOutcome} bind:this={statusLine}>{statusByOutcome[copyOutcome]}</span>
</div>

<style>
  .copy-command {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 16px;
  }
  code {
    min-width: 0;
    font-size: clamp(18px, 5vw, 24px);
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .prompt {
    margin-right: 0.6ch;
    color: var(--color-dim);
  }
  button {
    display: inline-grid;
    place-items: center;
    min-width: 44px;
    min-height: 44px;
    padding: 0;
    border: 0;
    background: var(--color-accent);
    color: var(--color-ground);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
    transition: background-color 140ms var(--ease-out-quint), transform 80ms var(--ease-out-quint);
  }
  button:hover {
    background: color-mix(in srgb, var(--color-accent) 82%, var(--color-text));
  }
  button:active {
    transform: translateY(1px);
  }
  button svg {
    grid-area: 1 / 1;
    transition: opacity 140ms var(--ease-out-quint), transform 200ms var(--ease-out-quint);
  }
  .copied-icon {
    opacity: 0;
    transform: scale(0.6);
  }
  button[data-copied] .copy-icon {
    opacity: 0;
    transform: scale(0.6);
  }
  button[data-copied] .copied-icon {
    opacity: 1;
    transform: none;
  }
  .status {
    color: var(--color-dim);
  }
  .status[data-outcome='copied'] {
    color: var(--color-success);
  }
  .status[data-outcome='failed'] {
    color: var(--color-danger);
  }
</style>
