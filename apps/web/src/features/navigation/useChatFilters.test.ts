import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it } from 'vitest';
import { useChatFilters } from './useChatFilters';

beforeEach(() => localStorage.clear());

it('makes the subfilters exclusive, clears them with Work Mode, and remembers the result', () => {
  const { result, unmount } = renderHook(useChatFilters);
  act(() => result.current.toggleFilter('recentActivity'));
  expect(result.current).toMatchObject({ workMode: true, recentActivity: true, activeOnly: false });
  act(() => result.current.toggleFilter('activeOnly'));
  expect(result.current).toMatchObject({ workMode: true, recentActivity: false, activeOnly: true });
  act(() => result.current.toggleFilter('recentActivity'));
  expect(result.current.activeOnly).toBe(false);
  act(() => result.current.toggleFilter('workMode'));
  expect(result.current).toMatchObject({ workMode: false, recentActivity: false, activeOnly: false });
  act(() => result.current.toggleFilter('activeOnly'));
  expect(result.current.activeOnly).toBe(false);
  unmount();
  const restored = renderHook(useChatFilters);
  expect(restored.result.current).toMatchObject({ workMode: false, recentActivity: false, activeOnly: false });
  act(() => restored.result.current.toggleFilter('workMode'));
  expect(restored.result.current).toMatchObject({ workMode: true, recentActivity: false, activeOnly: false });
});

it.each([true, false])('normalizes contradictory saved filters with Work Mode %s', (workMode) => {
  localStorage.setItem('agent-console:work-mode', String(workMode));
  localStorage.setItem('agent-console:recent-activity', 'true');
  localStorage.setItem('agent-console:active-only', 'true');
  const { result } = renderHook(useChatFilters);
  expect(result.current).toMatchObject({ workMode, recentActivity: workMode, activeOnly: false });
  expect(localStorage.getItem('agent-console:active-only')).toBe('false');
});
