import fs from 'node:fs';
fs.rmSync('dist', { recursive: true, force: true });
fs.cpSync('src', 'dist', { recursive: true });
fs.copyFileSync('node_modules/lamejs/lame.min.js', 'dist/lame.min.js');
fs.copyFileSync('node_modules/lamejs/LICENSE', 'dist/LICENSE-lamejs.txt');
console.log('built dist/');
