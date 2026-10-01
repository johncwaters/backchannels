const DEPLOY_RESET_MESSAGE = "Durable Object reset because its code was updated";

export class WorkspaceResetError extends Error {
  constructor() {
    super("Backchannels changed during a deploy; retry this call once.");
    this.name = "WorkspaceResetError";
  }
}

function isDeployReset(error: unknown): boolean {
  return error instanceof Error && error.message.includes(DEPLOY_RESET_MESSAGE);
}

export async function retryWorkspaceRead<T>(operation: () => Promise<T>, safeToRepeat: boolean): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isDeployReset(error)) throw error;
    if (!safeToRepeat) throw new WorkspaceResetError();
  }
  try {
    return await operation();
  } catch (error) {
    if (isDeployReset(error)) throw new WorkspaceResetError();
    throw error;
  }
}
