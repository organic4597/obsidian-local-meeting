"""One continuously updated WAV per meeting; bounded-memory legacy recovery."""
import os
import struct
import wave
from pathlib import Path

class ContinuousWav:
    def __init__(self,path,rate=16000):
        self.path=Path(path);self.path.parent.mkdir(parents=True,exist_ok=True)
        self.file=open(self.path,'xb');self.audio=wave.open(self.file,'wb');self.frames=0
        self.audio.setnchannels(1);self.audio.setsampwidth(2);self.audio.setframerate(rate)
        self.audio.writeframes(b'');self.flush()
    def append(self,pcm):
        if len(pcm)%2:raise ValueError('PCM16 sample boundary required')
        self.audio.writeframes(pcm);self.frames+=len(pcm)//2
        self.file.flush()  # Keep the header readable while recording.
    def flush(self):
        self.file.flush();os.fsync(self.file.fileno())
    def close(self):
        if self.file.closed:return
        try:self.audio.close();self.flush()
        finally:self.file.close()

def repair_header(path):
    """Only repair the fixed PCM header created by this writer, never audio data."""
    path=Path(path)
    with open(path,'r+b') as file:
        header=file.read(44)
        if len(header)!=44 or header[:4]!=b'RIFF' or header[8:12]!=b'WAVE' or header[12:16]!=b'fmt ' or header[36:40]!=b'data' or struct.unpack_from('<IHHI',header,16)!=(16,1,1,16000):
            raise ValueError('Unknown recording.wav format; original file was preserved')
        size=path.stat().st_size-44;size-=size%2
        if size>0xffffffff-36:raise ValueError('Recording exceeds standard WAV size limit')
        file.seek(4);file.write(struct.pack('<I',size+36));file.seek(40);file.write(struct.pack('<I',size));file.flush();os.fsync(file.fileno())
    return path

def ensure_recording(root):
    root=Path(root).resolve();target=root/'recording.wav'
    if target.exists():return repair_header(target)
    chunks=sorted([*root.glob('audio-*-*.wav'),*root.glob('queue/audio-*-*.pcm')],key=lambda p:p.name)
    if not chunks:raise ValueError('Saved audio chunks were not found')
    temp=root/'recording.wav.part'
    if temp.exists():temp.unlink()
    output=ContinuousWav(temp)
    try:
        previous=0
        for chunk in chunks:
            _,start,end=chunk.stem.split('-');start=int(start);end=int(end)
            if abs(start-previous)>1:raise ValueError('Audio timeline has a gap; original chunks were preserved')
            if chunk.suffix=='.pcm':
                with open(chunk,'rb') as file:
                    while data:=file.read(32768):output.append(data)
            else:
                with wave.open(str(chunk),'rb') as audio:
                    if (audio.getnchannels(),audio.getsampwidth(),audio.getframerate())!=(1,2,16000):raise ValueError('PCM16 16kHz mono required')
                    while data:=audio.readframes(16384):output.append(data)
            previous=end
        output.close();os.replace(temp,target)
    except BaseException:
        output.close()
        if temp.exists():temp.unlink()
        raise
    return target

if __name__=='__main__':
    import argparse,json
    parser=argparse.ArgumentParser();parser.add_argument('--session',required=True);args=parser.parse_args()
    try:print(json.dumps({'path':str(ensure_recording(args.session))}))
    except Exception as error:raise SystemExit(str(error))
