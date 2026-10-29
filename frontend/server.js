// 天机AI助手 - 零依赖静态服务器
const http = require('http');
const fs = require('fs');
const path = require('path');

// 端口：默认 5173，可通过命令行参数或环境变量指定，例如 node server.js 8080
const PORT = Number(process.argv[2] || process.env.PORT || 5173);
const ROOT = __dirname;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

http.createServer((req, res) => {
  let file = decodeURIComponent((req.url || '/').split('?')[0]);
  if (file === '/') file = '/index.html';
  const full = path.join(ROOT, file);
  if (!full.startsWith(ROOT)) {
    res.writeHead(403); return res.end('403 Forbidden');
  }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('404 Not Found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log('==============================================');
  console.log('  天机AI助手 前端已启动');
  console.log('  浏览器打开: http://localhost:' + PORT);
  console.log('  请使用你自己配置的测试账号');
  console.log('  网关地址: http://localhost:10010');
  console.log('  按 Ctrl+C 停止');
  console.log('==============================================');
});
