import { useEffect, useState } from 'react';

type ChatFilters = { workMode: boolean; recentActivity: boolean; activeOnly: boolean };
const keys = {
  workMode: 'agent-console:work-mode',
  recentActivity: 'agent-console:recent-activity',
  activeOnly: 'agent-console:active-only',
};

function readFilters(): ChatFilters {
  try {
    const workMode = localStorage.getItem(keys.workMode) !== 'false';
    const recentActivity = workMode && localStorage.getItem(keys.recentActivity) === 'true';
    return { workMode, recentActivity, activeOnly: workMode && !recentActivity && localStorage.getItem(keys.activeOnly) === 'true' };
  } catch {
    return { workMode: true, recentActivity: false, activeOnly: false };
  }
}

export function useChatFilters() {
  const [filters, setFilters] = useState(readFilters);
  useEffect(() => {
    try {
      for (const key of Object.keys(keys) as Array<keyof ChatFilters>) {
        localStorage.setItem(keys[key], String(filters[key]));
      }
    } catch { /* Keep filters usable when browser storage is unavailable. */ }
  }, [filters]);
  function toggleFilter(key: keyof ChatFilters) {
    setFilters(current => {
      if (key === 'workMode') return { workMode: !current.workMode, recentActivity: false, activeOnly: false };
      if (!current.workMode) return current;
      return { ...current, [key]: !current[key], [key === 'recentActivity' ? 'activeOnly' : 'recentActivity']: false };
    });
  }
  return { ...filters, toggleFilter };
}
