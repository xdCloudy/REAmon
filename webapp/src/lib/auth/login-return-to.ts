const DEFAULT_LOGIN_DESTINATION = '/projects'

/** Keep post-login navigation on this app and avoid returning to the login form. */
export function safeLoginDestination(returnTo: string | null | undefined, origin: string): string {
  if (!returnTo || !returnTo.startsWith('/') || returnTo.startsWith('//') || returnTo.includes('\\')) {
    return DEFAULT_LOGIN_DESTINATION
  }

  try {
    const destination = new URL(returnTo, origin)
    const normalizedPath = destination.pathname.replace(/\/+$/, '') || '/'
    if (destination.origin !== new URL(origin).origin
      || normalizedPath === '/login'
      || normalizedPath.startsWith('/api/')) {
      return DEFAULT_LOGIN_DESTINATION
    }
    return `${normalizedPath}${destination.search}${destination.hash}`
  } catch {
    return DEFAULT_LOGIN_DESTINATION
  }
}
