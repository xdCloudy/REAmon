import type { Metadata } from 'next'
import { Suspense } from 'react'
import '@/styles/index.css'
import { QueryProvider } from '@/providers/QueryProvider'
import { AuthProvider } from '@/providers/AuthProvider'
import { ProjectProvider } from '@/providers/ProjectProvider'
import { ToastProvider, AlertProvider } from '@/components/ui'
import { NavigationGuardProvider } from '@/context/NavigationGuardContext'
import { FeatureModelGateProvider } from '@/components/shared/FeatureModelGate'
import { AppLayout } from '@/components/layout'
import { ThemeDbBridge } from '@/components/ThemeDbBridge'
import { resolveWsHint } from '@/hooks/agentWsUrl'

// Render every route per REQUEST, not at build time. The head below injects
// window.__REDAMON_WS__ from process.env, and every page under this layout is a
// 'use client' shell with no server data - so Next prerendered them all into
// static .next/server/app/*.html at `next build`, where AGENT_WS_MODE is unset
// (webapp/Dockerfile passes no such build ARG). The hint was therefore never
// emitted in a production image, whatever .env said, and the browser fell back
// to same-origin ws://<host>:3000 - a port that runs no WebSocket server. That
// is issue #175: the AI Agent, Kali terminal and both cypherfix sockets never
// reach the agent from any non-localhost browser, with nothing in the agent log.
// These pages are client shells, so the static cache bought nothing anyway.
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'REAmon',
  description: 'AI-assisted reverse-engineering workspace and orchestration platform',
  icons: {
    icon: '/favicon.ico',
    apple: '/favicon.png',
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  // Browser->agent WebSocket routing hint, resolved at REQUEST time (no rebuild)
  // and read by buildAgentWsUrl(). Default deploy has no reverse proxy, so tell the
  // UI to dial the agent's published port on whatever host the browser used, fixing
  // LAN/remote "Connecting…" (issue #159). A reverse-proxied deploy sets
  // AGENT_WS_PUBLIC_URL (or bakes NEXT_PUBLIC_AGENT_WS_URL) and stays same-origin.
  const wsHint = resolveWsHint(process.env)
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {wsHint && (
          <script
            dangerouslySetInnerHTML={{
              // Escape `<` so a misconfigured env value can never break out of the
              // <script> tag (JSON.stringify does not escape `/`, so `</script>`
              // would otherwise terminate it). The value is trusted server env, but
              // this keeps the injection XSS-safe by construction.
              __html: `window.__REDAMON_WS__=${JSON.stringify(wsHint).replace(/</g, '\\u003c')};`,
            }}
          />
        )}
        {/* Prevent flash of wrong theme */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  var theme = localStorage.getItem('redamon-theme');
                  if (theme === 'dark' || theme === 'light') {
                    document.documentElement.setAttribute('data-theme', theme);
                  } else if (window.matchMedia('(prefers-color-scheme: light)').matches) {
                    document.documentElement.setAttribute('data-theme', 'light');
                  } else {
                    document.documentElement.setAttribute('data-theme', 'dark');
                  }
                } catch (e) {
                  document.documentElement.setAttribute('data-theme', 'dark');
                }
              })();
            `,
          }}
        />
      </head>
      <body>
        <QueryProvider>
          <Suspense fallback={null}>
            <AuthProvider>
              <ThemeDbBridge />
              <ProjectProvider>
                <ToastProvider>
                  <AlertProvider>
                    <FeatureModelGateProvider>
                      <NavigationGuardProvider>
                        <AppLayout>{children}</AppLayout>
                      </NavigationGuardProvider>
                    </FeatureModelGateProvider>
                  </AlertProvider>
                </ToastProvider>
              </ProjectProvider>
            </AuthProvider>
          </Suspense>
        </QueryProvider>
      </body>
    </html>
  )
}
