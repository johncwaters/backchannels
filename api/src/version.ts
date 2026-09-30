export function deployedVersion(metadata: WorkerVersionMetadata): string {
  return metadata.tag || metadata.id.slice(0, 8);
}
