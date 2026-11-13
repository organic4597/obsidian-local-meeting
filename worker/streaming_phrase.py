"""One bounded contextual ASR phrase. Only final phrases advance the durable cursor."""
class StreamingPhrase:
    def __init__(self,session,start,context):
        self.session=session;self.start=start;self.until=start;self.rewrites=0;self.last_text=''
        self.state=session.init_streaming(context='',language='Korean',chunk_size_sec=1.,max_context_sec=24.,reuse_window_prefix=True)
    def feed(self,pcm,end):
        if end<self.until-1e-5:raise ValueError('Streaming audio cannot move backwards')
        if abs(len(pcm)/16000-(end-self.until))>.002:raise ValueError('Streaming PCM range is incomplete')
        self.session.feed_audio(pcm,self.state);self.until=end
        text=self.state.text.strip()
        if self.last_text and not text.startswith(self.last_text) and len(self.last_text)>5:self.rewrites+=1
        self.last_text=text
        return self.state.text.strip()
    def finish(self):
        self.session.finish_streaming(self.state)
        return self.state.text.strip()

def relabel_recent(revisions,turns,processed,emit,session):
    from live_speakers import speaker_at
    # Keep the newest 5 s provisional; this never holds up ASR or advances its cursor.
    for old in revisions.all():
        if old['start']<(processed-120)*1000 or old['end']>(processed-5)*1000:continue
        if old.get('speakerLocked'):continue
        speaker=speaker_at(turns,old['start'],old['end'])
        value=revisions.put({**old,'speaker':speaker,'speakerState':'overlap' if speaker=='overlap' else 'unknown'})
        if value:emit({'type':'segment','session':session,'segment':value})
