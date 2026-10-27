"""Local dictionary storage and conservative, one-pass terminology correction."""
import argparse
import csv
import hashlib
import io
import json
import re
import sqlite3
import sys
import time
import unicodedata
import uuid
from pathlib import Path

POLICIES={'hint','normalize','suggest'}
CATEGORIES={'technical','organization','product','person','abbreviation','other'}
SCOPES={'meeting','project','vault','personal'}

def clean(value,limit=80):
    if not isinstance(value,str):raise ValueError('문자열을 입력해 주세요.')
    value=unicodedata.normalize('NFC',value).strip()
    if not value or len(value)>limit or any(unicodedata.category(c).startswith('C') for c in value):raise ValueError(f'1~{limit}자의 일반 텍스트를 입력해 주세요.')
    if any(x in value for x in ('<|','|>','://','<!--','\n','\r')):raise ValueError('용어에는 명령이나 URL을 넣을 수 없습니다.')
    return value

def validate_term(term):
    if not isinstance(term,dict):raise ValueError('잘못된 사전 항목')
    scope=term.get('scope',{})
    if not isinstance(scope,dict) or scope.get('kind') not in SCOPES:raise ValueError('잘못된 사전 범위')
    kind=scope['kind'];scope_id=clean(scope.get('id','shared'),100)
    policy=term.get('postprocess','hint');category=term.get('category','technical')
    if policy not in POLICIES or category not in CATEGORIES:raise ValueError('잘못된 사전 종류 또는 정책')
    lists={}
    for key in ('pronunciations','observedErrors','contextTags'):
        values=term.get(key,[])
        if not isinstance(values,list) or len(values)>10:raise ValueError('별칭과 오인식은 각각 10개까지 입력할 수 있습니다.')
        lists[key]=list(dict.fromkeys(clean(v) for v in values))
    ident=term.get('id') or str(uuid.uuid4())
    if not isinstance(ident,str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,100}',ident):raise ValueError('잘못된 항목 ID')
    return {'schemaVersion':1,'id':ident,'canonical':clean(term.get('canonical')),
        **lists,'category':category,'scope':{'kind':kind,'id':scope_id},
        'recognitionHint':bool(term.get('recognitionHint',True)),'postprocess':policy,
        'confirmedByUser':bool(term.get('confirmedByUser',False)),'enabled':bool(term.get('enabled',True)),
        'revision':max(1,int(term.get('revision',1))),'updatedAt':int(term.get('updatedAt',time.time()*1000))}

def key(term):return unicodedata.normalize('NFC',term['canonical']).casefold()

def snapshot(terms,project='',meeting='',enabled=True):
    rank={'personal':0,'vault':1,'project':2,'meeting':3};selected={}
    for term in sorted(terms,key=lambda t:rank[t['scope']['kind']]):
        s=term['scope']
        if s['kind']=='project' and s['id']!=project:continue
        if s['kind']=='meeting' and s['id']!=meeting:continue
        selected[key(term)]=term
    active=[t for t in selected.values() if t['enabled']] if enabled else []
    active.sort(key=lambda t:(-rank[t['scope']['kind']],t['canonical'].casefold()))
    payload={'schemaVersion':1,'enabled':enabled,'project':project,'terms':active}
    payload['revision']=hashlib.sha256(json.dumps(payload,sort_keys=True,ensure_ascii=False).encode()).hexdigest()[:20]
    aliases={}
    for t in active:
        for alias in t['pronunciations']+t['observedErrors']:aliases.setdefault(alias.casefold(),set()).add(t['canonical'])
    payload['conflicts']=[{'alias':a,'terms':sorted(v)} for a,v in aliases.items() if len(v)>1]
    return payload

def context_text(snap,encode=None,max_terms=40,max_tokens=256):
    chosen=[];count=0
    for t in snap.get('terms',[]):
        if not t.get('recognitionHint') or count>=max_terms:continue
        piece=' '.join(dict.fromkeys([t['canonical'],*t.get('pronunciations',[])]))
        candidate=' '.join([*chosen,piece])
        # Actual model tokenizer is supplied during inference; conservative fallback for previews.
        size=len(encode(candidate)) if encode else len(candidate.encode('utf-8'))
        if size>max_tokens:continue
        chosen.append(piece);count+=1
    return ' '.join(chosen)

def _pattern(alias):
    # Match whole expressions or a confirmed Korean expression followed by a common particle.
    end=r'(?=$|[^\w]|(?:에서는|에게|에서|으로|은|는|이|가|을|를|와|과|의|에|로|도|만)(?=$|[^\w]))'
    return re.compile(r'(?<!\w)'+re.escape(alias)+end,re.IGNORECASE)

def postprocess(raw,snap):
    matches=[];ambiguous={c['alias'] for c in snap.get('conflicts',[])}
    for term in snap.get('terms',[]):
        if not term.get('confirmedByUser') or term.get('postprocess')=='hint':continue
        for alias in dict.fromkeys(term.get('pronunciations',[])+term.get('observedErrors',[])):
            if alias.casefold() in ambiguous or alias==term['canonical']:continue
            for m in _pattern(alias).finditer(raw):
                # A terminology rule must never silently invent or change a number.
                numeric_safe=re.findall(r'\d+',m[0])==re.findall(r'\d+',term['canonical'])
                protected={'안','못','아니요','아니오','없다','있다','불가','가능'}
                semantic_safe=alias not in protected and term['canonical'] not in protected
                auto=term['postprocess']=='normalize' and alias in term.get('pronunciations',[]) and numeric_safe and semantic_safe
                matches.append((m.start(),m.end(),term,auto))
    matches.sort(key=lambda x:(x[0],-(x[1]-x[0])))
    cursor=0;output='';changes=[]
    for a,b,t,auto in matches:
        if a<cursor:continue
        output+=raw[cursor:a];start=len(output.encode('utf-16-le'))//2;before=raw[a:b];after=t['canonical']
        output+=after if auto else before
        changes.append({'id':f"{t['id']}_{a}_{b}",'termId':t['id'],'start':start,'end':len(output.encode('utf-16-le'))//2,
                        'before':before,'after':after,'state':'applied' if auto else 'suggested'})
        cursor=b
    return output+raw[cursor:],changes

