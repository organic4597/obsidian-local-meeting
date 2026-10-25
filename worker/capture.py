"""Audio callback -> bounded RAM queue -> atomic PCM WAV disk spool.
Capture and disk writer run independently from the MLX inference thread.
"""
import os
import queue
import threading
import wave
from pathlib import Path
from recording import ContinuousWav

class Capture:
    def __init__(self, root, emit, device=None, rate=16000, seconds=8):
        self.root=Path(root)
        self.emit=emit
        self.device=device
        self.rate=rate
        self.seconds=seconds
        self.blocks=queue.Queue(maxsize=100)  # 10 seconds at 100 ms/block
        self.stop_event=threading.Event()
        self.finished=threading.Event()
        self.error=None
        self.stream=None
        self.thread=None
        self.failed_block=None
        self.stop_lock=threading.Lock()
        self.recording=None

    def callback(self, data, frames, timing, status):
        if status:
            self.error=f'오디오 장치 데이터 손실: {status}'
            self.stop_event.set()
        block=bytes(data)
        try:
            self.blocks.put_nowait(block)
        except queue.Full:
            # Keep the first rejected block, then stop. Do not silently drop audio.
            if self.failed_block is None:
                self.failed_block=block
            self.error='디스크 기록이 녹음 속도를 따라가지 못해 녹음을 중지했습니다.'
            self.stop_event.set()
            import sounddevice as sd
            raise sd.CallbackStop

    def start(self):
        import sounddevice as sd
        if (self.root/'recording.wav').exists() or list(self.root.glob('audio-*.wav')) or list(self.root.glob('queue/audio-*.pcm')):
            raise RuntimeError('기존 세션에는 추가 녹음할 수 없습니다. 새 회의를 시작하세요.')
        self.recording=ContinuousWav(self.root/'recording.wav',self.rate)
        try:
            self.stream=sd.RawInputStream(samplerate=self.rate,blocksize=self.rate//10,
                channels=1,dtype='int16',device=self.device,callback=self.callback)
            self.stream.start()
        except BaseException:
            self.recording.close();self.recording=None
            raise
        self.thread=threading.Thread(target=self.write_loop,daemon=True)
        self.thread.start()

    def import_wav(self, path):
        with wave.open(str(Path(path).resolve()),'rb') as source:
            if (source.getnchannels(),source.getsampwidth(),source.getframerate()) != (1,2,self.rate):
                raise ValueError('입력 WAV는 16kHz mono PCM16 형식이어야 합니다.')
            self.recording=ContinuousWav(self.root/'recording.wav',self.rate)
            try:
                offset=0
                while True:
                    remaining=source.getnframes()-source.tell()
                    # Do not decode a tiny final fragment without preceding context.
                    frames=remaining if remaining <= self.rate*(self.seconds+2) else self.rate*self.seconds
                    pcm=source.readframes(frames)
                    if not pcm:break
                    self.recording.append(pcm);offset=self.write_chunk(pcm,offset)
            finally:self.recording.close();self.recording=None

    def write_chunk(self, data, offset):
        end=offset+len(data)//2
        start_ms=round(offset*1000/self.rate)
        end_ms=round(end*1000/self.rate)
        name=f'queue/audio-{start_ms:012d}-{end_ms:012d}.pcm'
        target=self.root/name;target.parent.mkdir(parents=True,exist_ok=True)
        temp=target.with_suffix('.pcm.part')
        if self.recording:self.recording.flush()
        with open(temp,'xb') as out:
            out.write(data);out.flush();os.fsync(out.fileno())
        os.replace(temp,target)
        # Queue insertion happens in the consumer's connection, not this thread.
        self.emit({'type':'audio','path':name,'start':start_ms,'end':end_ms})
        return end

    def write_loop(self):
        data=bytearray(); offset=0; limit=self.rate*self.seconds*2
        try:
            if self.recording is None:self.recording=ContinuousWav(self.root/'recording.wav',self.rate)
            while not self.stop_event.is_set() or not self.blocks.empty():
                try: block=self.blocks.get(timeout=.1)
                except queue.Empty: continue
                self.recording.append(block);data.extend(block)
                if len(data)>=limit:
                    offset=self.write_chunk(bytes(data[:limit]),offset)
                    del data[:limit]
            if self.failed_block:self.recording.append(self.failed_block);data.extend(self.failed_block)
            if data: self.write_chunk(bytes(data),offset)
        except Exception as exc:
            self.error=f'녹음 저장 실패: {exc}'
            self.stop_event.set()
        finally:
            try:
                if self.recording:self.recording.close();self.recording=None
            except Exception as exc:
                self.error=f'전체 녹음 저장 실패: {exc}';self.stop_event.set()
            finally:self.finished.set()

    def stop(self):
        with self.stop_lock:
            if self.stream:
                self.stream.stop(); self.stream.close(); self.stream=None
            self.stop_event.set()
            if self.thread: self.thread.join(timeout=15)
            if not self.finished.is_set() and self.thread:
                raise RuntimeError('오디오 저장 종료를 확인하지 못했습니다.')
            if self.error:raise RuntimeError(self.error)
