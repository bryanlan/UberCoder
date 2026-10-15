export const SUPPORTED_SCHEMA_VERSIONS: number[];
export const DEFAULT_COOLDOWN_HOURS: number;
export interface WorktreeResult {
  path: string; main: string; branch?: string; state: string; action: 'none' | 'remove' | 'reclaim-cache'; reason: string;
  outcome?: string; recovery?: string; reclaimedBytes?: number; cacheRoots?: string[]; localFiles?: string[]; owner?: string;
}
export interface SweepReport {
  startedAt: string; apply: boolean; cooldownHours: number; usable: boolean; consoleState: string; processVisibility: string;
  worktrees: WorktreeResult[]; restored: Array<{ path: string; outcome: string }>; file: string;
}
export function runSweep(options?: {
  configPath?: string; reportDir?: string; apply?: boolean; repoFilter?: string[]; now?: number; cooldownHours?: number;
  onQuarantine?: (quarantinePath: string) => void;
}): SweepReport;
export function summarize(report: SweepReport): string;
