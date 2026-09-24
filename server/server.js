const path = require('path');
const express = require('express');
const request = require('request');
const basicAuth = require('express-basic-auth')
const helmet = require('helmet');
const https = require('https');
const fs = require('fs');
const morgan = require('morgan')

const PORT = process.env.PORT
const SECURE_PORT = process.env.SECURE_PORT
const PROTO_ENDPOINT = process.env.PROTO_ENDPOINT;
const BASIC_USER = process.env.BASIC_USER;
const BASIC_PASS = process.env.BASIC_PASS;
const HTTPS_KEY = process.env.HTTPS_KEY
const HTTPS_KEY_PASS = process.env.HTTPS_KEY_PASS
const HTTPS_CERT = process.env.HTTPS_CERT

const httpsOptions = HTTPS_KEY ? {
  key: fs.readFileSync(HTTPS_KEY, 'utf8'),
  cert: fs.readFileSync(HTTPS_CERT, 'utf8'),
  passphrase: HTTPS_KEY_PASS
} : undefined


const app = express();

app.use(helmet())

app.use(
  helmet.contentSecurityPolicy({
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-eval'"],
      connectSrc: ["http:", "https:"]
    },
  })
)

app.disable('x-powered-by');


if (BASIC_USER) {
  let users = {}
  users[BASIC_USER] = BASIC_PASS
  app.use(basicAuth({
    users: users
  }))
  console.log(`basic authentication enabled`)
}

app.use(morgan('common'))

// Have Node serve the files for our built React app
app.use(express.static(path.resolve(__dirname, '../build')));

// Proxy to the configured node base URL, if defined. Only the read-only endpoints the frontend
// actually uses are forwarded (GET, no query string), so the node's full API is not exposed.
// The frontend can then be pointed at this server's own origin (empty "Beacon node URL").
const PROXIED_PATHS = [
  '/eth/v1/beacon/genesis',
  '/eth/v1/config/spec',
  '/eth/v1/debug/fork_choice',
  '/eth/v2/debug/fork_choice',
]
if (PROTO_ENDPOINT) {
  const beaconBaseUrl = PROTO_ENDPOINT.replace(/\/+$/, '')
  for (const path of PROXIED_PATHS) {
    app.get(path, (req, res) => {
      const upstream = request({ url: beaconBaseUrl + path, headers: { accept: 'application/json' } })
      // an unreachable node must answer the browser, not crash the server (an unhandled 'error' event exits the process)
      upstream.on('error', (err) => {
        if (res.headersSent) return res.end()
        res.status(502).json({ code: 502, message: `beacon node unreachable: ${err.code || err.message}` })
      })
      req.pipe(upstream).pipe(res);
    });
  }
  app.all("/eth/*", (req, res) => {
    res.status(404).json({ code: 404, message: 'not proxied' })
  });
  console.log(`proxying ${PROXIED_PATHS.join(', ')} to ${beaconBaseUrl}`)
}

// tells the frontend whether this server proxies a beacon node, so it can default to its own origin
app.get("/config", (req, res) => {
  res.json({ beaconProxy: !!PROTO_ENDPOINT })
});

// All other GET requests not handled before will return our React app
app.get('*', (req, res) => {
  res.sendFile(path.resolve(__dirname, '../build', 'index.html'));
});

// start server

if (PORT) {
  app.listen(PORT, () => {
    console.log(`protovis backend app listening on port ${PORT}`)
  })
} else {
  console.log(`protovis backend app - no http port opened`)
}

if (httpsOptions && SECURE_PORT) {
  https.createServer(httpsOptions, app).listen(SECURE_PORT, () => {
    console.log(`protovis backend app listening on port ${SECURE_PORT} in HTTPS`)
  });
} else {
  console.log(`protovis backend app - no https port opened`)
}