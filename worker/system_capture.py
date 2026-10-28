"""Capture a Core Audio tap plus microphone into the existing durable WAV queue."""
import os, subprocess, threading
from pathlib import Path
from capture import Capture

class SystemCapture(Capture):
    def __init__(self, root, emit, helper, app_pid=None, device=None, rate=16000, seconds=8):
        super().__init__(root,emit,device=device,rate=rate,seconds=seconds)
        if device is not None: raise RuntimeError('시스템 오디오 사용 시 기본 마이크를 선택해 주세요.')
        if rate != 16000: raise ValueError('16kHz 출력이 필요합니다.')
        if app_pid is not None and (not isinstance(app_pid,int) or isinstance(app_pid,bool) or app_pid<=0):raise ValueError('선택한 앱의 프로세스를 확인해 주세요.')
        self.helper=str(Path(helper).resolve());self.app_pid=app_pid;self.proc=None;self.reader=None;self.stderr_thread=None
        self.ready=threading.Event();self.stderr=[];self.ending=False
    def start(self):
        # Load filtering libraries before the real-time callback begins; importing
        # them concurrently with the ASR model can otherwise exhaust the audio buffer.
        import numpy as np
        from scipy.signal import butter,sosfilt
        self.np=np;self.sosfilt=sosfilt;self.sos=butter(8,7200,fs=48000,output='sos')
        if (self.root/'recording.wav').exists() or list(self.root.glob('audio-*.wav')) or list(self.root.glob('queue/audio-*.pcm')):
            raise RuntimeError('기존 세션에는 추가 녹음할 수 없습니다. 새 회의를 시작하세요.')
        from recording import ContinuousWav
        self.recording=ContinuousWav(self.root/'recording.wav',self.rate)
        try:
            args=[self.helper,'--pid',str(self.app_pid)] if self.app_pid is not None else [self.helper,'--global']
            self.proc=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,bufsize=0)
            self.stderr_thread=threading.Thread(target=self._stderr,daemon=True);self.stderr_thread.start()
            self.thread=threading.Thread(target=self.write_loop,daemon=True);self.thread.start()
            self.reader=threading.Thread(target=self._read,daemon=True);self.reader.start()
            if not self.ready.wait(15): raise RuntimeError('시스템 오디오 시작 시간이 초과됐습니다. 권한과 오디오 장치를 확인하세요.')
            if self.error or self.proc.poll() is not None:
                self._finish_process()
                raise RuntimeError(self.error or '시스템 오디오 캡처를 시작하지 못했습니다.')
            self.diagnostics['device']='기본 마이크 + '+('선택한 앱 오디오' if self.app_pid else '전체 시스템 오디오')
        except BaseException:
            self._finish_process();self.stop_event.set()
            if self.thread:self.thread.join(timeout=15)
            elif self.recording:self.recording.close();self.recording=None
            raise
    def _stderr(self):
        for raw in self.proc.stderr:
            line=raw.decode('utf-8','replace').strip()
            if line=='READY 48000 2': self.ready.set()
            elif line:self.stderr.append(line)
        self.ready.set()
    def _read(self):
        try:
            np=self.np;sos=self.sos;sosfilt=self.sosfilt;zi=np.zeros((sos.shape[0],2));received=0;pending=b''
            while True:
                data=self.proc.stdout.read(38400)
                if not data:break
                pending+=data
                count=len(pending)//8*8
                if not count:continue
                frames=np.frombuffer(pending[:count],dtype='<f4').reshape(-1,2);pending=pending[count:]
                if not np.isfinite(frames).all():raise RuntimeError('시스템 오디오에 잘못된 샘플이 있습니다.')
                mix=np.clip((frames[:,0]+frames[:,1])*0.5,-1,1)
                filtered,zi=sosfilt(sos,mix,zi=zi)
                pcm=(np.clip(filtered[(-received)%3::3],-1,1)*32767).astype('<i2').tobytes();received+=len(frames)
                if pcm:self.callback(pcm,len(pcm)//2,None,None)
            if pending:raise RuntimeError('시스템 오디오 데이터가 중간에 끊겼습니다.')
            if not self.ending:raise RuntimeError('시스템 오디오 입력이 예기치 않게 중단됐습니다.')
        except BaseException as exc:
            self.error=self.error or str(exc) or '시스템 오디오 입력을 처리하지 못했습니다.';self.stop_event.set()
    def _finish_process(self):
        proc=self.proc
        if not proc:return
        self.ending=True
        try:
            if proc.stdin:proc.stdin.write(b'stop\n');proc.stdin.flush()
        except (BrokenPipeError,OSError):pass
        finally:
            if proc.stdin:proc.stdin.close()
        try:proc.wait(timeout=10)
        except subprocess.TimeoutExpired:proc.kill();proc.wait();self.error=self.error or '시스템 오디오 종료 시간이 초과됐습니다.'
        if self.reader:self.reader.join(timeout=5)
        if self.reader and self.reader.is_alive():self.error=self.error or '시스템 오디오 입력 종료를 확인하지 못했습니다.'
        if self.stderr_thread:self.stderr_thread.join(timeout=2)
        if proc.returncode:
            detail=' '.join(self.stderr)[-500:]
            self.error=(self.error or '시스템 오디오 캡처 실패')+(': '+detail if detail else ' (종료 코드 '+str(proc.returncode)+')')
        if proc.stdout:proc.stdout.close()
        if proc.stderr:proc.stderr.close()
        self.proc=None
    def stop(self):
        with self.stop_lock:
            self._finish_process();self.stop_event.set()
            if self.thread:self.thread.join(timeout=15)
            if self.thread and not self.finished.is_set():raise RuntimeError('오디오 저장 종료를 확인하지 못했습니다.')
            if self.error:raise RuntimeError(self.error)
