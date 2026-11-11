import html.parser
VOID=set('br hr img source track col'.split())
class Parser(html.parser.HTMLParser):
 def __init__(self):super().__init__(convert_charrefs=True);self.root=[];self.stack=[]
 def add(self,n): (self.stack[-1][2] if self.stack else self.root).append(n)
 def handle_starttag(self,t,a):
  n=[t,dict(a),[]];self.add(n)
  if t not in VOID:self.stack.append(n)
 def handle_startendtag(self,t,a):
  self.handle_starttag(t,a)
  if t not in VOID:self.handle_endtag(t)
 def handle_endtag(self,t):
  if t not in VOID:
   assert self.stack and self.stack[-1][0]==t
   self.stack.pop()
 def handle_data(self,d):
  target=self.stack[-1][2] if self.stack else self.root
  if target and isinstance(target[-1],str):target[-1]+=d
  else:target.append(d)
def parse(body):
 p=Parser();p.feed(body);p.close();assert not p.stack;return p.root
