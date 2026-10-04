import json,os,re,shutil,signal,subprocess,tempfile,threading,time
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
A=Path(os.getenv('REAMON_ARTIFACTS_PATH','/data/reamon-artifacts')).resolve();D=Path(os.getenv('REAMON_DERIVED_PATH','/data/reamon-derived')).resolve();SAFE=re.compile(r'^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$');S=threading.BoundedSemaphore(1)
class E(Exception):pass
def funcs(w):
 out=[];d=0;s=None;i=0;q=esc=line=False;block=0
 while i<len(w):
  c=w[i];n=w[i+1] if i+1<len(w) else ''
  if line:
   if c=='\n':line=False
   i+=1;continue
  if block:
   if c=='(' and n==';':block+=1;i+=2;continue
   if c==';' and n==')':block-=1;i+=2;continue
   i+=1;continue
  if q:
   if esc:esc=False
   elif c=='\\':esc=True
   elif c=='"':q=False
   i+=1;continue
  if c==';' and n==';':line=True;i+=2;continue
  if c=='(' and n==';':block=1;i+=2;continue
  if c=='"':q=True;i+=1;continue
  if c=='(':
   if d==1 and s is None:s=i
   d+=1
  elif c==')':
   d-=1
   if d==1 and s is not None:
    x=w[s:i+1];h=x[1:].lstrip()
    if h.startswith('func') and (len(h)==4 or h[4].isspace() or h[4]=='$'):out.append(x)
    s=None
  i+=1
 return out
def go(b):
 ids=[b.get(k) for k in ('projectId','artifactId','taskId','runId')]
 if any(not isinstance(x,str) or not SAFE.fullmatch(x) for x in ids):raise E('Invalid identifiers')
 try:p=Path(b['artifactPath']).resolve(strict=True);p.relative_to(A)
 except Exception as e:raise E('Artifact must be in imported read-only storage') from e
 if not p.is_file() or p.stat().st_size>268435456 or p.open('rb').read(8)!=b'\0asm\1\0\0\0':raise E('Unsupported or oversized WebAssembly 1.0 module')
 root=D.joinpath(*ids).resolve()
 try:root.relative_to(D)
 except ValueError as e:raise E('Invalid output path') from e
 if root.exists():shutil.rmtree(root)
 with S,tempfile.TemporaryDirectory() as td:
  out=Path(td)/'module.wat';err=Path(td)/'err'
  with err.open('wb') as log:
   proc=subprocess.Popen(['/opt/wabt/bin/wasm2wat','--no-debug-names',str(p),'-o',str(out)],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=log,start_new_session=True,env={'PATH':'/usr/bin:/bin','HOME':'/tmp'})
   end=time.monotonic()+180
   while proc.poll() is None:
    if time.monotonic()>end:
     os.killpg(proc.pid,signal.SIGKILL);raise E('Wasm disassembly timed out')
    try:proc.wait(timeout=.25)
    except subprocess.TimeoutExpired:pass
  detail=err.read_bytes()[-3000:].decode(errors='replace').strip()
  if proc.returncode or not out.is_file():raise E(detail or 'wasm2wat failed')
  size=out.stat().st_size
  if size>134217728:raise E('WAT output exceeded storage limit')
  text=out.read_text(errors='replace');module=root/'module'/'module.wat';module.parent.mkdir(parents=True);shutil.copyfile(out,module);allf=funcs(text);units=[]
  for i,x in enumerate(allf[:2000]):
   rel='functions/f%05d.wat'%i;dst=root/rel;dst.parent.mkdir(parents=True,exist_ok=True);dst.write_text(x+'\n');m=re.match(r'\(func\s+(\$[^\s()]+)',x);name=m.group(1) if m else 'function_%d'%i
   units.append({'name':name,'address':str(i),'relativePath':rel,'codeArtifactId':dst.relative_to(D).as_posix(),'sizeBytes':len(x.encode())})
  warning=('Indexed %d of %d functions due to result limit. '%(len(units),len(allf)) if len(units)<len(allf) else '')+detail
  return {'status':'completed','toolVersion':'1.0.42','functionCount':len(allf),'returnedUnits':len(units),'codeBytes':size,'truncated':len(units)<len(allf),'moduleCodeArtifactId':module.relative_to(D).as_posix(),'units':units,'warnings':warning}
class H(BaseHTTPRequestHandler):
 def sendj(self,s,x):
  b=json.dumps(x,separators=(',',':')).encode();self.send_response(s);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(b)));self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(b)
 def do_GET(self):
  if self.path!='/health':self.sendj(404,{'error':'Not found'});return
  self.sendj(200,{'status':'ready','provider':'wabt','version':'1.0.42'})
 def do_POST(self):
  if self.path!='/analyze':self.sendj(404,{'error':'Not found'});return
  try:
   n=int(self.headers.get('Content-Length','0'))
   if n<1 or n>16384:raise E('Invalid request length')
   b=json.loads(self.rfile.read(n))
   if not isinstance(b,dict):raise E('Invalid request')
   self.sendj(200,go(b))
  except (ValueError,json.JSONDecodeError):self.sendj(400,{'error':'Invalid JSON'})
  except E as e:self.sendj(422,{'error':str(e)[:1000]})
  except (BrokenPipeError,ConnectionResetError):pass
 def log_message(self,f,*a):print('wasm-analyzer: '+f%a,flush=True)
if __name__=='__main__':ThreadingHTTPServer(('0.0.0.0',8012),H).serve_forever()
