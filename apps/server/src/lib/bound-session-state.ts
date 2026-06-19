import type { BoundSession } from '@agent-console/shared';

const treeVisibleBoundSessionStatuses = new Set<BoundSession['status']>([
  'starting',
  'bound',
  'releasing',
]);

export function isTreeVisibleBoundSession(session: BoundSession): boolean {
  return session.shouldRestore === true && treeVisibleBoundSessionStatuses.has(session.status);
}

export function treeVisibleBoundSessionSql(alias: string): string {
  return `${alias}.should_restore = 1 and ${alias}.status in ('starting', 'bound', 'releasing')`;
}
