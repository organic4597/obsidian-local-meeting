"""Read local PCM and WAV ranges for the transcription queue."""
from pathlib import Path
import numpy as np

def read_pcm(path):
    import wave
    if Path(path).suffix=='.pcm':return np.frombuffer(Path(path).read_bytes(),dtype=np.int16).astype(np.float32)/32768
    with wave.open(str(path),'rb') as audio:
        if (audio.getframerate(),audio.getnchannels(),audio.getsampwidth())!=(16000,1,2):raise ValueError('PCM16 16kHz mono required')
        return np.frombuffer(audio.readframes(audio.getnframes()),dtype=np.int16).astype(np.float32)/32768

def slice_recording(root,rows,start,end):
    blocks=[]
    for _,path,a,b,*_ in rows:
        if b/1000<=start or a/1000>=end:continue
        pcm=read_pcm(Path(root)/path)
        lo=max(0,round((start-a/1000)*16000));hi=min(len(pcm),round((end-a/1000)*16000))
        if hi>lo:blocks.append(pcm[lo:hi])
    return np.concatenate(blocks) if blocks else np.zeros(0,dtype=np.float32)
