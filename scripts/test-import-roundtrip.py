import base64,collections,hashlib,html.parser,json,subprocess,sys
from pathlib import Path
root=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(root/'scripts'))
from import_reader_test_helper import parse
catalog=json.loads((root/'editor/content/catalog.json').read_text())
result=json.loads(subprocess.check_output(['node','scripts/test-import.mjs','--render'],cwd=root))
for gid,html in result:
 source=json.loads((root/'imported/sources'/f'{gid}.json').read_text()); raw=base64.b64decode(source['bodyBase64']); assert hashlib.sha256(raw).hexdigest()==source['bodySha256']
 if parse(raw.decode()) != parse(html): raise AssertionError('semantic roundtrip '+gid)
print(f'{len(result)} guides passed parsed HTML structure, text and attribute comparisons')
