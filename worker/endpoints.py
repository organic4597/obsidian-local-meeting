"""Acoustic pause hints only. Never remove samples or replace speaker evidence."""
import math
from pathlib import Path
import numpy as np

class PauseHistory:
    step=.02
    def __init__(self,root):
        self.path=Path(root)/'pause-hints.u8'
    def add(self,pcm,start_seconds):
        # Conservative energy endpoint: quiet frames below -50 dBFS. No claim of
        # neural VAD; the diarizer still supplies speech and speaker evidence.
        width=320;frames=len(pcm)//width
        if not frames:return
        rms=np.sqrt(np.mean(pcm[:frames*width].reshape(frames,width)**2,axis=1))
        quiet=(rms<10**(-50/20)).astype(np.uint8)
        with self.path.open('r+b' if self.path.exists() else 'w+b') as f:
            f.seek(round(start_seconds/self.step));f.write(quiet.tobytes())
    def pauses(self,start,end,minimum=.9):
        if not self.path.exists():return []
        lo=max(0,math.floor(start/self.step));hi=max(lo,math.floor(end/self.step))
        with self.path.open('rb') as f:f.seek(lo);quiet=np.frombuffer(f.read(hi-lo),np.uint8)
        edges=np.diff(np.r_[False,quiet!=0,False].astype(np.int8))
        return [((lo+a)*self.step,(lo+b)*self.step) for a,b in zip(np.flatnonzero(edges==1),np.flatnonzero(edges==-1)) if (b-a)*self.step>=minimum-1e-6]
