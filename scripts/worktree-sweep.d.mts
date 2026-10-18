export const SUPPORTED_SCHEMA_VERSIONS: number[];
export const DEFAULT_COOLDOWN_HOURS: number;
export const SNAPSHOT_EXPIRY_DAYS: number;
export interface BranchResult {
  main: string; branch: string | null; sha?: string; committedAt?: string;
  state: string; action: 'none' | 'delete'; reason: string; witness?: { ref: string; sha: string } | null;
  outcome?: string; recovery?: string;
}
export interface WorktreeResult {
  path: string; main: string; branch?: string; state: string; action: 'none' | 'remove' | 'reclaim-cache'; reason: string;
  outcome?: string; recovery?: string; reclaimedBytes?: number; cacheRoots?: string[]; localFiles?: string[]; owner?: string;
}
export interface SweepReport {
  startedAt: string; apply: boolean; cooldownHours: number; usable: boolean; consoleState: string; processVisibility: string;
  worktrees: WorktreeResult[]; branches: BranchResult[]; restored: Array<{ path: string; outcome: string }>; file: string;
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
  onBranchDelete?: (branch: BranchResult, stage: 'checks' | 'transaction') => void;
  scratchRoots?: string[]; docker?: (args: string[]) => string;
}): SweepReport;
export function summarize(report: SweepReport): string;
export function classifyBranch(facts: {
  checkedOut: boolean; protected: string | null; activityMs: number; landedIn: string | null; pushedTo?: string | null; snapshot: boolean; committedAt: string;
}, now: number, cooldownMs: number, checkDeferred?: (facts: object) => { reflogOnly?: boolean; baseIn?: string | null }): { state: string; action: 'none' | 'delete'; reason: string };
export function processStart(pid: number): string;
export function realDocker(args: string[]): string;
