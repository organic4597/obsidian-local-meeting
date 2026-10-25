#!/usr/bin/env python3
"""Convert a local Korean checkpoint to MLX 8-bit or mixed decoder-4/encoder-8.
Downloads are intentionally separate from inference and conversion.
"""
import os
os.environ['HF_HUB_OFFLINE']='1'
os.environ['HF_HUB_DISABLE_TELEMETRY']='1'
import argparse
import hashlib
import json
import shutil
from pathlib import Path
import mlx.core as mx
from mlx.utils import tree_flatten
from mlx_qwen3_asr import load_model
from mlx_qwen3_asr.convert import quantize_model

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--source',required=True,type=Path)
    parser.add_argument('--output',required=True,type=Path)
    parser.add_argument('--bits',type=int,choices=[4,8],default=8)
    args=parser.parse_args()
    source=args.source.resolve();output=args.output.resolve()
    if output.exists(): raise ValueError('출력 폴더가 이미 존재합니다.')
    if not (source/'model.safetensors').is_file(): raise ValueError('원본 model.safetensors가 필요합니다.')
    print('Loading original Korean fine-tune...',flush=True)
    model,_=load_model(str(source))
    quantize_model(model,bits=args.bits,encoder_bits=8,group_size=64)
    mx.eval(model.parameters())
    temp=output.with_name(output.name+'.preparing')
    temp.mkdir(parents=True,exist_ok=False)
    mx.save_safetensors(str(temp/'model.safetensors'),dict(tree_flatten(model.parameters())))
    for file in source.iterdir():
        if file.suffix in ('.json','.txt','.jinja') and file.is_file(): shutil.copy2(file,temp/file.name)
    (temp/'quantization_config.json').write_text(json.dumps({'bits':args.bits,'encoder_bits':8,'group_size':64}))
    with open(source/'model.safetensors','rb') as original:
        digest=hashlib.sha256()
        for block in iter(lambda:original.read(1024*1024),b''):digest.update(block)
        sha=digest.hexdigest()
    (temp/'conversion.json').write_text(json.dumps({'source':'TeamUNIVA/qwen3_asr_1.7b_ko','source_sha256':sha,'bits':args.bits,'encoder_bits':8,'group_size':64,'runtime':'mlx-qwen3-asr==0.4.4'},indent=2))
    temp.rename(output)
    print(str(output),flush=True)

if __name__=='__main__':main()
