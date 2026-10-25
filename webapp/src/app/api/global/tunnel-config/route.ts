import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { isInternalRequest } from '@/lib/session'

// GET /api/global/tunnel-config
// Internal-only endpoint for the agent runtime, which needs the Chisel host.
function sanitizedChiselUrl(value: string | undefined): string {
  if (!value) return ''
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}`
  } catch {
    return ''
  }
}

export async function GET(request: NextRequest) {
  if (!isInternalRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const settings = await prisma.userSettings.findFirst({
      where: { chiselServerUrl: { not: '' } },
      select: {
        chiselServerUrl: true,
      },
    })

    return NextResponse.json({ chiselServerUrl: sanitizedChiselUrl(settings?.chiselServerUrl) })
  } catch (error) {
    console.error('Failed to fetch tunnel config:', error)
    return NextResponse.json({ chiselServerUrl: '' })
  }
}