class Dictionary:
    def __init__(self,root,vault):
        if not re.fullmatch(r'[a-zA-Z0-9_-]{1,100}',vault):raise ValueError('잘못된 Vault ID')
        self.root=Path(root).resolve()/'.local-meeting-quality';self.vault=vault
        folder=self.root/vault;folder.mkdir(parents=True,exist_ok=True)
        personal=self.root/'personal';personal.mkdir(exist_ok=True)
        self.db=sqlite3.connect(folder/'dictionaries.sqlite',timeout=10)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('ATTACH DATABASE ? AS personal',(str(personal/'dictionaries.sqlite'),))
        for schema in ('main','personal'):
            self.db.execute(f'CREATE TABLE IF NOT EXISTS {schema}.terms(id TEXT PRIMARY KEY, value TEXT NOT NULL)')
        self.db.execute('CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL)');self.db.commit()
    def terms(self):
        return [json.loads(row[0]) for schema in ('main','personal') for row in self.db.execute(f'SELECT value FROM {schema}.terms ORDER BY id')]
    def upsert(self,value):
        t=validate_term(value);schema='personal' if t['scope']['kind']=='personal' else 'main'
        if any(x['id']!=t['id'] and key(x)==key(t) and x['scope']==t['scope'] for x in self.terms()):raise ValueError('같은 범위에 이미 있는 용어입니다. 기존 항목을 수정해 주세요.')
        existing=self.db.execute(f'SELECT value FROM {schema}.terms WHERE id=?',(t['id'],)).fetchone()
        other='main' if schema=='personal' else 'personal'
        if not existing:existing=self.db.execute(f'SELECT value FROM {other}.terms WHERE id=?',(t['id'],)).fetchone()
        if existing:
            old=json.loads(existing[0])
            if int(value.get('revision',0))!=old['revision']:raise ValueError('다른 변경이 저장되었습니다. 목록을 새로 열어 주세요.')
            t['revision']=old['revision']+1
        else:t['revision']=1
        t['updatedAt']=int(time.time()*1000)
        # Scope moves are a delete/add transaction, keeping a single stable ID.
        self.db.execute(f'DELETE FROM {other}.terms WHERE id=?',(t['id'],))
        self.db.execute(f'INSERT OR REPLACE INTO {schema}.terms VALUES(?,?)',(t['id'],json.dumps(t,ensure_ascii=False)))
        return t
    def request(self,request):
        kind=request.get('type')
        if kind=='save':
            with self.db:self.upsert(request['term'])
        elif kind=='delete':
            ident=clean(request['id'],100)
            with self.db:
                for schema in ('main','personal'):self.db.execute(f'DELETE FROM {schema}.terms WHERE id=?',(ident,))
        elif kind=='project':
            ident=str(uuid.uuid4());name=clean(request['name'])
            with self.db:self.db.execute('INSERT INTO projects VALUES(?,?)',(ident,name))
        elif kind in ('import_preview','import_commit'):
            data=request['data']
            if not isinstance(data,dict) or data.get('schemaVersion')!=1 or not isinstance(data.get('terms'),list) or len(data['terms'])>5000:raise ValueError('지원하는 사전 JSON이 아닙니다.')
            # Imported data is always scoped to this Vault and never overwrites an existing term.
            terms=[validate_term({**t,'id':str(uuid.uuid4()),'scope':{'kind':'vault','id':self.vault}}) for t in data['terms']]
            known={key(t) for t in self.terms()};accepted=[];skipped=[]
            for t in terms:
                if key(t) in known:skipped.append(t['canonical'])
                else:accepted.append(t);known.add(key(t))
            if kind=='import_commit':
                with self.db:
                    for t in accepted:self.upsert(t)
            return {'accepted':len(accepted),'skipped':skipped,'preview':accepted}
        elif kind not in ('list','snapshot','export'):raise ValueError('지원하지 않는 사전 명령')
        terms=self.terms();snap=snapshot(terms,request.get('project',''),request.get('meeting',''),request.get('enabled',True))
        return {'terms':terms,'projects':[{'id':r[0],'name':r[1]} for r in self.db.execute('SELECT id,name FROM projects ORDER BY name')],'snapshot':snap}
    def close(self):self.db.close()

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--root',required=True);p.add_argument('--vault',required=True);args=p.parse_args()
    try:
        payload=sys.stdin.read(2_000_001)
        if len(payload)>2_000_000:raise ValueError('사전 파일은 2MB 이하만 지원합니다.')
        db=Dictionary(args.root,args.vault)
        try:print(json.dumps(db.request(json.loads(payload)),ensure_ascii=False))
        finally:db.close()
    except Exception as exc:print(str(exc),file=sys.stderr);sys.exit(1)
