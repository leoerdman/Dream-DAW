const http = require('http');
const fs = require('fs');
const server = http.createServer((req, res) => {
  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      console.log('--- ERROR RECEIVED ---');
      console.log(body);
      fs.appendFileSync('dream_daw_errors.log', body + '\n');
      res.end('ok');
    });
  } else {
    res.end('ready');
  }
});
server.listen(4848, () => console.log('Error catching server on 4848'));
