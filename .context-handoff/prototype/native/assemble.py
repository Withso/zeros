from pathlib import Path as P
names=['imports.txt','model.jsx','integrations.jsx','panels.jsx','projects.jsx','notes.jsx','app.jsx']
P('main.jsx').write_text('\n'.join(P(p).read_text() for p in names))
