"""Opt-in native notification/lifecycle scenarios; only scratch state is mutable."""
import json,os,pathlib,shutil,subprocess,sys,threading,time
from claude_runtime import Fixture

MODE,REPO,BASE,BINARY=sys.argv[1:5]
REPO=pathlib.Path(REPO);BASE=pathlib.Path(BASE);R=BASE/MODE
IS_FORK=MODE=='fork'
tool_pending=threading.Event()
if R.exists(): shutil.rmtree(R)
fixture=Fixture(REPO,R)
calls=fixture.calls
shipped_module=(R/'plugin/hooks/register.js').read_bytes()
NODE=shutil.which('node')
DRIVER=str(REPO/'test/fixtures/claude-runtime-driver.mjs')
SANDBOX=str(REPO/'test/sandbox-env.js')
def driver(op,*args):
 result=subprocess.run([NODE,'--import',SANDBOX,DRIVER,str(R),op,*args],capture_output=True,text=True,timeout=8)
 if result.returncode: raise RuntimeError(result.stderr)
 return result.stdout
print('setup',driver('setup'))
if IS_FORK:
 shutil.copytree(BASE/'lifecycle/config/projects',R/'config/projects',dirs_exist_ok=True)
 prior=json.loads((BASE/'lifecycle/bridge.jsonl').read_text().splitlines()[0]);fork_from=prior['input']['sessionId']
def reply(data):
 messages=json.dumps(data.get('messages',[]))
 if MODE=='cancel' and 'Abort fixture.' in messages and 'Notification BODY:' not in messages:
  tool_pending.set();time.sleep(5)
 if MODE=='busy' and 'Reply fixture hello.' in messages and 'tool_result' not in messages and 'Notification BODY:' not in messages:
  tool_pending.set();time.sleep(2)
  return {'type':'tool_use','id':'toolu_fixture','name':'Read','input':{'file_path':str(R/'work/probe.txt')}}
 return {'type':'text','text':'FIXTURE_RESPONSE_'+str(len(calls))}

args=fixture.command(BINARY)+['--strict-mcp-config','--tools','']
if IS_FORK: args += ['--resume', fork_from, '--fork-session']
if MODE=='hold':
 args[args.index('--setting-sources')+1]='user';i=args.index('--settings');del args[i:i+2]
 (R/'config/settings.json').write_text(json.dumps({'crossSessionInbound':'hold'}))
if MODE=='busy':
 args[args.index('--tools')+1]='Read';args+=['--allowedTools','Read','--permission-mode','manual']
 (R/'work/probe.txt').write_text('LOCAL_TOOL_FIXTURE_CONTENT\n')
