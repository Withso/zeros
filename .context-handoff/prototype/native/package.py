from pathlib import Path as P
import re,sys
html=P('dist/index.html').read_text()
def script(m):
 js=P('dist',m[1]).read_text()
 return '<script type="module">'+re.sub('</script',lambda m:'<\\/script',js,flags=re.I)+'</script>'
html=re.sub(r'<script[^>]*src="([^"]+)"[^>]*></script>',script,html)
html=re.sub(r'<link[^>]*href="([^"]+\.css)"[^>]*>',lambda m:'<style>'+P('dist',m[1]).read_text()+'</style>',html)
P(sys.argv[1]).write_text(html)
