/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/prisma', () => ({ default: { reamonObservation: { findMany: vi.fn() } } }))
vi.mock('./pycdc', () => ({ executePycdc: vi.fn(), pycdcManifest: { id: 'reamon-pycdc', capabilities: [], produces: [] } }))

import { contiguousPyInstallerAttemptOffset } from './pyinstaller'

describe('PyInstaller module pagination', () => {
  it('advances only past a contiguous prefix of decompiled or explicitly attempted modules', () => {
    expect(contiguousPyInstallerAttemptOffset([
      { attributes: { pyinstallerModuleIndex: 0, decompiled: true } },
      { attributes: { pyinstallerModuleIndex: 1, pyinstallerDecompilationAttempted: true } },
      { attributes: { pyinstallerModuleIndex: 3, decompiled: true } },
      { attributes: { pyinstallerModuleIndex: -1, decompiled: true } },
      { attributes: { pyinstallerModuleIndex: 2, pyinstallerDecompilationAttempted: false } },
      { attributes: null },
    ])).toBe(2)
  })

  it('starts at the beginning when the first module has no recorded outcome', () => {
    expect(contiguousPyInstallerAttemptOffset([
      { attributes: { pyinstallerModuleIndex: 1, decompiled: true } },
      { attributes: { pyinstallerModuleIndex: 2, pyinstallerDecompilationAttempted: true } },
    ])).toBe(0)
  })
})
