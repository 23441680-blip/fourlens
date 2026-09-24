import fs from 'node:fs'; import path from 'node:path';
const root=process.cwd(); const out=path.join(root,'public');
fs.rmSync(out,{recursive:true,force:true}); fs.mkdirSync(out,{recursive:true});
const ex=new Set(['.git','node_modules','public']);
for(const e of fs.readdirSync(root)){ if(ex.has(e)) continue; const s=path.join(root,e),d=path.join(out,e); if(fs.statSync(s).isDirectory()) fs.cpSync(s,d,{recursive:true}); else fs.copyFileSync(s,d); }
console.log('copied site -> public/');
