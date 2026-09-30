<script lang="ts">
  let { command, copyLabel = 'Copy install command', hasPrompt = true }: { command: string; copyLabel?: string; hasPrompt?: boolean } = $props();

  type CopyOutcome = 'idle' | 'copied' | 'failed';
  let copyOutcome: CopyOutcome = $state('idle');

  const statusByOutcome: Record<CopyOutcome, string> = {
    idle: '',
    copied: 'on your clipboard',
    failed: 'clipboard blocked: select the line instead',
  };

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(command);
      copyOutcome = 'copied';
    } catch {
      copyOutcome = 'failed';
    }
  }
</script>

<div class="copy-command">
  <code>{#if hasPrompt}<span class="prompt">$</span>{/if}{command}</code>
  <button type="button" onclick={copyCommand} aria-label={copyLabel} title={copyLabel}>
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="12" height="12" rx="1"></rect>
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"></path>
    </svg>
  </button>
  <span role="status" class="status" data-outcome={copyOutcome}>{statusByOutcome[copyOutcome]}</span>
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
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 44px;
    min-height: 44px;
    padding: 0;
    border: 0;
    background: var(--color-accent);
    color: var(--color-ground);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
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
