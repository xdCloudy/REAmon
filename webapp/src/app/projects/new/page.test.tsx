import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  user: null as null | { id: string; name: string; email: string; role: 'admin' | 'standard' },
  authLoading: false,
  projectLoading: false,
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }))
vi.mock('@/hooks/useProjects', () => ({ useCreateProject: () => ({ mutateAsync: vi.fn(), isPending: false }) }))
vi.mock('@/providers/ProjectProvider', () => ({
  useProject: () => ({ userId: mocks.user?.id || null, setCurrentProject: vi.fn(), isLoading: mocks.projectLoading }),
}))
vi.mock('@/providers/AuthProvider', () => ({ useAuth: () => ({ user: mocks.user, isLoading: mocks.authLoading }) }))
vi.mock('@/components/ui', () => ({
  useAlertModal: () => ({ alertError: vi.fn(), alertWarning: vi.fn() }),
  useToast: () => ({ success: vi.fn(), warning: vi.fn() }),
}))

import NewProjectPage from './page'

describe('new workspace account gate', () => {
  afterEach(cleanup)

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.user = null
    mocks.authLoading = false
    mocks.projectLoading = false
  })

  test('sends unauthenticated users to sign-in and returns them to the workspace form', () => {
    render(<NewProjectPage />)

    expect(screen.getByText('Sign in to create a reverse-engineering workspace.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(mocks.push).toHaveBeenCalledWith('/login?next=%2Fprojects%2Fnew')
  })

  test('waits for account and project identity to hydrate before showing the gate', () => {
    mocks.authLoading = true
    render(<NewProjectPage />)

    expect(screen.getByRole('status').textContent).toContain('Loading your account')
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull()
  })
})
