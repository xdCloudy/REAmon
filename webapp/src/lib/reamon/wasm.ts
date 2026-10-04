import { createHash } from 'node:crypto'
import type { ToolExecutionInput, ToolPlugin, ToolPluginManifest, ToolResult } from './types'
export const wasmManifest:ToolPluginManifest={id:'reamon-wabt',name:'WebAssembly Disassembler (WABT)',category:'static_analysis',integration:'process',acceptsTargetTypes:['FILE'],acceptsFormats:['wasm'],capabilities:['disassemble'],produces:['CodeUnit','WATFunction'],requirements:[{key:'service',value:'Isolated WABT analyzer'},{key:'artifactPath'}]}
export async function executeWasm(input:ToolExecutionInput):Promise<ToolResult>{
 const base={toolId:wasmManifest.id,capabilities:wasmManifest.capabilities,produced:wasmManifest.produces}
 if(!input.artifactPath||!input.artifactId||!input.projectId||!input.taskId||!input.runToken)return {status:'failed',...base,data:{},error:'WABT requires a stored WebAssembly module and task context'}
 const url=process.env.REAMON_WASM_URL?.trim().replace(/\/$/,'')
 if(!url)return {status:'failed',...base,data:{},error:'The isolated WebAssembly analyzer is not configured'}
 try{
  const response=await fetch(url+'/analyze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({projectId:input.projectId,artifactId:input.artifactId,taskId:input.taskId,runId:input.runToken,artifactPath:input.artifactPath}),signal:AbortSignal.timeout(240000),cache:'no-store'})
  const payload:any=await response.json().catch(()=>null)
  if(!response.ok)throw new Error(payload?.error||'WABT analyzer returned HTTP '+response.status)
  if(payload?.status!=='completed'||!Array.isArray(payload.units))throw new Error('Invalid WABT result')
  const units=payload.units.slice(0,2000).filter((u:any)=>u&&typeof u.name==='string'&&typeof u.address==='string'&&typeof u.codeArtifactId==='string'&&u.sizeBytes>0)
  const observations=units.map((u:any)=>({kind:'entity',type:'code_unit',key:'wasm:function:'+createHash('sha256').update(input.artifactId+':'+input.taskId+':'+u.address).digest('hex').slice(0,32),label:u.name.slice(0,500),attributes:{unitType:'function',name:u.name.slice(0,500),qualifiedName:u.name.slice(0,500),address:u.address.slice(0,128),sizeBytes:Math.floor(u.sizeBytes),language:'WebAssembly Text (WAT)',codeArtifactId:u.codeArtifactId.slice(0,2000)}}))
  return {status:'completed',...base,data:{wasmFunctionCount:payload.functionCount,returnedFunctionCount:observations.length,codeBytes:payload.codeBytes,truncated:payload.truncated,wabtVersion:payload.toolVersion,warnings:payload.warnings||'',observations}}
 }catch(e){return {status:'failed',...base,data:{},error:(e instanceof Error?e.message:String(e)).slice(0,4000)}}
}
export const wasmPlugin:ToolPlugin={manifest:wasmManifest,analyze:executeWasm}
