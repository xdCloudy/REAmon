'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  GraphOverviewData,
  VulnerabilityData,
  AttackSurfaceData,
  ActivityData,
  AttackChainsData,
  PipelineStatusData,
} from '../types'
import type { SessionsData } from '@/lib/websocket-types'

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch ${url}`)
  return res.json()
}

export function useGraphOverview(projectId: string | null) {
  return useQuery({
    queryKey: ['insights', 'graph-overview', projectId],
    queryFn: () => fetchJson<GraphOverviewData>(`/api/analytics/graph-overview?projectId=${projectId}`),
    enabled: !!projectId,
    staleTime: 60_000,
  })
}

export function useVulnerabilities(projectId: string | null) {
  return useQuery({
    queryKey: ['insights', 'vulnerabilities', projectId],
    queryFn: () => fetchJson<VulnerabilityData>(`/api/analytics/vulnerabilities?projectId=${projectId}`),
    enabled: !!projectId,
    staleTime: 60_000,
  })
}

export function useAttackSurface(projectId: string | null) {
  return useQuery({
    queryKey: ['insights', 'attack-surface', projectId],
    queryFn: () => fetchJson<AttackSurfaceData>(`/api/analytics/attack-surface?projectId=${projectId}`),
    enabled: !!projectId,
    staleTime: 60_000,
  })
}

export function useActivity(projectId: string | null) {
  return useQuery({
    queryKey: ['insights', 'activity', projectId],
    queryFn: () => fetchJson<ActivityData>(`/api/analytics/activity?projectId=${projectId}`),
    enabled: !!projectId,
    staleTime: 60_000,
  })
}

export function useAttackChains(projectId: string | null) {
  return useQuery({
    queryKey: ['insights', 'attack-chains', projectId],
    queryFn: () => fetchJson<AttackChainsData>(`/api/analytics/attack-chains?projectId=${projectId}`),
    enabled: !!projectId,
    staleTime: 60_000,
  })
}

export function usePipelineStatus(projectId: string | null) {
  return useQuery({
    queryKey: ['insights', 'pipeline-status', projectId],
    queryFn: () => fetchJson<PipelineStatusData>(`/api/analytics/pipeline-status?projectId=${projectId}`),
    enabled: !!projectId,
    staleTime: 15_000,
  })
}

export function useActiveSessions(projectId: string | null) {
  return useQuery({
    queryKey: ['insights', 'sessions', projectId],
    queryFn: () => fetchJson<SessionsData>(`/api/agent/sessions?projectId=${encodeURIComponent(projectId || '')}`),
    enabled: !!projectId,
    staleTime: 10_000,
    refetchInterval: 15_000,
  })
}

export function useRefreshInsights() {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: ['insights'] })
}
