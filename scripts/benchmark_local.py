#!/usr/bin/env python3
"""One isolated local ASR process. Reports RSS and Metal separately."""
import os
os.environ['HF_HUB_OFFLINE']='1'
os.environ['HF_HUB_DISABLE_TELEMETRY']='1'
import argparse
import json
import resource
import time
import wave
import mlx.core as mx
from mlx_qwen3_asr import Session
parser=argparse.ArgumentParser();parser.add_argument('--model',required=True);parser.add_argument('--audio',required=True);parser.add_argument('--output',required=True)
args=parser.parse_args()
with wave.open(args.audio) as source:duration=source.getnframes()/source.getframerate()
t=time.perf_counter();session=Session(model=args.model);load=time.perf_counter()-t
runs=[]
for _ in range(3):
    t=time.perf_counter();result=session.transcribe(args.audio,language='Korean',max_new_tokens=512);mx.synchronize()
    seconds=time.perf_counter()-t
    runs.append({'seconds':seconds,'rtf':seconds/duration,'text':result.text})
report={'audio_seconds':duration,'load_seconds':load,'runs':runs,'peak_rss_bytes':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,'metal_peak_bytes':mx.get_peak_memory(),'metal_active_bytes':mx.get_active_memory(),'metal_cache_bytes':mx.get_cache_memory(),'note':'Peak RSS includes loading. Metal counters are separate views; do not add them to RSS.'}
with open(args.output,'w') as f:json.dump(report,f,ensure_ascii=False,indent=2)
print(json.dumps(report,ensure_ascii=False,indent=2))
