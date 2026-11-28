import gzip, pathlib, re, sys
P=pathlib.Path
if sys.argv[1]=='body':
 P('proposal.body.html').write_text('<style>\n'+P('interface.css').read_text()+'\n</style>\n<div id="root"></div>\n<script type="text/jsx">\n'+'\n'.join(P(p+'.jsx').read_text() for p in ['model','panels','projects','notes','app'])+'\n</script>\n')
else:
 s=P('compiled-preview.html').read_text()
 for ext in ('css','js'):
  u='https://static.devin.ai/artifact-kit/cc8965d841fb2ec5/ds-kit.'+ext
  assert u in s
  data=gzip.open('/tmp/zeros-kit.'+ext,'rt').read()
  if ext=='js': s=s.replace('<script src="'+u+'" onerror="artifactKitFailed()"></script>','<script>'+re.sub(r'</script',lambda m:'<\\/script',data,flags=re.I)+'</script>')
  else:s=s.replace('<link rel="stylesheet" href="'+u+'" onerror="artifactKitFailed()" />','<style>'+data+'</style>')
 s=s.replace('<title>Artifact</title>','<title>GitHub connections · Zeros</title>')
 P(sys.argv[2]).write_text(s)
