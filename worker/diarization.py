"""Pinned NVIDIA NeMo-Speech C ABI. Local GGUF only; persistent stream state."""
import ctypes as C
from pathlib import Path
import numpy as np

class ModelConfig(C.Structure):
    _fields_=[('size',C.c_size_t),('model_path',C.c_char_p),('gpu',C.c_int32),('preset',C.c_char_p)]+[(key,C.c_int32) for key in ['chunk_frames','right_context_frames','left_context_frames','fifo_frames','spkcache_frames','update_period_frames']]
class Segment(C.Structure):
    _fields_=[('start',C.c_double),('end',C.c_double),('speaker',C.c_int32)]

class Diarizer:
    def __init__(self,library,model):
        library=Path(library).resolve();model=Path(model).resolve()
        if not library.is_file() or not model.is_file():raise ValueError('로컬 화자 라이브러리와 GGUF 모델 파일이 필요합니다.')
        self.lib=C.CDLL(str(library));self.model=C.c_void_p();self.stream=C.c_void_p()
        L=self.lib
        L.nemo_speech_diar_create.argtypes=[C.POINTER(ModelConfig),C.POINTER(C.c_void_p)]
        L.nemo_speech_diar_stream_open.argtypes=[C.c_void_p,C.POINTER(C.c_void_p)]
        L.nemo_speech_diar_stream_push_f32.argtypes=[C.c_void_p,C.POINTER(C.c_float),C.c_size_t,C.c_int32]
        L.nemo_speech_diar_stream_finish.argtypes=[C.c_void_p]
        L.nemo_speech_diar_frame_count.argtypes=[C.c_void_p];L.nemo_speech_diar_frame_count.restype=C.c_int64
        L.nemo_speech_diar_seconds_per_frame.argtypes=[C.c_void_p];L.nemo_speech_diar_seconds_per_frame.restype=C.c_double
        L.nemo_speech_diar_segments.argtypes=[C.c_void_p,C.c_void_p,C.POINTER(Segment),C.c_size_t,C.POINTER(C.c_size_t)]
        L.nemo_speech_diar_stream_close.argtypes=[C.c_void_p];L.nemo_speech_diar_destroy.argtypes=[C.c_void_p]
        L.nemo_speech_asr_last_error.restype=C.c_char_p
        cfg=ModelConfig();cfg.size=C.sizeof(cfg);cfg.model_path=str(model).encode();cfg.gpu=-1;cfg.preset=b'v3-streaming';cfg.left_context_frames=-1
        self.check(L.nemo_speech_diar_create(C.byref(cfg),C.byref(self.model)))
        self.check(L.nemo_speech_diar_stream_open(self.model,C.byref(self.stream)))
        self.finished=False
    def check(self,code):
        if code:raise RuntimeError((self.lib.nemo_speech_asr_last_error() or b'Diarization error').decode())
    def push(self,pcm):
        data=np.ascontiguousarray(pcm,dtype=np.float32)
        self.check(self.lib.nemo_speech_diar_stream_push_f32(self.stream,data.ctypes.data_as(C.POINTER(C.c_float)),len(data),16000))
        return self.segments()
    def covered_seconds(self):
        return self.lib.nemo_speech_diar_frame_count(self.stream)*self.lib.nemo_speech_diar_seconds_per_frame(self.model)
    def finish(self):
        if not self.finished:self.check(self.lib.nemo_speech_diar_stream_finish(self.stream));self.finished=True
        return self.segments()
    def segments(self):
        count=C.c_size_t();self.check(self.lib.nemo_speech_diar_segments(self.stream,None,None,0,C.byref(count)))
        buf=(Segment*count.value)();self.check(self.lib.nemo_speech_diar_segments(self.stream,None,buf,len(buf),C.byref(count)))
        return [(s.start,s.end,s.speaker) for s in buf[:count.value]]
    def close(self):
        if self.stream:self.lib.nemo_speech_diar_stream_close(self.stream);self.stream=C.c_void_p()
        if self.model:self.lib.nemo_speech_diar_destroy(self.model);self.model=C.c_void_p()

def read_pcm(path):
    import wave
    with wave.open(str(path),'rb') as audio:
        if (audio.getframerate(),audio.getnchannels(),audio.getsampwidth())!=(16000,1,2):raise ValueError('PCM16 16kHz mono required')
        return np.frombuffer(audio.readframes(audio.getnframes()),dtype=np.int16).astype(np.float32)/32768

def turns(timeline,start_ms,end_ms):
    start=start_ms/1000;end=end_ms/1000
    points=sorted({start,end}|{max(start,min(end,x)) for a,b,_ in timeline for x in (a,b) if b>start and a<end})
    result=[]
    for a,b in zip(points,points[1:]):
        active={s for x,y,s in timeline if min(y,b)-max(x,a)>.001}
        if not active:continue
        speaker='speaker_'+str(next(iter(active))) if len(active)==1 else 'overlap'
        if result and result[-1][2]==speaker and a-result[-1][1]<.3:result[-1]=(result[-1][0],b,speaker)
        else:result.append((a,b,speaker))
    # A streaming diarizer retains a small lookahead. Preserve the last syllable
    # in the final short tail; subsequent frames can still refine speaker labels.
    if result and 0<end-result[-1][1]<.65:result[-1]=(result[-1][0],end,result[-1][2])
    return [(a,b,s) for a,b,s in result if b-a>=.18]

def planned_turns(timeline,covered,finished=False,max_seconds=8):
    if not timeline:return []
    # Split overlap regions explicitly instead of assigning both to one person.
    end=max(b for _,b,_ in timeline)
    base=turns(timeline,0,round(end*1000))
    result=[]
    for a,b,speaker in base:
        closed=finished or b<covered-.2
        while b-a>max_seconds+(1 if closed else .3):
            result.append((a,a+max_seconds,speaker,True));a+=max_seconds
        if b-a>=.18:result.append((a,b,speaker,closed))
    return result

def slice_recording(root,rows,start,end):
    blocks=[]
    for _,path,a,b,*_ in rows:
        if b/1000<=start or a/1000>=end:continue
        pcm=read_pcm(Path(root)/path)
        lo=max(0,round((start-a/1000)*16000));hi=min(len(pcm),round((end-a/1000)*16000))
        if hi>lo:blocks.append(pcm[lo:hi])
    return np.concatenate(blocks) if blocks else np.zeros(0,dtype=np.float32)
