import { describe, expect, it } from 'vitest'
import {
  buildCodeUnitTreemapEntries,
  filterCodeUnits,
  filterCodeUnitsByPackage,
  layoutCodeUnitTreemap,
  normalizeCodeUnit,
  parseCodeUnitFilter,
  summarizeCodeUnits,
  type CodeUnit,
} from './code-units'

function unit(overrides: Partial<CodeUnit> = {}): CodeUnit {
  return {
    id: 'unit-1', name: 'app.MainActivity.onCreate', address: '0x1000', sizeBytes: 1024,
    coveragePercent: 100, language: 'Java', unitType: 'method', artifactId: 'artifact-1',
    artifactPath: 'classes.dex', source: 'jadx', codeArtifactId: null, disassemblyArtifactId: null, disassemblyLanguage: null, updatedAt: '2026-10-04T00:00:00.000Z',
    ...overrides,
  }
}

describe('code visualizer unit normalization', () => {
  it('normalizes provider observations and rejects entries without a positive safe size', () => {
    const normalized = normalizeCodeUnit({
      id: 'observation-1', stableKey: 'method:0x1000', label: 'onCreate', source: 'jadx-provider',
      artifactId: 'artifact-1', updatedAt: new Date('2026-10-04T00:00:00.000Z'),
      artifact: { relativePath: 'app.apk', originalName: 'app.apk' },
      attributes: { qualifiedName: 'app.MainActivity.onCreate', startAddress: '0x1000', sizeBytes: 80, decompiledBytes: 60, language: 'Java', unitType: 'method', disassemblyArtifactId: 'project-1/artifact-1/task-1/run-1/smali/Main.smali', disassemblyLanguage: 'Smali' },
    })

    expect(normalized).toMatchObject({
      name: 'app.MainActivity.onCreate', address: '0x1000', sizeBytes: 80, coveragePercent: 75,
      artifactPath: 'app.apk', source: 'jadx-provider', disassemblyLanguage: 'Smali',
    })
    const row = {
      id: 'empty', stableKey: 'empty', label: null, source: 'provider', artifactId: null,
      updatedAt: '2026-10-04T00:00:00.000Z', attributes: { sizeBytes: 0 },
    }
    expect(normalizeCodeUnit(row)).toBeNull()
    expect(normalizeCodeUnit({ ...row, attributes: { sizeBytes: Number.MAX_SAFE_INTEGER + 1 } })).toBeNull()
  })

  it('parses size and coverage filters and applies name filtering', () => {
    expect(parseCodeUnitFilter('MainActivity >1kb <70%')).toEqual({ text: 'mainactivity', minimumBytes: 1024, maximumCoverage: 70 })
    const units = [unit(), unit({ id: 'unit-2', name: 'app.MainActivity.onPause', sizeBytes: 2048, coveragePercent: 35 })]
    expect(filterCodeUnits(units, 'MainActivity >1kb <70%').map((item) => item.id)).toEqual(['unit-2'])
  })

  it('packs equal-sized units into balanced treemap tiles while preserving byte proportions', () => {
    const units = Array.from({ length: 8 }, (_, index) => unit({ id: 'unit-' + index, name: 'function' + index, sizeBytes: 100 }))
    const rectangles = layoutCodeUnitTreemap(units, 1200, 560)
    const areas = rectangles.map((rect) => rect.width * rect.height)

    expect(rectangles).toHaveLength(8)
    expect(Math.max(...areas) - Math.min(...areas)).toBeLessThan(0.01)
    expect(Math.max(...rectangles.map((rect) => Math.max(rect.width / rect.height, rect.height / rect.width)))).toBeLessThan(3)
    expect(rectangles.reduce((sum, rect) => sum + rect.width * rect.height, 0)).toBeCloseTo(1200 * 560, 5)
  })

  it('groups code artifacts by package with size-weighted coverage and drills down to code units', () => {
    const units = [
      unit({ id: 'main', name: 'com.example.MainActivity', unitType: 'class', codeArtifactId: 'p/a/t/r/sources/com/example/MainActivity.java', sizeBytes: 100, coveragePercent: 100 }),
      unit({ id: 'util', name: 'com.example.Util', unitType: 'class', codeArtifactId: 'p/a/t/r/sources/com/example/Util.java', sizeBytes: 300, coveragePercent: 50 }),
      unit({ id: 'other', name: 'org.sample.Other', unitType: 'class', codeArtifactId: 'p/a/t/r/sources/org/sample/Other.java', sizeBytes: 100, coveragePercent: null }),
    ]

    const roots = buildCodeUnitTreemapEntries(units)
    expect(roots.map(({ name, packagePath, sizeBytes, unitCount, coveragePercent }) => ({ name, packagePath, sizeBytes, unitCount, coveragePercent }))).toEqual([
      { name: 'com', packagePath: 'com', sizeBytes: 400, unitCount: 2, coveragePercent: 62.5 },
      { name: 'org', packagePath: 'org', sizeBytes: 100, unitCount: 1, coveragePercent: null },
    ])
    const packages = buildCodeUnitTreemapEntries(units, 'com.example')
    expect(packages.map(({ codeUnit }) => codeUnit?.id)).toEqual(['util', 'main'])
    expect(filterCodeUnitsByPackage(units, 'com.example').map(({ id }) => id)).toEqual(['main', 'util'])
  })

  it('keeps treemap areas bounded and reports coverage only for measured bytes', () => {
    const units = [unit(), unit({ id: 'unit-2', name: 'nativeInit', sizeBytes: 512, coveragePercent: null })]
    const rectangles = layoutCodeUnitTreemap(units, 1200, 560)

    expect(rectangles.map(({ unit: item }) => item.id)).toEqual(['unit-1', 'unit-2'])
    expect(rectangles.every((rect) => rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= 1200 && rect.y + rect.height <= 560)).toBe(true)
    expect(summarizeCodeUnits(units)).toEqual({ totalBytes: 1536, measuredBytes: 1024, unmeasuredBytes: 512, coveragePercent: 100, decompiledUnits: 1 })
    expect(summarizeCodeUnits([unit({ coveragePercent: null })]).coveragePercent).toBeNull()
  })
})