beg=time.time();sent_prompt=False;sent_native=False;body_in_api=False;actions=[];phase='delivery';old_id=None;native_at=0;released=False
with fixture.run(args,reply):
 master=fixture.master;p=fixture.process
 while time.time()-beg<35 and p.poll() is None:
  if not fixture.read():break
  records=[]
  for row in fixture.records('bridge.jsonl'):
   i=row['input'];out=json.loads(row['stdout']) if row['stdout'] else {}
   records.append({'kind':i.get('operation'),'id':i.get('sessionId'),'socket':i.get('endpoint'),'out':out,'bindings':out.get('bindings')})
  ready=[x for x in records if x.get('kind')=='start' and x.get('out',{}).get('available') and x.get('socket')]
  if ready and not sent_prompt:
   driver('join',ready[-1]['id']);actions.append('explicitly joined receiver before its first prompt')
   if IS_FORK: actions.append('forked '+fork_from+' to '+ready[-1]['id']);assert ready[-1]['id']!=fork_from
   os.write(master,b'Abort fixture.\r' if MODE=='cancel' else b'Reply fixture hello.\r');sent_prompt=True;actions.append('typed initial synthetic prompt')
  if ready and sent_prompt and calls and not sent_native and ((MODE in ['busy','cancel'] and tool_pending.is_set()) or (MODE not in ['busy','cancel'] and time.time()-beg>8)):
   out=driver('send');sent_native=True;native_at=time.time();actions.append('shipped Square coordinator sent native body: '+out.strip());(R/'dispatch-result.json').write_text(out)
   if MODE=='cancel':os.write(master,b'\x1b');actions.append('pressed Esc during synthetic request with pending Square activity');phase='cancel';baseline=len(records)
  if phase=='cancel' and any(x.get('kind')=='cancel' for x in records[baseline:]):
   (R/'cancel-evidence.json').write_text(driver('inspect'));plugin=R/'plugin/hooks/register.js';plugin.write_text(plugin.read_text()+'\n// reload probe\n');actions.append('hot reload after abort');phase='cancel-reload';baseline=len(ready)
  if phase=='cancel-reload' and len(ready)>baseline:
   time.sleep(1);(R/'plugin/hooks/register.js').write_bytes(shipped_module);(R/'cancel-reload-evidence.json').write_text(driver('inspect'));actions.append('explicit stale-frame replay probe: '+driver('replay').strip());phase='cancel-replay';baseline=len(records)
  if phase=='cancel-replay' and any(x.get('kind')=='guard' and x.get('out')=={'recognized':True,'current':False} for x in records[baseline:]):
   actions.append('recognized cancelled frame consumed before queue');actions.append('new activity after abort: '+driver('send').strip());phase='cancel-new';baseline=len(records)
  if phase=='cancel-new' and any(x.get('kind')=='stored' and x.get('out',{}).get('current') for x in records[baseline:]):
   actions.append('new post-cancel activity stored');time.sleep(1);break
  if MODE=='hold' and sent_native and not released and time.time()-native_at>3:
   actions.append('while held no queued/stored callback: '+str(not any(x.get('kind') in ['admitted','stored'] for x in records)))
   (R/'config/settings.json').write_text(json.dumps({'crossSessionInbound':'accept'}));released=True;actions.append('changed only temporary receiver user settings hold to accept')
  body_in_api=any('Notification BODY: shipped Square native probe.' in json.dumps(c['data'].get('messages',[])) for c in calls)
  if sent_native and any(x.get('kind')=='stored' for x in records) and body_in_api and phase=='delivery':
   if MODE not in ['busy','lifecycle']:time.sleep(1);break
   old_id=ready[-1]['id'];os.write(master,b'/clear\r');actions.append('typed isolated /clear');phase='clear'
  if phase=='clear' and ready and ready[-1]['id']!=old_id:
   actions.append('classic start registered changed session id after clear');plugin=R/'plugin/hooks/register.js';plugin.write_text(plugin.read_text()+'\n// reload probe\n');phase='reload';baseline=len(ready)
  if phase=='reload' and len(ready)>baseline:
   actions.append('hot reload registered same current session id');(R/'plugin/hooks/register.js').write_bytes(shipped_module)
   if MODE!='lifecycle':time.sleep(1);break
   os.write(master,('/resume '+old_id+'\r').encode());actions.append('typed isolated /resume '+old_id);phase='resume';baseline=len(ready)
  if phase=='resume' and len(ready)>baseline:
   actions.append('resume coordinate '+ready[-1]['id']);time.sleep(.5);actions.append('resumed bound participant delivery: '+driver('send').strip());phase='resume-delivery';baseline=len(records)
  if phase=='resume-delivery' and any(x.get('kind')=='stored' and x.get('out',{}).get('current') for x in records[baseline:]):
   actions.append('resumed receiver stored NEW Square activity');time.sleep(1);break
summary={'argv':args,'fakeEndpoint':fixture.endpoint,'mode':MODE,'actions':actions,'sent_prompt':sent_prompt,'sent_native':sent_native,'requests':len(calls),'exit':p.returncode,'seconds':round(time.time()-beg,1)}
(R/'plugin/hooks/register.js').write_bytes(shipped_module)
(R/'square-evidence.json').write_text(driver('inspect'))
assert sent_native and body_in_api, 'no native body in a Claude request'
(R/'live-summary.json').write_text(json.dumps(summary,indent=2));print(json.dumps(summary,indent=2))
