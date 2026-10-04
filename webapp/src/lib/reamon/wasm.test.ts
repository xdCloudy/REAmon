/** @vitest-environment node */
import { beforeEach,describe,expect,it,vi } from 'vitest'
import { executeWasm,wasmManifest } from './wasm'
const input={targetProfile:{targetType:'FILE' as const,format:'wasm',extension:'wasm'},artifactId:'artifact-1',projectId:'project-1',taskId:'task-1',runToken:'run-1',artifactPath:'/data/reamon-artifacts/project-1/sample.wasm'}
describe('WABT provider',()=>{
 beforeEach(()=>{vi.stubEnv('REAMON_WASM_URL','http://wasm-analyzer:8012');vi.stubGlobal('fetch',vi.fn())})
 it('advertises Wasm disassembly instead of decompilation',()=>{expect(wasmManifest.acceptsFormats).toEqual(['wasm']);expect(wasmManifest.capabilities).toEqual(['disassemble'])})
 it('converts returned WAT functions to linked code units',async()=>{
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({status:'completed',toolVersion:'1.0.42',functionCount:1,returnedUnits:1,codeBytes:100,truncated:false,units:[{name:'$main',address:'0',relativePath:'functions/f00000.wat',codeArtifactId:'project-1/artifact-1/task-1/run-1/functions/f00000.wat',sizeBytes:50}],warnings:''}),{status:200}))
  const result=await executeWasm(input)
  expect(result.status).toBe('completed')
  expect(result.data).toMatchObject({wasmFunctionCount:1,returnedFunctionCount:1,wabtVersion:'1.0.42'})
  expect(result.data.observations).toMatchObject([{type:'code_unit',label:'$main',attributes:{unitType:'function',language:'WebAssembly Text (WAT)',codeArtifactId:'project-1/artifact-1/task-1/run-1/functions/f00000.wat'}}])
 })
})
