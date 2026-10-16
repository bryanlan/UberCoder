export const SUPPORTED_SCHEMA_VERSIONS: number[];
export const DEFAULT_COOLDOWN_HOURS: number;
export interface WorktreeResult {
  path: string; main: string; branch?: string; state: string; action: 'none' | 'remove' | 'reclaim-cache'; reason: string;
  outcome?: string; recovery?: string; reclaimedBytes?: number; cacheRoots?: string[]; localFiles?: string[]; owner?: string;
}
export interface SweepReport {
  startedAt: string; apply: boolean; cooldownHours: number; usable: boolean; consoleState: string; processVisibility: string;
  worktrees: WorktreeResult[]; restored: Array<{ path: string; outcome: string }>; file: string;
  scratch: Array<{ path: string; root: string; state: string; action: 'none' | 'reclaim-cache'; reason: string; outcome?: string; reclaimedBytes?: number }>;
  docker: {
    available: boolean; reason?: string;
    volumes: Array<{ name: string; createdAt: string; action: 'none' | 'remove'; reason: string; outcome?: string }>;
    buildCache?: { action: string; outcome?: string };
  };
}
export function runSweep(options?: {
  configPath?: string; reportDir?: string; apply?: boolean; repoFilter?: string[]; now?: number; cooldownHours?: number;
  onQuarantine?: (quarantinePath: string) => void;
  scratchRoots?: string[]; docker?: (args: string[]) => string;
}): SweepReport;
export function summarize(report: SweepReport): string;
export function processStart(pid: number): string;
export function realDocker(args: string[]): string;
