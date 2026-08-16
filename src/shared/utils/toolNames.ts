/**
 * Whether a Claude tool call spawns a child agent process.
 */
export function isSpawnToolName(name: string): boolean {
  return name === 'Task' || name === 'Agent';
}
