<script lang="ts">
  let { command }: { command: string } = $props();

  type CopyOutcome = 'idle' | 'copied' | 'failed';
  let copyOutcome: CopyOutcome = $state('idle');

  const statusByOutcome: Record<CopyOutcome, string> = {
    idle: '',
    copied: 'copied to clipboard',
    failed: 'clipboard blocked: select the line and copy it',
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
  <code><span class="prompt">$ </span>{command}</code>
  <button type="button" onclick={copyCommand}>Copy</button>
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
    font-size: 24px;
    font-weight: 600;
  }
  .prompt {
    color: var(--color-dim);
  }
  button {
    min-height: 44px;
    padding: 0 20px;
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
