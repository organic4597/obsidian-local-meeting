"""Short, local microphone + speaker smoke test. Records only this test session."""
import argparse
import json
import subprocess
import sys
import threading
import time
import uuid
import wave
import numpy as np
import sounddevice as sd
from pathlib import Path
root=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description='마이크 로컬 STT와 Community-1 확인')
parser.add_argument('--community-python',required=True);parser.add_argument('--community-model',required=True);parser.add_argument('--aligner-model',default='')
args=parser.parse_args()
sys.path.insert(0,str(root/'worker'))
from dictionary import snapshot
events=[]
devices=sd.query_devices()
input_device=next(i for i,d in enumerate(devices) if 'MacBook Pro' in d['name'] and d['max_input_channels']>0)
output_device=next(i for i,d in enumerate(devices) if 'MacBook Pro' in d['name'] and d['max_output_channels']>0)
print('Using built-in microphone and speaker',flush=True)
session=root/'recordings'/('microphone-smoke-'+uuid.uuid4().hex[:8])
session.mkdir(parents=True)
(session/'pipeline.json').write_text(json.dumps({'schemaVersion':3,'workflow':'text-then-community','dictionary':snapshot([]),'speakerCount':0,'speakerCountMode':'maximum'}))
proc=subprocess.Popen([str(root/'.venv/bin/python'),'-u',str(root/'worker/main.py'),'--model',str(root/'models/qwen3-asr-1.7b-ko-8bit'),'--session',str(session),'--device',str(input_device),'--community-python',args.community_python,'--community-model',args.community_model,'--aligner-model',args.aligner_model],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
ready=threading.Event()
def reader():
    for line in proc.stdout:
        print(line,end='',flush=True)
        item=json.loads(line);events.append(item)
        if item['type']=='ready':ready.set()
        if item['type']=='error':ready.set()
thread=threading.Thread(target=reader);thread.start()
try:
    if not ready.wait(30):raise RuntimeError('워커 또는 마이크 권한 대기 시간 초과')
    if any(e['type']=='error' for e in events):raise RuntimeError('마이크 워커 오류')
    with wave.open(str(root/'work/korean-meeting.wav')) as audio:
        pcm=np.frombuffer(audio.readframes(audio.getnframes()),dtype=np.int16).astype(np.float32)/32768
    sd.play(pcm,16000,device=output_device);sd.wait()
    time.sleep(.5)
finally:
    proc.stdin.write('{"type":"stop"}\n');proc.stdin.flush()
    try:proc.wait(timeout=180)
    except subprocess.TimeoutExpired:proc.terminate();proc.wait(timeout=10)
    thread.join(timeout=2)
    (root/'work/microphone-smoke-events.json').write_text(json.dumps(events,ensure_ascii=False,indent=2))
    errors=proc.stderr.read()
    if proc.returncode:print(errors[-3000:])
print('exit:',proc.returncode)
