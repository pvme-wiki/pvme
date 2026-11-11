#!/usr/bin/env python3
"""Convert verified recovered reader bodies to editor baselines, in an isolated copy.

No upstream source is implied: all hashes describe the captured reader bytes.
"""
import base64, gzip, hashlib, html.parser, json, re
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
sha=lambda b:hashlib.sha256(b).hexdigest()
VOID=set('br hr img source track col'.split())
class BodyParser(html.parser.HTMLParser):
 def __init__(self, gid):
  super().__init__(convert_charrefs=True); self.gid=gid; self.root=[]; self.stack=[]; self.n=0
 def append(self,node): (self.stack[-1]['children'] if self.stack else self.root).append(node)
 def ident(self):
  self.n+=1; return f'{self.gid}:n:{self.n:06}'
 def handle_starttag(self, tag, attrs):
  if len(dict(attrs)) != len(attrs): raise ValueError('duplicate attribute')
  node={'id':self.ident(),'type':'element','tag':tag,'attrs':{k:v if v is not None else '' for k,v in attrs},'children':[]}
  self.append(node)
  if tag not in VOID: self.stack.append(node)
 def handle_startendtag(self,tag,attrs):
  self.handle_starttag(tag,attrs)
  if tag not in VOID:self.handle_endtag(tag)
 def handle_endtag(self,tag):
  if tag in VOID:return
  if not self.stack or self.stack[-1]['tag']!=tag:raise ValueError('unbalanced '+tag)
  self.stack.pop()
 def handle_data(self,data):
  if data:self.append({'id':self.ident(),'type':'text','text':data})
 def handle_comment(self,data):raise ValueError('comment would be lost')
 def handle_decl(self,decl):raise ValueError('declaration would be lost')
def meaningful(t):return bool(re.sub(r'[\s\u200b\u200c\u200d\u200e\u200f\ufeff]','',t))
def leaves(n):
 if n['type']=='text':return [n['id']] if meaningful(n['text']) else []
 return sum((leaves(x) for x in n['children']),[])
def main():
 raw=json.loads(gzip.decompress((ROOT/'reader/reader-snapshot.json.gz').read_bytes())); files={}
 for f in raw:
  b=base64.b64decode(f['data'],validate=True)
  if f['path'] in files or sha(b)!=f['sha256']:raise ValueError('snapshot integrity: '+f['path'])
  files[f['path']]=b
 slots=json.loads((ROOT/'reader/reader-slots.json').read_text())['pages']
 slots=[s for s in slots if not s['isAlias'] and s['sourcePath'].startswith('/pvme-guides/')]
 if len(slots)!=323 or len({s['sourcePath'] for s in slots})!=323:raise ValueError('unexpected guide inventory')
 catalog_by_path={('/'+c['path']):c for c in json.loads(files['data/catalog.json'])}
 original=json.loads((ROOT/'editor/content/catalog.json').read_text()); old={}
 for c in original:
  d=json.loads((ROOT/'editor/content'/c['file']).read_text());old[d['source']['sourcePath']]=(c,d)
 out=ROOT/'imported'; (out/'content').mkdir(parents=True,exist_ok=True); (out/'sources').mkdir(exist_ok=True)
 catalog=[]; used=set()
 for s in slots:
  page=files[s['pagePath']];o=s['byteOffsets'];body=page[o['bodyStart']:o['attributionStart']]
  if sha(page)!=s['originalPageSha256'] or sha(body)!=s['bodySha256']:raise ValueError('slot integrity: '+s['pagePath'])
  c=catalog_by_path[s['sourcePath']]; gid=(old[s['sourcePath']][0]['id'] if s['sourcePath'] in old else s['guideId'].lower().replace('_','-'))
  if gid in used or not re.fullmatch('[a-z0-9][a-z0-9-]{0,100}',gid):raise ValueError('invalid id '+gid)
  used.add(gid); p=BodyParser(gid);p.feed(body.decode('utf8'));p.close()
  if p.stack:raise ValueError('unclosed tag '+s['sourcePath'])
  blocks=[]
  for i,n in enumerate(p.root):
   if n['type']=='text':
    if not blocks:raise ValueError('leading root text '+s['sourcePath'])
    if 'tail' in blocks[-1]:raise ValueError('consecutive root text '+s['sourcePath'])
    blocks[-1]['tail']=n;continue
   tag=n['tag']; typ='heading' if re.fullmatch('h[1-6]',tag) else 'paragraph' if tag=='p' else 'media' if tag in ('img','video','iframe','picture') else 'preserved'
   editable=leaves(n);blocks.append({'id':f'{gid}:b:{i:06}','type':typ,'editable':bool(editable),'label':tag,'sourcePath':f'root/{i}','node':n,'editableTextNodeIds':editable})
  if not blocks:raise ValueError('empty guide '+s['sourcePath'])
  h=sha(body);doc={'schemaVersion':1,'id':gid,'title':s['title'],'source':{'articleId':s['guideId'],'url':s['source'],'route':s['route'],'sourcePath':s['sourcePath'],'title':s['title'],'retrieved':json.loads((ROOT/'reader/reader-manifest.json').read_text())['retrievedAt'],'attribution':'PvME contributors','license':'CC BY-NC-SA 4.0','licenseUrl':'https://creativecommons.org/licenses/by-nc-sa/4.0/','sourceLicenseUrl':'https://github.com/pvme/pvme-guides/blob/master/LICENSE','contentMode':s['contentMode'],'modifications':'Reader navigation, typography and references were adapted in the recovered preview.','rawSha256':h,'importedHtmlSha256':h,'normalizedSourceHtmlSha256':h,'snapshotFile':f'sources/{gid}.json','importVersion':1,'importNote':'Hashes identify the exact recovered reader body bytes, not upstream raw or normalized content.','stats':{'blocks':len(blocks),'editableBlocks':sum(b['editable'] for b in blocks),'preservedBlocks':sum(not b['editable'] for b in blocks)}},'blocks':blocks}
  if s['sourcePath'] in old: doc=old[s['sourcePath']][1]
  (out/'content'/f'{gid}.json').write_text(json.dumps(doc,ensure_ascii=False,separators=(',',':'))+'\n')
  (out/'sources'/f'{gid}.json').write_text(json.dumps({'pagePath':s['pagePath'],'pageSha256':s['originalPageSha256'],'bodySha256':h,'bodyBase64':base64.b64encode(body).decode()},separators=(',',':'))+'\n')
  catalog.append(old[s['sourcePath']][0] if s['sourcePath'] in old else {'id':gid,'title':s['title'],'category':c.get('category') or 'Guide','file':gid+'.json','summary':'Recovered PvME guide','stats':doc['source']['stats']})
 (out/'content/catalog.json').write_text(json.dumps(catalog,ensure_ascii=False,indent=2)+'\n')
 print(f'Imported {len(catalog)} verified guides to {out}')
if __name__=='__main__':main()
