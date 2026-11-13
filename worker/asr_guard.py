"""Conservative ASR output guards. Never modifies audio or existing user edits."""
import re,unicodedata
import numpy as np

def audible(pcm):
    pcm=np.asarray(pcm,dtype=np.float32)
    if not len(pcm):return False
    # Only skip near-silent inputs; this is not a neural speech detector.
    width=320;n=len(pcm)//width
    if not n:return False
    rms=np.sqrt(np.mean(pcm[:n*width].reshape(n,width)**2,axis=1))
    return bool(np.count_nonzero(rms>=10**(-50/20))>=6)

def hint_echo(text,dictionary):
    normalize=lambda value:re.sub(r'[\W_]+','',unicodedata.normalize('NFC',value).casefold())
    remaining=normalize(text);matched=[]
    if not remaining:return False
    terms={normalize(t.get('canonical','')) for t in dictionary.get('terms',[]) if t.get('recognitionHint')}
    terms=sorted((t for t in terms if t),key=len,reverse=True)
    while remaining:
        match=next((term for term in terms if remaining.startswith(term)),None)
        if not match:return False
        remaining=remaining[len(match):];matched.append(match)
    return len(set(matched))>=max(6,int(np.ceil(len(terms)*.8)))
