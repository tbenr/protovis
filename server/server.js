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

// route API if endpoint is defined
if (PROTO_ENDPOINT) {
  app.get("/data", (req, res) => {
    req.pipe(request(PROTO_ENDPOINT)).pipe(res);
  });
  console.log(`redirecting /data to ${PROTO_ENDPOINT}`)
}

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