const http = require('node:http');
const net = require('node:net');

const target = process.env.VERIFY_CONTAINER_IP;
if (!net.isIP(target)) throw new Error('VERIFY_CONTAINER_IP must be the fixture container address');
http
  .createServer((request, response) => {
    const upstream = http.request(
      {
        hostname: target,
        port: 3080,
        method: request.method,
        path: request.url,
        headers: request.headers,
      },
      (result) => {
        response.writeHead(result.statusCode, result.headers);
        result.pipe(response);
      },
    );
    upstream.on('error', (error) => {
      console.error('Fixture proxy failed:', error.code);
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    response.on('close', () => upstream.destroy());
    request.pipe(upstream);
  })
  .listen(3199, '127.0.0.1', () => console.log('Fixture-only loopback proxy ready'));
