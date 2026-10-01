'use client'

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Project } from '@prisma/client'

// Lighter type for project list
export interface ProjectListItem {
  id: string
  userId: string
  name: string
  description: string | null
  projectKind: string
  targetDomain: string
  _count?: { targets: number; artifacts: number }
  targets?: Array<{ profile: unknown }>
  subdomainList?: string[]
  createdAt: string
  updatedAt: string
  user: {
    id: string
    name: string
    email: string
  }
}

// Full project type
export type FullProject = Project & {
  user: {
    id: string
    name: string
    email: string
  }
}

// Fetch all projects or filter by userId
async function fetchProjects(userId?: string): Promise<ProjectListItem[]> {
  const url = userId ? `/api/projects?userId=${userId}` : '/api/projects'
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error('Failed to fetch projects')
  }
  return response.json()
}

// Fetch a single project by ID
async function fetchProject(projectId: string): Promise<FullProject> {
  const response = await fetch(`/api/projects/${projectId}`)
  if (!response.ok) {
    throw new Error('Failed to fetch project')
  }
  return response.json()
}

// Create a new project
async function createProject(data: {
  userId: string
  name: string
  targetDomain?: string
  projectKind?: string
  roeFile?: File | null
  [key: string]: unknown
}): Promise<FullProject> {
  const { roeFile, ...projectData } = data

  let response: Response
  if (roeFile) {
    // Multipart: include the RoE document file
    const formData = new FormData()
    formData.append('data', JSON.stringify(projectData))
    formData.append('roeDocument', roeFile)
    response = await fetch('/api/projects', {
      method: 'POST',
      body: formData,
    })
  } else {
    response = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(projectData),
    })
  }

  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || 'Failed to create project')
  }
  return response.json()
}

// Update a project
async function updateProject(projectId: string, data: Partial<Project>): Promise<FullProject> {
  const response = await fetch(`/api/projects/${projectId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  })
  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || 'Failed to update project')
  }
  return response.json()
}

// Delete a project
async function deleteProject(projectId: string): Promise<void> {
  const response = await fetch(`/api/projects/${projectId}`, {
    method: 'DELETE'
  })
  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || 'Failed to delete project')
  }
}

// Hook to fetch all projects
export function useProjects(userId?: string) {
  return useQuery({
    queryKey: ['projects', userId],
    queryFn: () => fetchProjects(userId),
  })
}

// Hook to fetch a single project
export function useProjectById(projectId: string | null) {
  return useQuery({
    queryKey: ['project', projectId],
    queryFn: () => fetchProject(projectId!),
    enabled: !!projectId,
  })
}

// Hook for creating a project
export function useCreateProject() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: createProject,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] })
    }
  })
}

// Hook for updating a project
export function useUpdateProject() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ projectId, data }: { projectId: string; data: Partial<Project> }) =>
      updateProject(projectId, data),
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      queryClient.invalidateQueries({ queryKey: ['project', project.id] })
    }
  })
}

// Hook for deleting a project
export function useDeleteProject() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: deleteProject,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] })
    }
  })
}
